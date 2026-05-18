import axios from 'axios';
import { KEEPA_DEAL_SORT_TYPE, KEEPA_DOMAIN, HISTORY_DAYS } from './config.js';
import { calcDropPercent } from './filter.js';
import { logger } from './logger.js';

export const KEEPA_BASE = 'https://api.keepa.com';

// Keepa /query endpoint response shape (asinsOnly=true で string[] を返す)。
// pipelines/brand / verify-keepa-brand 等の caller が共通利用するため keepa.ts に集約。
export interface KeepaQueryResponse {
  asinList?: string[];
  asins?: string[];
  totalCount?: number;
  productCount?: number;
  tokensLeft?: number;
}

export interface Deal {
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  // /deal endpoint は avg[priceType][dateRange] を返すのみ。本 bot は week-avg (avg[0][1])
  // を referencePrice にしているため固定値だが、上流 (Notion 投稿文 / 判定) で
  // checkAsin (PriceHistory) 由来 candidate と統一的に扱うため明示的に持たせる。
  referenceSource: 'week-avg';
}

// reference price の出所。Keepa-only chain:
//   1. list-price = avg[4] (Keepa List Price = 定価)
//   2. amazon-avg = avg[0] (Amazon new price 90 日平均)
//   3. new-avg   = avg[1] (3rd party New 90 日平均)
//   4. min-90d   = min[0][1] (90日最安値 timestamp/price pair の price)
// 上位候補から順に評価し、`> current` (= 値下げになっている) の最初の候補を採用する。
// `stats.avg` (90日平均) は flat array で priceType index ごとに 1 値:
//   0 = Amazon, 1 = New (3rd party), 4 = List Price (定価), ...
export type ReferenceSource =
  | 'list-price'
  | 'amazon-avg'
  | 'new-avg'
  | 'min-90d'
  | 'week-avg';

export interface PriceHistory {
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  referenceSource: ReferenceSource;
  dropPercent: number;
}

export interface KeepaDealsItem {
  asin: string;
  title?: string;
  // current[priceTypeIdx]: index 0 = Amazon new price, 1 = New (3rd party), 2 = Used, ...
  current?: number[];
  // avg[priceTypeIdx][dateRangeIdx]: dateRange 0 = day, 1 = week, 2 = month, 3 = 90 day
  avg?: number[][];
  delta?: number[][];
  deltaPercent?: number[][];
}

interface KeepaDealsResponse {
  tokensLeft?: number;
  deals?: {
    dr?: KeepaDealsItem[];
  };
}

interface KeepaProductResponse {
  tokensLeft?: number;
  products?: Array<{
    asin: string;
    title?: string;
    stats?: {
      current?: number[];
      // 各 priceType の「過去 N 日最安値」を [timestamp, price] で持つ (一部が null)。
      min?: Array<[number, number] | null>;
      // 各 priceType の「過去 N 日平均」を 1 値で持つ (Deals API の 2 次元配列とは別形式)。
      avg?: number[];
    };
    csv?: number[][];
  }>;
}

const apiKey = (): string => {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error('KEEPA_API_KEY is not set');
  return key;
};

// Amazon.co.jp (Keepa domain=5) は価格を整数円で返す。-1 / -2 は「データなし」の sentinel。
// 他 domain (US/UK 等) は cents 単位だが、本 bot は domain=5 専用のため変換は不要。
export const toYen = (raw: number | undefined): number => {
  if (typeof raw !== 'number' || raw < 0) return 0;
  return raw;
};

// avg は priceType ごとの 4 値配列 ([day, week, month, 90day])。
// referencePrice には week 平均 (index 1) を採用 — day だと一時的な変動を拾い、month/90day は古すぎるため。
const AVG_DATERANGE_INDEX = 1;

export const parseDeal = (d: KeepaDealsItem): Deal | null => {
  const current = toYen(d.current?.[0]);
  const avg = toYen(d.avg?.[0]?.[AVG_DATERANGE_INDEX]);
  const dropPercent = d.deltaPercent?.[0]?.[AVG_DATERANGE_INDEX] ?? 0;
  const title = typeof d.title === 'string' && d.title.length > 0 ? d.title : '';
  // ¥0 は invalid 扱い (Amazon.co.jp で ¥0 商品は事実上存在せず、sentinel と区別する必要がない)
  // title 空も invalid (投稿テキストを組み立てられないため)
  if (!current || !avg || !title) {
    logger.debug('keepa', 'parseDeal dropped', { asin: d.asin, hasCurrent: !!current, hasAvg: !!avg, hasTitle: !!title });
    return null;
  }
  return {
    asin: d.asin,
    title,
    currentPrice: current,
    referencePrice: avg,
    dropPercent,
    referenceSource: 'week-avg',
  };
};

// 戻り値に tokensLeft を含める理由: draft.ts → run-log.ts で run 終了時の Keepa 残トークンを
// Notion run-log DB に記録するため。category 別 log line には既に tokensLeft が出ているが、
// caller 側に値を渡すには戻り値経由の方が確実 (logger 側を parse するのは脆い)。
export interface GetDealsResult {
  deals: Deal[];
  tokensLeft: number | null;
}

// /deal endpoint 1 ページあたり Keepa は 150 件返す。
// Phase 3 (logical-forging-lerdorf) で getDeals の内部ページループを撤去し、caller (pipelines/deals.ts)
// が adaptive に page を制御する設計に変更。本定数は caller 側 loop の最大ページ数 (上限) を意味する。
// 1 token / call なので tokens 消費が増えるが、Pro プラン (1,440/day) に対しては十分余裕がある。
export const KEEPA_DEAL_PAGE_MAX = 3;

