import axios from 'axios';
import { KEEPA_DOMAIN, HISTORY_DAYS } from './config.js';
import { logger } from './logger.js';

const KEEPA_BASE = 'https://api.keepa.com';

export interface Deal {
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
}

export interface PriceHistory {
  asin: string;
  title: string;
  currentPrice: number;
  minPrice90d: number;
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
      min?: Array<[number, number]>;
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

export const getDeals = async (categoryId: number): Promise<Deal[]> => {
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
    sortType: 4,
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
  return items
    .map(parseDeal)
    .filter((d): d is Deal => d !== null);
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
  const current = toYen(product.stats.current?.[0]);
  const minEntry = product.stats.min?.[0];
  const min90 = minEntry ? toYen(minEntry[1]) : 0;
  if (!current || !min90) return null;
  const title = typeof product.title === 'string' && product.title.length > 0 ? product.title : '';
  if (!title) {
    logger.debug('keepa', 'checkAsin dropped (no title)', { asin });
    return null;
  }
  // 「過去90日最安値を更に下回るほどの大下落」を表す。current >= min90 の通常時は 0 以下となり、
  // 後続 isGoodDeal(current, min90) で投稿対象から除外される。
  const dropPercent = Math.max(0, Math.round(((min90 - current) / min90) * 100));
  return { asin, title, currentPrice: current, minPrice90d: min90, dropPercent };
};
