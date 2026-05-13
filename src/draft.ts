import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { buildAffiliateUrl, requirePartnerTag } from './affiliate.js';
import { loadBlocklist } from './blocklist.js';
import { CATEGORY_FIXED, mapKeepaCategoryToNotion, type NotionCategory } from './category.js';
import {
  CATEGORY_QUOTA,
  DROP_THRESHOLD_PERCENT,
  FIXED_ASINS,
  KEEPA_CATEGORIES,
  MAX_POSTS_PER_RUN,
  MIN_PRICE_YEN,
} from './config.js';
import { calcDropPercent, filterByActiveAsins, isGoodDeal } from './filter.js';
import { composeFixedPostText, fetchFixedDescriptions } from './fixed-templates.js';
import { appendHistory } from './history.js';
import { checkAsin, getDeals } from './keepa.js';
import { logger } from './logger.js';
import {
  createDraftPage,
  createPostedPage,
  queryDuplicateAsins,
  type DraftCandidate,
} from './notion.js';
import { getItems, type ProductInfo } from './paapi.js';
import { anySucceeded, dispatch, posters } from './posters/index.js';
import { appendRunLog, type RunStatus } from './run-log.js';
import { passesTitleWhitelist } from './title-filter.js';

// @notionhq/client v5 の retry log は library 内部の console.warn で出る (実例:
// "@notionhq/client warn: request fail" prefix)。これを集約して run-log の notion_retries に
// 渡すため、起動時に console.warn を 1 度だけ wrap する。
//
// vitest 環境 (process.env.VITEST) では wrap を省略 — test の console.warn assert を汚染しない。
// counter は per-process で、cron は毎回新 process なので cold start でリセットされる前提。
//
// 将来 @notionhq/client が公式 retry callback (e.g. onRetry hook) を提供したら、本 wrap を
// 撤去して callback 経由で count する方が堅牢。それまでは prefix substring 検出で運用する。
const NOTION_RETRY_LOG_PREFIX = '@notionhq/client warn';
const notionRetryCounter = { count: 0 };
if (!process.env.VITEST) {
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes(NOTION_RETRY_LOG_PREFIX)) {
      notionRetryCounter.count += 1;
    }
    origWarn(...args);
  };
}

export interface Candidate {
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  source: 'deals' | 'fixed';
  category: NotionCategory;
}

const buildKeepaProduct = (c: Candidate, partnerTag: string): ProductInfo => ({
  asin: c.asin,
  title: c.title,
  imageUrl: '',
  currentPrice: c.currentPrice,
  affiliateUrl: buildAffiliateUrl(c.asin, partnerTag),
});

interface CollectDealsResult {
  candidates: Candidate[];
  // 全 category 走査後の最終 tokensLeft (= 最後に成功した API call の値)。
  // run-log への記録用。1 件も成功しなければ null。
  lastTokensLeft: number | null;
}

