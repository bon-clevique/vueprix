import axios from 'axios';
import {
  BRAND_CATEGORY_MAP,
  BRAND_CHECKASIN_LIMIT,
  BRAND_DEFAULT_CATEGORY,
  BRAND_PAGE_SIZE,
  BRAND_QUOTA,
  DROP_THRESHOLD_PERCENT,
  KEEPA_DOMAIN,
  MIN_PRICE_YEN,
  WATCH_BRANDS,
} from '../config.js';
import { checkAsinWithTokens, KEEPA_BASE, type KeepaQueryResponse } from '../keepa.js';
import type { KeepaTokenGuard } from '../keepa-token-guard.js';
import { logger } from '../logger.js';
import type { Candidate } from '../types.js';

// brand 経路 pipeline。PR-B (2026-05-14) で旧 brand-watch.ts を物理 move + re-export shim 削除。
// pipelines/{deals,fixed,brand} 構成の対称性を維持。
// Phase 2 (logical-forging-lerdorf): 上位 N 件 limit + fallback 2 段 + KeepaTokenGuard 統合。

const apiKey = (): string => {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error('KEEPA_API_KEY is not set');
  return key;
};

// queryBrandAsins の戻り値。tokensLeft は guard.updateTokensLeft 用に caller に渡す。
// Phase 2 で戻り値構造化。null は Keepa response の tokensLeft 欠落 / call 失敗時。
export interface QueryBrandAsinsResult {
  asins: string[];
  tokensLeft: number | null;
}

// brand 単体で /query を叩く。失敗時は warn ログのみで空配列を返す (経路 isolation)。
// Spec A5: brand 経路の失敗は他経路を止めない。
export const queryBrandAsins = async (brand: string): Promise<QueryBrandAsinsResult> => {
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
    const tokensLeft = res.data.tokensLeft ?? null;
    logger.info('pipelines/brand', 'query ok', {
      brand,
      count: asins.length,
      tokensLeft,
    });
    return { asins, tokensLeft };
  } catch (err) {
    logger.warn('pipelines/brand', 'query failed', {
      brand,
      error: err instanceof Error ? err.message : String(err),
    });
    return { asins: [], tokensLeft: null };
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

// 1 chunk (上位 N or fallback) の ASIN を checkAsin で評価して candidates に append する。
// - guard.shouldCall() === false で remaining 全 skip + warn log
// - candidates.length >= BRAND_QUOTA で early break (call 数を最小化)
// - checkAsin throw は warn log のみで skip (経路 isolation)
const processChunk = async (
  guard: KeepaTokenGuard,
  brand: string,
  chunk: readonly string[],
  candidates: Candidate[],
): Promise<void> => {
  for (let i = 0; i < chunk.length; i += 1) {
    if (candidates.length >= BRAND_QUOTA) return;
    if (!guard.shouldCall()) {
      logger.warn('pipelines/brand', 'token-low-skip', {
        brand,
        remaining: chunk.length - i,
      });
      return;
    }
    const asin = chunk[i];
    if (asin === undefined) continue;
    try {
      const { history, tokensLeft } = await checkAsinWithTokens(asin);
      guard.updateTokensLeft(tokensLeft);
      if (!history) continue;
      if (history.currentPrice < MIN_PRICE_YEN) continue;
      if (history.dropPercent < DROP_THRESHOLD_PERCENT) continue;
      candidates.push({
        asin,
        title: history.title,
        currentPrice: history.currentPrice,
        referencePrice: history.referencePrice,
        dropPercent: history.dropPercent,
        source: 'brand',
        // brand → category 紐づけは config.ts の BRAND_CATEGORY_MAP で一元管理。
        // 未登録 brand は BRAND_DEFAULT_CATEGORY (= 'kitchen') にフォールバック。
        category: BRAND_CATEGORY_MAP[brand] ?? BRAND_DEFAULT_CATEGORY,
        referenceSource: history.referenceSource,
      });
    } catch (err) {
      logger.warn('pipelines/brand', 'checkAsin failed', {
        asin,
        brand,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

// 1 brand 分の ASIN list を Candidate[] に変換 (checkAsin + filter)。
// 上位 BRAND_CHECKASIN_LIMIT 件を chunk1 として checkAsin、quota 未充足なら
// 次 BRAND_CHECKASIN_LIMIT 件 (rank N+1 〜 2N) を chunk2 として fallback で追加 checkAsin。
// guard.shouldCall() が false なら残り全 skip。
// 失敗 ASIN は warn ログのみで skip し、brand loop 全体は継続する。
export const evaluateBrandAsins = async (
  guard: KeepaTokenGuard,
  brand: string,
  asins: readonly string[],
): Promise<Candidate[]> => {
  const candidates: Candidate[] = [];
  const chunk1 = asins.slice(0, BRAND_CHECKASIN_LIMIT);
  await processChunk(guard, brand, chunk1, candidates);
  if (candidates.length < BRAND_QUOTA) {
    const chunk2 = asins.slice(BRAND_CHECKASIN_LIMIT, BRAND_CHECKASIN_LIMIT * 2);
    if (chunk2.length > 0) {
      await processChunk(guard, brand, chunk2, candidates);
    }
  }
  return candidates;
};

// brand 経路のエントリポイント。run/orchestrator.ts main() から呼ぶ。
// 1. WATCH_BRANDS をループ、/query で ASIN 取得 (token check + tokensLeft 反映)
// 2. 各 brand について evaluateBrandAsins で上位 N + fallback で checkAsin
// 3. 各 brand 別 quota で select、最終的に dedupe
//
// 失敗時 (catch) は warn ログのみで空配列を return。run 全体は止めない。
// Phase 2 で KeepaTokenGuard を引数注入 — guard は run 全体で 1 instance を共有する。
export const collectBrandHits = async (guard: KeepaTokenGuard): Promise<Candidate[]> => {
  const result: Candidate[] = [];
  for (const brand of WATCH_BRANDS) {
    try {
      if (!guard.shouldCall()) {
        logger.warn('pipelines/brand', 'token-low-skip', {
          brand,
          phase: 'query',
        });
        continue;
      }
      const { asins, tokensLeft } = await queryBrandAsins(brand);
      guard.updateTokensLeft(tokensLeft);
      const brandCandidates = await evaluateBrandAsins(guard, brand, asins);
      const selected = selectByBrandQuota(brandCandidates, BRAND_QUOTA);
      result.push(...selected);
      logger.info('pipelines/brand', 'brand processed', {
        brand,
        rawHits: asins.length,
        afterFilter: brandCandidates.length,
        selected: selected.length,
      });
    } catch (err) {
      logger.warn('pipelines/brand', 'brand loop failed', {
        brand,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return dedupeWithinBrand(result);
};
