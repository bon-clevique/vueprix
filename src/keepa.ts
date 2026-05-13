import axios from 'axios';
import { KEEPA_DEAL_SORT_TYPE, KEEPA_DOMAIN, HISTORY_DAYS } from './config.js';
import { logger } from './logger.js';

const KEEPA_BASE = 'https://api.keepa.com';

export interface Deal {
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
}

// reference price の出所。`stats.avg` (90日平均) は flat array で priceType index ごとに 1 値:
//   0 = Amazon, 1 = New (3rd party), 4 = List Price (定価), ...
// Amazon UI の割引率表示は通常 List Price ベースなので、avg[4] を最優先にして Amazon UI と一貫させる。
// List Price 未設定の商品は Amazon / New の 90日平均、それも無ければ 90日最安値に段階退避する。
export type ReferenceSource = 'list-price' | 'amazon-avg' | 'new-avg' | 'min-90d';

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
  return { asin: d.asin, title, currentPrice: current, referencePrice: avg, dropPercent };
};

// 戻り値に tokensLeft を含める理由: draft.ts → run-log.ts で run 終了時の Keepa 残トークンを
// Notion run-log DB に記録するため。category 別 log line には既に tokensLeft が出ているが、
// caller 側に値を渡すには戻り値経由の方が確実 (logger 側を parse するのは脆い)。
export interface GetDealsResult {
  deals: Deal[];
  tokensLeft: number | null;
}

export const getDeals = async (
  categoryId: number,
  sortType: number = KEEPA_DEAL_SORT_TYPE,
): Promise<GetDealsResult> => {
  // Keepa Browsing Deals API: POST /deal with DealRequest JSON body.
  // Reference: keepacom/api_backend Request.java#getDealsRequest
  // (r.path = "deal", r.postData = gson.toJson(dealRequest))
  const url = `${KEEPA_BASE}/deal`;
  const dealRequest = {
    page: 0,
    domainId: KEEPA_DOMAIN,
    excludeCategories: [],
    includeCategories: [categoryId],
    priceTypes: [0],
    deltaRange: [1500, 100000],
    deltaPercentRange: [15, 100],
    isFilterEnabled: true,
    sortType,
    dateRange: 0,
  };
  const res = await axios.post<KeepaDealsResponse>(url, dealRequest, {
    params: { key: apiKey() },
    timeout: 30_000,
  });
  logger.info('keepa', 'deals fetched', {
    categoryId,
    tokensLeft: res.data.tokensLeft ?? null,
    count: res.data.deals?.dr?.length ?? 0,
  });
  const items = res.data.deals?.dr ?? [];
  const deals = items
    .map(parseDeal)
    .filter((d): d is Deal => d !== null);
  return { deals, tokensLeft: res.data.tokensLeft ?? null };
};

// stats.avg / stats.min から reference price を選ぶ。Amazon UI の割引表示と一貫させるため
// List Price (avg[4]) を最優先にし、無ければ Amazon (avg[0]) → New (avg[1]) → 90日最安値の順に退避する。
// 「下げ」になっていない候補 (price <= current) は skip して次へ — 値上がり中の avg を reference にすると
// dropPercent <= 0 となり投稿候補から外れる挙動と整合させる。
//
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

export const checkAsin = async (asin: string): Promise<PriceHistory | null> => {
  const url = `${KEEPA_BASE}/product`;
  const res = await axios.get<KeepaProductResponse>(url, {
    params: { key: apiKey(), domain: KEEPA_DOMAIN, asin, stats: HISTORY_DAYS },
    timeout: 30_000,
  });
  logger.info('keepa', 'product fetched', {
    asin,
    tokensLeft: res.data.tokensLeft ?? null,
  });
  const product = res.data.products?.[0];
  if (!product?.stats) return null;
  // Amazon 出品なし商品 (current[0]=-1) でも New (current[1]) で投稿できるよう fallback する。
  const current = toYen(product.stats.current?.[0]) || toYen(product.stats.current?.[1]);
  if (!current) return null;
  const picked = pickReferencePrice(product.stats, current);
  if (!picked) {
    logger.debug('keepa', 'no reference price above current', { asin, current });
    return null;
  }
  const title = typeof product.title === 'string' && product.title.length > 0 ? product.title : '';
  if (!title) {
    logger.debug('keepa', 'checkAsin dropped (no title)', { asin });
    return null;
  }
  const dropPercent = Math.max(0, Math.round(((picked.price - current) / picked.price) * 100));
  return {
    asin,
    title,
    currentPrice: current,
    referencePrice: picked.price,
    referenceSource: picked.source,
    dropPercent,
  };
};
