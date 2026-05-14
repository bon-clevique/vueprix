import axios from 'axios';
import {
  BRAND_CATEGORY_MAP,
  BRAND_DEFAULT_CATEGORY,
  BRAND_PAGE_SIZE,
  BRAND_QUOTA,
  DROP_THRESHOLD_PERCENT,
  KEEPA_DOMAIN,
  MIN_PRICE_YEN,
  WATCH_BRANDS,
} from './config.js';
import { checkAsin, KEEPA_BASE, type KeepaQueryResponse } from './keepa.js';
import { logger } from './logger.js';
import type { Candidate } from './draft.js';

const apiKey = (): string => {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error('KEEPA_API_KEY is not set');
  return key;
};

// brand 単体で /query を叩く。失敗時は warn ログのみで空配列を返す (経路 isolation)。
// Spec A5: brand 経路の失敗は他経路を止めない。
export const queryBrandAsins = async (brand: string): Promise<string[]> => {
  const url = `${KEEPA_BASE}/query`;
  const selection = {
    page: 0,
    perPage: BRAND_PAGE_SIZE,
    domainId: KEEPA_DOMAIN,
    brand: [brand],
    // 値下げ商品優先で並べ替え。deltaPercent90 が小さい (= 大きく下がっている) ものから。
    sort: [['deltaPercent90_AMAZON', 'asc']],
    asinsOnly: true,
  };
  try {
    const res = await axios.post<KeepaQueryResponse>(url, selection, {
      params: { key: apiKey(), domain: KEEPA_DOMAIN },
      timeout: 30_000,
    });
    const rawAsins = res.data.asinList ?? res.data.asins ?? [];
    // Keepa contract: ASIN は 10 文字 alphanumeric。malformed entries (空文字 / 非 ASCII) を下流に流さない。
    const asins = rawAsins.filter((a): a is string => typeof a === 'string' && /^[A-Z0-9]{10}$/.test(a));
    logger.info('brand-watch', 'query ok', {
      brand,
      count: asins.length,
      tokensLeft: res.data.tokensLeft ?? null,
    });
    return asins;
  } catch (err) {
    logger.warn('brand-watch', 'query failed', {
      brand,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
};

// dropPercent 降順でソートし、上限 quota 件まで切る。
// caller (collectBrandHits) は brand 別に collect した list を渡す前提 (= single-brand 由来)。
// 異 brand に同じ ASIN が hit するケースは dedupeWithinBrand で最終 dedupe する。
export const selectByBrandQuota = (
  hits: readonly Candidate[],
  quota: number = BRAND_QUOTA,
): Candidate[] => {
  const sorted = [...hits].sort((a, b) => b.dropPercent - a.dropPercent);
  return sorted.slice(0, quota);
};

// 同 ASIN の重複を排除 (異 brand に同じ ASIN が hit する稀ケース対応)。
// 最初に見つけた entry を残す (input 順を保持)。
export const dedupeWithinBrand = (hits: readonly Candidate[]): Candidate[] => {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of hits) {
    if (seen.has(c.asin)) continue;
    seen.add(c.asin);
    out.push(c);
  }
  return out;
};

// 1 brand 分の ASIN list を Candidate[] に変換 (checkAsin + filter)。
// 失敗 ASIN は warn ログのみで skip し、brand loop 全体は継続する。
const evaluateBrandAsins = async (
  brand: string,
  asins: readonly string[],
): Promise<Candidate[]> => {
  const brandCandidates: Candidate[] = [];
  for (const asin of asins) {
    try {
      const history = await checkAsin(asin);
      if (!history) continue;
      if (history.currentPrice < MIN_PRICE_YEN) continue;
      if (history.dropPercent < DROP_THRESHOLD_PERCENT) continue;
      brandCandidates.push({
        asin,
        title: history.title,
        currentPrice: history.currentPrice,
        referencePrice: history.referencePrice,
        dropPercent: history.dropPercent,
        source: 'brand',
        // brand → category 紐づけは config.ts の BRAND_CATEGORY_MAP で一元管理。
        // 未登録 brand は BRAND_DEFAULT_CATEGORY (= 'kitchen') にフォールバック。
        category: BRAND_CATEGORY_MAP[brand] ?? BRAND_DEFAULT_CATEGORY,
      });
    } catch (err) {
      logger.warn('brand-watch', 'checkAsin failed', {
        asin,
        brand,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return brandCandidates;
};

// brand 経路のエントリポイント。draft.ts main() から呼ぶ。
// 1. WATCH_BRANDS をループ、/query で ASIN 取得
// 2. 各 ASIN を checkAsin で価格 + reference 取得
// 3. DROP_THRESHOLD_PERCENT 以上の値下げのみ Candidate に変換
// 4. brand 別 quota で select、最終的に dedupe
//
// 失敗時 (catch) は warn ログのみで空配列を return。run 全体は止めない。
export const collectBrandHits = async (): Promise<Candidate[]> => {
  const result: Candidate[] = [];
  for (const brand of WATCH_BRANDS) {
    try {
      const asins = await queryBrandAsins(brand);
      const brandCandidates = await evaluateBrandAsins(brand, asins);
      const selected = selectByBrandQuota(brandCandidates, BRAND_QUOTA);
      result.push(...selected);
      logger.info('brand-watch', 'brand processed', {
        brand,
        rawHits: asins.length,
        afterFilter: brandCandidates.length,
        selected: selected.length,
      });
    } catch (err) {
      logger.warn('brand-watch', 'brand loop failed', {
        brand,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return dedupeWithinBrand(result);
};
