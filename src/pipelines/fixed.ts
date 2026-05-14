import { buildAffiliateUrl } from '../affiliate.js';
import { CATEGORY_FIXED } from '../category.js';
import { DROP_THRESHOLD_PERCENT, FIXED_ASINS, MIN_PRICE_YEN } from '../config.js';
import {
  composeFixedPostText,
  fetchFixedListings,
  type FixedListing,
} from '../fixed-templates.js';
import { appendHistory } from '../history.js';
import { checkAsin } from '../keepa.js';
import { logger } from '../logger.js';
import { createPostedPage } from '../notion.js';
import { getItems, type ProductInfo } from '../paapi.js';
import { anySucceeded, dispatch, posters } from '../posters/index.js';
import type { Candidate } from '../types.js';

// SavingBasis が現価から極端に乖離している場合の上限 (誇大広告防止)。
// Amazon UI 上の割引率は通常 80% 程度が上限で、それを超える値は seller 設定の異常値か
// PA-API レスポンス自体の問題を疑う。本値超過時は SavingBasis を採用せず Keepa fallback に落とす。
// 景表法 (二重価格表示) 観点でも安全側の cap として機能する。
export const MAX_REASONABLE_DROP_PERCENT = 95;

// 固定ASIN は本 fn の段階では DROP_THRESHOLD_PERCENT 判定を行わない。
// publishFixedCandidates 内で SavingBasis 取得後に reference を再評価して閾値判定する。
// MIN_PRICE_YEN early-skip は ASIN 自体が極端値 (¥1 等の Keepa sentinel artifact) の場合の保護として残す。
export const collectFixed = async (): Promise<Candidate[]> => {
  const candidates: Candidate[] = [];
  for (const asin of FIXED_ASINS) {
    try {
      const history = await checkAsin(asin);
      if (!history) continue;
      if (history.currentPrice < MIN_PRICE_YEN) continue;
      candidates.push({
        asin,
        title: history.title,
        currentPrice: history.currentPrice,
        referencePrice: history.referencePrice,
        dropPercent: history.dropPercent,
        source: 'fixed',
        category: CATEGORY_FIXED,
      });
    } catch (err) {
      logger.error('pipelines/fixed', 'checkAsin failed', {
        asin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return candidates;
};

// `collectFixed` で取れた Keepa fallback の reference と、PA-API SavingBasis / Notion 手動入力 参考定価
// を比較して最終 reference を決める。優先順位:
//   1. PA-API SavingBasis (Amazon UI 打消し線価格と一貫)
//   2. Notion 手動入力 参考定価 (bon が運用で設定する希望小売価格 / 旧定価)
//   3. Keepa fallback (referencePrice/dropPercent)
// 採用判定 (各候補共通):
//   - reference > currentPrice (値下げになっている)
//   - 算出される dropPercent ≤ MAX_REASONABLE_DROP_PERCENT (異常値ガード)
// どちらかを満たさない場合は次の候補に fall through。
export const resolveFixedReference = (
  candidate: Candidate,
  savingBasis: number | undefined,
  manualReferencePrice: number | undefined,
): {
  referencePrice: number;
  dropPercent: number;
  referenceSource: 'paapi-saving-basis' | 'manual-reference-price' | 'keepa';
} => {
  if (typeof savingBasis === 'number' && savingBasis > candidate.currentPrice) {
    const dropPercent = Math.max(
      0,
      Math.round(((savingBasis - candidate.currentPrice) / savingBasis) * 100),
    );
    if (dropPercent > MAX_REASONABLE_DROP_PERCENT) {
      logger.warn('pipelines/fixed', 'SavingBasis drop exceeds sanity cap, falling back', {
        asin: candidate.asin,
        savingBasis,
        currentPrice: candidate.currentPrice,
        dropPercent,
        cap: MAX_REASONABLE_DROP_PERCENT,
      });
    } else {
      return { referencePrice: savingBasis, dropPercent, referenceSource: 'paapi-saving-basis' };
    }
  }
  if (typeof manualReferencePrice === 'number' && manualReferencePrice > candidate.currentPrice) {
    const dropPercent = Math.max(
      0,
      Math.round(((manualReferencePrice - candidate.currentPrice) / manualReferencePrice) * 100),
    );
    if (dropPercent > MAX_REASONABLE_DROP_PERCENT) {
      logger.warn('pipelines/fixed', 'manual reference price drop exceeds sanity cap, falling back to Keepa', {
        asin: candidate.asin,
        manualReferencePrice,
        currentPrice: candidate.currentPrice,
        dropPercent,
        cap: MAX_REASONABLE_DROP_PERCENT,
      });
    } else {
      return {
        referencePrice: manualReferencePrice,
        dropPercent,
        referenceSource: 'manual-reference-price',
      };
    }
  }
  return {
    referencePrice: candidate.referencePrice,
    dropPercent: candidate.dropPercent,
    referenceSource: 'keepa',
  };
};

// 固定ASIN 候補を Notion 投稿文 DB から取得した紹介文と結合し、X/Bluesky に即投稿する。
// 投稿成功した候補は Notion 投稿文 DB に status=posted で記録 + post-history.jsonl に append。
// 返り値: 実際に投稿された件数 (log / partial 判定 のため)。
// 本 fn 内の失敗は warn ログのみで上位 run 全体は止めない (deals 経路の処理を継続)。
export const publishFixedCandidates = async (
  candidates: readonly Candidate[],
  partnerTag: string,
  runId: string,
): Promise<number> => {
  if (candidates.length === 0) return 0;
  let listings: Map<string, FixedListing>;
  try {
    listings = await fetchFixedListings();
  } catch (err) {
    logger.error('pipelines/fixed', 'fetchFixedListings failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  // PA-API GetItems で SavingBasis (Amazon UI の打消し線価格) を取得。失敗しても Keepa fallback で
  // 投稿可能なので run 全体を止めない。複数候補をまとめて 1 call (getItems は max 10 ASIN/call)。
  const paapiByAsin = new Map<string, ProductInfo>();
  try {
    const products = await getItems(candidates.map((c) => c.asin));
    for (const p of products) paapiByAsin.set(p.asin, p);
  } catch (err) {
    logger.warn('pipelines/fixed', 'PA-API getItems failed for fixed asins, falling back to Keepa only', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  let postedCount = 0;
  for (const c of candidates) {
    const listing = listings.get(c.asin);
    if (!listing) {
      logger.warn('pipelines/fixed', 'no fixed listing in notion, skipping', { asin: c.asin });
      continue;
    }
    const { description, manualReferencePrice } = listing;
    const paapiInfo = paapiByAsin.get(c.asin);
    const { referencePrice, dropPercent, referenceSource } = resolveFixedReference(
      c,
      paapiInfo?.savingBasis,
      manualReferencePrice,
    );
    logger.info('pipelines/fixed', 'fixed candidate reference resolved', {
      asin: c.asin,
      currentPrice: c.currentPrice,
      referencePrice,
      dropPercent,
      referenceSource,
    });
    if (dropPercent < DROP_THRESHOLD_PERCENT) {
      logger.info('pipelines/fixed', 'fixed candidate below threshold, skipping', {
        asin: c.asin,
        dropPercent,
        threshold: DROP_THRESHOLD_PERCENT,
        referenceSource,
      });
      continue;
    }
    // 固定ASIN DB に bon が手動入力した短縮リンク (amzn.to/...) を最優先で採用。
    // 未設定なら buildAffiliateUrl による generic な dp/?tag= URL に fallback して SNS 投稿が break しないよう defense。
    const affiliateUrl = listing.amazonUrl ?? buildAffiliateUrl(c.asin, partnerTag);
    const composed = composeFixedPostText(
      description,
      dropPercent,
      c.currentPrice,
      referencePrice,
      affiliateUrl,
    );
    if (!composed) {
      logger.warn('pipelines/fixed', 'composed post text exceeds 280 chars, skipping', {
        asin: c.asin,
        dropPercent,
      });
      continue;
    }
    let result;
    try {
      result = await dispatch(posters, { asin: c.asin, text: composed });
    } catch (err) {
      logger.error('pipelines/fixed', 'fixed dispatch threw', {
        asin: c.asin,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!anySucceeded(result)) {
      logger.warn('pipelines/fixed', 'all posters failed for fixed asin', { asin: c.asin });
      continue;
    }
    const postedAt = new Date();
    try {
      await createPostedPage(
        {
          asin: c.asin,
          title: c.title,
          postText: composed,
          amazonUrl: affiliateUrl,
          currentPrice: c.currentPrice,
          referencePrice,
          dropPercent,
          category: c.category,
          generatedAt: postedAt,
        },
        postedAt,
        { x: result.x?.url, bluesky: result.bluesky?.url },
      );
    } catch (err) {
      logger.error('pipelines/fixed', 'createPostedPage failed (post is live on SNS already)', {
        asin: c.asin,
        error: err instanceof Error ? err.message : String(err),
      });
      // SNS 投稿は成功済みなので continue ではなく history append には進む。
    }
    const postersBool = Object.fromEntries(
      Object.entries(result).map(([k, v]) => [k, v.ok]),
    );
    // appendHistory が file I/O 失敗で throw すると loop 全体が abort し、後続候補が silent に skip
    // される (run-log も failure 判定になる)。SNS 投稿は live のため history 失敗は warn ログのみで継続。
    try {
      await appendHistory({
        timestamp: postedAt.toISOString(),
        runId,
        asin: c.asin,
        title: c.title,
        currentPrice: c.currentPrice,
        referencePrice,
        dropPercent,
        source: 'fixed-direct',
        category: c.category,
        posters: postersBool,
      });
    } catch (err) {
      logger.error('pipelines/fixed', 'appendHistory failed for fixed-direct post', {
        asin: c.asin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    postedCount += 1;
  }
  return postedCount;
};