const collectDeals = async (): Promise<CollectDealsResult> => {
  const candidates: Candidate[] = [];
  let lastTokensLeft: number | null = null;
  for (const categoryId of KEEPA_CATEGORIES) {
    try {
      const { deals, tokensLeft } = await getDeals(categoryId);
      if (tokensLeft !== null) lastTokensLeft = tokensLeft;
      const category = mapKeepaCategoryToNotion(categoryId);
      for (const d of deals) {
        if (d.currentPrice < MIN_PRICE_YEN) continue;
        if (!isGoodDeal(d.currentPrice, d.referencePrice)) continue;
        if (!passesTitleWhitelist(category, d.title)) {
          logger.debug('draft', 'dropped by title whitelist', {
            asin: d.asin,
            category,
            title: d.title,
          });
          continue;
        }
        candidates.push({
          asin: d.asin,
          title: d.title,
          currentPrice: d.currentPrice,
          referencePrice: d.referencePrice,
          dropPercent: calcDropPercent(d.currentPrice, d.referencePrice),
          source: 'deals',
          category,
        });
      }
    } catch (err) {
      logger.error('draft', 'getDeals failed', {
        categoryId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { candidates, lastTokensLeft };
};

const collectFixed = async (): Promise<Candidate[]> => {
  const candidates: Candidate[] = [];
  for (const asin of FIXED_ASINS) {
    try {
      const history = await checkAsin(asin);
      if (!history) continue;
      if (history.currentPrice < MIN_PRICE_YEN) continue;
      if (!isGoodDeal(history.currentPrice, history.referencePrice, DROP_THRESHOLD_PERCENT)) {
        continue;
      }
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
      logger.error('draft', 'checkAsin failed', {
        asin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return candidates;
};

// 固定ASIN 候補を Notion 投稿文 DB から取得した紹介文と結合し、X/Bluesky に即投稿する。
// 投稿成功した候補は Notion 投稿文 DB に status=posted で記録 + post-history.jsonl に append。
// 返り値: 実際に投稿された件数 (log / partial 判定 のため)。
// 本 fn 内の失敗は warn ログのみで上位 run 全体は止めない (deals 経路の処理を継続)。
const publishFixedCandidates = async (
  candidates: readonly Candidate[],
  partnerTag: string,
  runId: string,
): Promise<number> => {
  if (candidates.length === 0) return 0;
  let descriptions: Map<string, string>;
  try {
    descriptions = await fetchFixedDescriptions();
  } catch (err) {
    logger.error('draft', 'fetchFixedDescriptions failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  let postedCount = 0;
  for (const c of candidates) {
    const description = descriptions.get(c.asin);
    if (!description) {
      logger.warn('draft', 'no fixed description in notion, skipping', { asin: c.asin });
      continue;
    }
    const affiliateUrl = buildAffiliateUrl(c.asin, partnerTag);
    const composed = composeFixedPostText(
      description,
      c.dropPercent,
      c.currentPrice,
      c.referencePrice,
      affiliateUrl,
    );
    if (!composed) {
      logger.warn('draft', 'composed post text exceeds 280 chars, skipping', {
        asin: c.asin,
        dropPercent: c.dropPercent,
      });
      continue;
    }
    let result;
    try {
      result = await dispatch(posters, { asin: c.asin, text: composed });
    } catch (err) {
      logger.error('draft', 'fixed dispatch threw', {
        asin: c.asin,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!anySucceeded(result)) {
      logger.warn('draft', 'all posters failed for fixed asin', { asin: c.asin });
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
          referencePrice: c.referencePrice,
          dropPercent: c.dropPercent,
          category: c.category,
          generatedAt: postedAt,
        },
        postedAt,
        { x: result.x?.url, bluesky: result.bluesky?.url },
      );
    } catch (err) {
      logger.error('draft', 'createPostedPage failed (post is live on SNS already)', {
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
        referencePrice: c.referencePrice,
        dropPercent: c.dropPercent,
        source: 'fixed-direct',
        category: c.category,
        posters: postersBool,
      });
    } catch (err) {
      logger.error('draft', 'appendHistory failed for fixed-direct post', {
        asin: c.asin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    postedCount += 1;
  }
  return postedCount;
};

// Keepa deals 由来候補を CATEGORY_QUOTA に基づいて選別する。
// - カテゴリ毎に dropPercent 降順で並べ、上位から quota 件数まで採用。
// - 1 カテゴリが quota に満たない場合でも他カテゴリへ再分配しない (fail-safe)。
// - fixed-list は quota 対象外 (本関数は呼び出し前に除外しておく)。
export const selectByQuota = (
  candidates: readonly Candidate[],
  quota: Readonly<Record<NotionCategory, number>> = CATEGORY_QUOTA,
): Candidate[] => {
  const byCategory = new Map<NotionCategory, Candidate[]>();
  for (const c of candidates) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }
  const selected: Candidate[] = [];
  for (const [category, list] of byCategory) {
    const cap = quota[category] ?? 0;
    if (cap <= 0) continue;
    const sorted = [...list].sort((a, b) => b.dropPercent - a.dropPercent);
    selected.push(...sorted.slice(0, cap));
  }
  // 決定性確保のため、最終結果も dropPercent 降順で安定化。
  return selected.sort((a, b) => b.dropPercent - a.dropPercent);
};

// run の終了形態。partial = 一部 createDraftPage が失敗 (targets > 0 かつ drafted < targets)。
// 完全成功 / 失敗ゼロは success、catch (err) に到達したら failure。
const decideStatus = (
  errorMessage: string | null,
  targetsCount: number,
  draftedCount: number,
): RunStatus => {
  if (errorMessage) return 'failure';
  if (targetsCount > 0 && draftedCount < targetsCount) return 'partial';
  return 'success';
};

export const main = async (): Promise<void> => {
  // notionRetryCounter は module スコープで定義しているため、同 process で main() を複数回
  // 呼ぶ test ケースでは前回の値が残る。各 run の独立性を保つため main 開始時にリセットする。
  notionRetryCounter.count = 0;
  const startedAt = new Date();
  const runId = `${startedAt.getTime()}-${randomBytes(2).toString('hex')}`;
  // run-log 用に最終結果を集約する状態。catch/finally まで持ち回す。
  let dealsTotal = 0;
  let tokensLeft: number | null = null;
  let targetsCount = 0;
  let draftedCount = 0;
  let errorMessage: string | null = null;

  logger.info('draft', 'run started', {
    startedAt: startedAt.toISOString(),
    runId,
  });

  try {
    const partnerTag = requirePartnerTag();

    const [blocklist, activeAsins] = await Promise.all([
      loadBlocklist(),
      queryDuplicateAsins(startedAt),
    ]);

    const { candidates: dealCandidates, lastTokensLeft } = await collectDeals();
    tokensLeft = lastTokensLeft;
    dealsTotal = dealCandidates.length;
    const fixedCandidates = await collectFixed();
    logger.info('draft', 'candidates collected', {
      deals: dealCandidates.length,
      fixed: fixedCandidates.length,
    });

    // fixed は Notion AI 経路を介さず Keepa 値下げ検知 → composeFixedPostText → X/Bluesky 即投稿 →
    // Notion 投稿文 DB に status=posted で記録、の独立フロー。activeAsins / blocklist の除外も本ループ内で実施。
    const fixedFiltered = fixedCandidates
      .filter((c) => !blocklist.has(c.asin))
      .filter((c) => !activeAsins.has(c.asin));
    const fixedPostedCount = await publishFixedCandidates(fixedFiltered, partnerTag, runId);

    // deals 経路のみが従来通り createDraftPage (status=backlog) に進む。
    const afterBlocklist = dealCandidates.filter((c) => !blocklist.has(c.asin));
    const filtered = filterByActiveAsins(afterBlocklist, activeAsins);
    const dealTargets = selectByQuota(filtered);
    // safety cap (PA-API / Notion 連打抑制)。固定ASIN の即投稿分は別カウントなので cap 対象外。
    const targets = dealTargets.slice(0, MAX_POSTS_PER_RUN);
    targetsCount = targets.length;
    logger.info('draft', 'targets selected', {
      dealsAfterBlocklist: afterBlocklist.length,
      dealsAfterActive: filtered.length,
      dealTargets: dealTargets.length,
      fixedPosted: fixedPostedCount,
      willDraft: targets.length,
    });
    // 即投稿された固定ASIN は drafted には数えないが、partial 判定に巻き込まれないよう draftedCount は
    // deals 経路ぶんだけ追跡する (固定ASIN 失敗は warn ログのみで partial 化しない方針)。

    if (targets.length === 0) {
      logger.info('draft', 'no targets, run finished');
    } else {
      // PA-API がある場合は最優先、なければ Keepa 由来 ProductInfo で続行
      let paapiProducts: ProductInfo[] = [];
      try {
        paapiProducts = await getItems(targets.map((t) => t.asin));
      } catch (err) {
        logger.warn('draft', 'PA-API getItems failed, falling back to Keepa-only', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const paapiByAsin = new Map(paapiProducts.map((p) => [p.asin, p]));

      for (const target of targets) {
        const product = paapiByAsin.get(target.asin) ?? buildKeepaProduct(target, partnerTag);
        // postText は Notion AI で生成する運用に移行したため、ドラフト作成時は空文字列で初期化する。
        // Notion 上で人が文言を埋めてから approved に遷移させる。空のまま approved にすると publish が refuse する。
        const draft: DraftCandidate = {
          asin: target.asin,
          title: product.title,
          postText: '',
          amazonUrl: buildAffiliateUrl(target.asin, partnerTag),
          currentPrice: product.currentPrice,
          referencePrice: target.referencePrice,
          dropPercent: target.dropPercent,
          category: target.category,
          generatedAt: new Date(),
        };
        try {
          const pageId = await createDraftPage(draft);
          logger.info('draft', 'page created', { asin: target.asin, pageId });
          draftedCount += 1;
        } catch (err) {
          logger.error('draft', 'createDraftPage failed', {
            asin: target.asin,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info('draft', 'run finished', {
        durationMs: Date.now() - startedAt.getTime(),
        targets: targets.length,
        drafted: draftedCount,
      });
    }
  } catch (err) {
    // run 全体が止まる致命例外 (queryDuplicateAsins timeout 等)。
    // catch でログを残しつつ rethrow せず、finally で run-log を書いてから process.exit する。
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('draft', 'fatal error', {
      error: errorMessage,
      stack: err instanceof Error ? err.stack : undefined,
    });
  } finally {
    const status = decideStatus(errorMessage, targetsCount, draftedCount);
    await appendRunLog({
      runId,
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      status,
      dealsTotal,
      tokensLeft,
      targetsSelected: targetsCount,
      draftsCreated: draftedCount,
      errorMessage,
      notionRetries: notionRetryCounter.count,
    });
  }
  if (errorMessage) {
    process.exit(1);
  }
};

// vitest 実行中は main() を自動起動しない (test がモジュールを import する際の副作用回避)。
if (!process.env.VITEST) {
  main().catch((err) => {
    // main() 内部で catch + finally まで完結するため、本来ここに来ない。
    // 万一 appendRunLog 自体が throw した場合 (best-effort 設計だが念のため) の最終 fallback。
    logger.error('draft', 'unexpected outer error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