// deltaRange の絶対値下げ額。下限 1,500 円は誇大広告 (¥10→¥9 等) 排除のため維持。
// 上限は旧 ¥100,000 だと高単価商品 (家電/モニター/コーヒー器具) を取りこぼすので、実質上限なしに緩和。
const DELTA_RANGE_MIN_YEN = 1500;
const DELTA_RANGE_MAX_YEN = 100_000_000;

// Phase 3: 単一 page 取得に変更 (旧: 内部で 0..KEEPA_DEAL_PAGES-1 を巡回するループ)。
// caller (pipelines/deals.collectDeals) が KeepaTokenGuard で token 残量を見ながら adaptive に
// page を進める制御を持つため、本 fn は 1 call = 1 page の単純な責務に絞る。
export const getDeals = async (
  categoryId: number,
  page: number,
  sortType: number = KEEPA_DEAL_SORT_TYPE,
): Promise<GetDealsResult> => {
  // Keepa Browsing Deals API: POST /deal with DealRequest JSON body.
  // Reference: keepacom/api_backend Request.java#getDealsRequest
  const url = `${KEEPA_BASE}/deal`;
  const dealRequest = {
    page,
    domainId: KEEPA_DOMAIN,
    excludeCategories: [],
    includeCategories: [categoryId],
    priceTypes: [0],
    deltaRange: [DELTA_RANGE_MIN_YEN, DELTA_RANGE_MAX_YEN],
    deltaPercentRange: [15, 100],
    isFilterEnabled: true,
    sortType,
    dateRange: 0,
  };
  const res = await axios.post<KeepaDealsResponse>(url, dealRequest, {
    params: { key: apiKey() },
    timeout: 30_000,
  });
  const items = res.data.deals?.dr ?? [];
  const tokensLeft = res.data.tokensLeft ?? null;
  logger.info('keepa', 'deals fetched', {
    categoryId,
    page,
    tokensLeft,
    count: items.length,
  });
  const deals = items.map(parseDeal).filter((d): d is Deal => d !== null);
  return { deals, tokensLeft };
};

// reference price を Keepa stats から選ぶ。
// chain: List Price (avg[4]) → Amazon (avg[0]) → New (avg[1]) → 90日最安値 (min[0][1])。
// 「下げ」になっていない候補 (price <= current) は skip して次へ。
// 戻り値 null = どの候補も current より高くない (= 値下げと言えない) ことを意味する。
export const pickReferencePrice = (
  stats: NonNullable<NonNullable<KeepaProductResponse['products']>[number]['stats']>,
  current: number,
): { price: number; source: ReferenceSource } | null => {
  const candidates: Array<{ source: ReferenceSource; raw: number | undefined }> = [
    { source: 'list-price', raw: stats.avg?.[4] },
    { source: 'amazon-avg', raw: stats.avg?.[0] },
    { source: 'new-avg',    raw: stats.avg?.[1] },
    { source: 'min-90d',    raw: stats.min?.[0]?.[1] },
  ];
  for (const c of candidates) {
    const price = toYen(c.raw);
    if (price > current) return { price, source: c.source };
  }
  return null;
};

// tokensLeft を呼出側に返す版。pipelines/brand.ts が KeepaTokenGuard.updateTokensLeft に渡すため
// に追加 (Phase 2)。既存 checkAsin は本 fn の thin wrapper にして history のみ取り出す。
// tokensLeft は Keepa response の optional field なので null 許容。
export const checkAsinWithTokens = async (
  asin: string,
): Promise<{ history: PriceHistory | null; tokensLeft: number | null }> => {
  const url = `${KEEPA_BASE}/product`;
  const res = await axios.get<KeepaProductResponse>(url, {
    params: { key: apiKey(), domain: KEEPA_DOMAIN, asin, stats: HISTORY_DAYS },
    timeout: 30_000,
  });
  const tokensLeft = res.data.tokensLeft ?? null;
  logger.info('keepa', 'product fetched', {
    asin,
    tokensLeft,
  });
  const product = res.data.products?.[0];
  if (!product?.stats) return { history: null, tokensLeft };
  // Amazon 出品なし商品 (current[0]=-1) でも New (current[1]) で投稿できるよう fallback する。
  const current = toYen(product.stats.current?.[0]) || toYen(product.stats.current?.[1]);
  if (!current) return { history: null, tokensLeft };
  const picked = pickReferencePrice(product.stats, current);
  if (!picked) {
    logger.debug('keepa', 'no reference price above current', { asin, current });
    return { history: null, tokensLeft };
  }
  const title = typeof product.title === 'string' && product.title.length > 0 ? product.title : '';
  if (!title) {
    logger.debug('keepa', 'checkAsin dropped (no title)', { asin });
    return { history: null, tokensLeft };
  }
  // calcDropPercent(current, reference) シグネチャに整列。引数順は (current, picked.price)。
  // picked.price > current は pickReferencePrice の post-condition で保証されるが、Math.max(0, ...) は
  // 丸め誤差や invariant 違反時の防御として保持 (二重防御)。
  const dropPercent = Math.max(0, calcDropPercent(current, picked.price));
  return {
    history: {
      asin,
      title,
      currentPrice: current,
      referencePrice: picked.price,
      referenceSource: picked.source,
      dropPercent,
    },
    tokensLeft,
  };
};

export const checkAsin = async (asin: string): Promise<PriceHistory | null> => {
  const { history } = await checkAsinWithTokens(asin);
  return history;
};
