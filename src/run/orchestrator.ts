import { randomBytes } from 'node:crypto';
import { requirePartnerTag } from '../affiliate.js';
import { loadBlocklist } from '../blocklist.js';
import type { NotionCategory } from '../category.js';
import {
  CATEGORY_QUOTA,
  COOLDOWN_HOURS,
  MAX_POSTS_PER_RUN,
} from '../config.js';
import { filterByActiveAsins } from '../filter.js';
import { readRecentAsins } from '../history.js';
import { logger } from '../logger.js';
import {
  createDraftPage,
  queryDuplicateAsins,
  type DraftCandidate,
} from '../notion.js';
import { getItems, type ProductInfo } from '../paapi.js';
import { buildKeepaProduct, collectDeals } from '../pipelines/deals.js';
import { collectFixed, publishFixedCandidates } from '../pipelines/fixed.js';
import { collectBrandHits } from '../pipelines/brand.js';
import { appendRunLog, type RunStatus } from '../run-log.js';
import type { Candidate } from '../types.js';

// @notionhq/client v5 の retry log は library 内部の console.warn で出る (実例:
// "@notionhq/client warn: request fail" prefix)。これを集約して run-log の notion_retries に
// 渡すため、起動時に console.warn を 1 度だけ wrap する。
// vitest 環境 (process.env.VITEST) では wrap を省略 — test の console.warn assert を汚染しない。
// counter は per-process で、cron は毎回新 process なので cold start でリセットされる前提。
const NOTION_RETRY_LOG_PREFIX = '@notionhq/client warn';
export const notionRetryCounter = { count: 0 };
if (!process.env.VITEST) {
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes(NOTION_RETRY_LOG_PREFIX)) {
      notionRetryCounter.count += 1;
    }
    origWarn(...args);
  };
}

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
export const decideStatus = (
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

  logger.info('orchestrator', 'run started', {
    startedAt: startedAt.toISOString(),
    runId,
  });

  try {
    const partnerTag = requirePartnerTag();

    // 二重投稿ガード = Notion (primary) ∪ post-history.jsonl (secondary、PR-A3)。
    //   - Notion queryDuplicateAsins: backlog/doing/approved/posted + cooldown 内 ASIN
    //   - readRecentAsins: SNS 投稿成功直後に append される jsonl から cooldown 内 ASIN
    // publishFixedCandidates の SNS 投稿成功 → Notion 書き込み失敗 race で Notion 側に entry が
    // 残らなくても jsonl 側で次回 run の再投稿を防ぐ。
    const [blocklist, notionDup, historyDup] = await Promise.all([
      loadBlocklist(),
      queryDuplicateAsins(startedAt),
      readRecentAsins(startedAt, COOLDOWN_HOURS),
    ]);
    const activeAsins = new Set([...notionDup, ...historyDup]);
    logger.info('orchestrator', 'activeAsins assembled', {
      notion: notionDup.size,
      history: historyDup.size,
      union: activeAsins.size,
    });

    const { candidates: dealCandidates, lastTokensLeft } = await collectDeals();
    tokensLeft = lastTokensLeft;
    dealsTotal = dealCandidates.length;
    const fixedCandidates = await collectFixed();
    const brandCandidates = await collectBrandHits();
    logger.info('orchestrator', 'candidates collected', {
      deals: dealCandidates.length,
      fixed: fixedCandidates.length,
      brand: brandCandidates.length,
    });

    // fixed は Notion AI 経路を介さず Keepa 値下げ検知 → composeFixedPostText → X/Bluesky 即投稿 →
    // Notion 投稿文 DB に status=posted で記録、の独立フロー。activeAsins / blocklist の除外も本ループ内で実施。
    const fixedFiltered = fixedCandidates
      .filter((c) => !blocklist.has(c.asin))
      .filter((c) => !activeAsins.has(c.asin));
    const fixedPostedCount = await publishFixedCandidates(fixedFiltered, partnerTag, runId);

    // deals 経路: blocklist + activeAsins フィルタ → selectByQuota (CATEGORY_QUOTA 枠管理)。
    const dealsAfterBlocklist = dealCandidates.filter((c) => !blocklist.has(c.asin));
    const dealsAfterActive = filterByActiveAsins(dealsAfterBlocklist, activeAsins);
    const dealTargets = selectByQuota(dealsAfterActive);

    // brand 経路: 同じ blocklist + activeAsins フィルタを通すが、selectByQuota は通さない。
    // pipelines/brand.ts 内で既に BRAND_QUOTA=2/brand で絞り済み (= 最大 6 件)。
    // CATEGORY_QUOTA とは独立した枠として targets に合流させる (Spec §6.X "BRAND_QUOTA 分離")。
    const brandAfterBlocklist = brandCandidates.filter((c) => !blocklist.has(c.asin));
    const brandAfterActive = filterByActiveAsins(brandAfterBlocklist, activeAsins);

    // 最終 targets = deals (CATEGORY_QUOTA 枠) + brand (BRAND_QUOTA 枠、独立)。
    // MAX_POSTS_PER_RUN=30 cap で全体上限を担保 (PA-API / Notion 連打抑制)。
    // 固定ASIN の即投稿分は別カウントなので cap 対象外。
    const targets = [...dealTargets, ...brandAfterActive].slice(0, MAX_POSTS_PER_RUN);
    targetsCount = targets.length;
    logger.info('orchestrator', 'targets selected', {
      dealsAfterBlocklist: dealsAfterBlocklist.length,
      dealsAfterActive: dealsAfterActive.length,
      dealTargets: dealTargets.length,
      brandAfterActive: brandAfterActive.length,
      fixedPosted: fixedPostedCount,
      willDraft: targets.length,
    });

    if (targets.length === 0) {
      logger.info('orchestrator', 'no targets, run finished');
    } else {
      // PA-API がある場合は最優先、なければ Keepa 由来 ProductInfo で続行
      let paapiProducts: ProductInfo[] = [];
      try {
        paapiProducts = await getItems(targets.map((t) => t.asin));
      } catch (err) {
        logger.warn('orchestrator', 'PA-API getItems failed, falling back to Keepa-only', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const paapiByAsin = new Map(paapiProducts.map((p) => [p.asin, p]));

      for (const target of targets) {
        const product = paapiByAsin.get(target.asin) ?? buildKeepaProduct(target, partnerTag);
        // postText は Notion AI で生成する運用に移行したため、ドラフト作成時は空文字列で初期化する。
        // Amazon URL は null で初期化 (PR-#47)。bon が サクラチェッカー + Amazon 確認後に手動入力。
        const draft: DraftCandidate = {
          asin: target.asin,
          title: product.title,
          postText: '',
          amazonUrl: null,
          currentPrice: product.currentPrice,
          referencePrice: target.referencePrice,
          dropPercent: target.dropPercent,
          category: target.category,
          generatedAt: new Date(),
        };
        try {
          const pageId = await createDraftPage(draft);
          logger.info('orchestrator', 'page created', { asin: target.asin, pageId });
          draftedCount += 1;
        } catch (err) {
          logger.error('orchestrator', 'createDraftPage failed', {
            asin: target.asin,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info('orchestrator', 'run finished', {
        durationMs: Date.now() - startedAt.getTime(),
        targets: targets.length,
        drafted: draftedCount,
      });
    }
  } catch (err) {
    // run 全体が止まる致命例外 (queryDuplicateAsins timeout 等)。
    // catch でログを残しつつ rethrow せず、finally で run-log を書いてから process.exit する。
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('orchestrator', 'fatal error', {
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
