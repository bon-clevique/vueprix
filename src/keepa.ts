import axios from 'axios';
import { KEEPA_DOMAIN, HISTORY_DAYS } from './config.js';
import { logger } from './logger.js';

const KEEPA_BASE = 'https://api.keepa.com';

export interface Deal {
  asin: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
}

export interface PriceHistory {
  asin: string;
  currentPrice: number;
  minPrice90d: number;
  dropPercent: number;
}

interface KeepaDealsResponse {
  tokensLeft?: number;
  deals?: {
    dr?: Array<{
      asin: string;
      current?: number[];
      avg?: number[];
      delta?: number[];
      deltaPercent?: number[];
    }>;
  };
}

interface KeepaProductResponse {
  tokensLeft?: number;
  products?: Array<{
    asin: string;
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

const centsToYen = (cents: number | undefined): number => {
  if (typeof cents !== 'number' || cents < 0) return 0;
  return Math.round(cents / 100);
};

export const getDeals = async (categoryId: number): Promise<Deal[]> => {
  const url = `${KEEPA_BASE}/deals`;
  const selection = JSON.stringify({
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
  });
  const res = await axios.get<KeepaDealsResponse>(url, {
    params: { key: apiKey(), domain: KEEPA_DOMAIN, selection },
    timeout: 30_000,
  });
  logger.info('keepa', 'deals fetched', {
    categoryId,
    tokensLeft: res.data.tokensLeft ?? null,
    count: res.data.deals?.dr?.length ?? 0,
  });
  const items = res.data.deals?.dr ?? [];
  return items
    .map((d): Deal | null => {
      const current = centsToYen(d.current?.[0]);
      const avg = centsToYen(d.avg?.[0]);
      const dropPercent = d.deltaPercent?.[0] ?? 0;
      if (!current || !avg) return null;
      return { asin: d.asin, currentPrice: current, referencePrice: avg, dropPercent };
    })
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
  const current = centsToYen(product.stats.current?.[0]);
  const minEntry = product.stats.min?.[0];
  const min90 = minEntry ? centsToYen(minEntry[1]) : 0;
  if (!current || !min90) return null;
  // 「過去90日最安値を更に下回るほどの大下落」を表す。current >= min90 の通常時は 0 以下となり、
  // 後続 isGoodDeal(current, min90) で投稿対象から除外される。
  const dropPercent = Math.max(0, Math.round(((min90 - current) / min90) * 100));
  return { asin, currentPrice: current, minPrice90d: min90, dropPercent };
};
