import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { POST_TEXT_MAX_CHARS } from './config.js';
import { appendHistory } from './history.js';
import { computeRequiredMinutes, elapsedMinutes, shouldPost } from './interval-gate.js';
import { logger } from './logger.js';
import {
  fetchPageById,
  queryApprovedPageIds,
  updateStatusToPosted,
  type DraftPayload,
  type PostedLinks,
} from './notion.js';
import { exceedsXWeightedLimit, xWeightedLength } from './post-length.js';
import { getLatestSelfPostAt } from './posters/bluesky.js';
import { dispatch, posters, type PostInput, type PostResult } from './posters/index.js';

interface PublishArgs {
  // drain モード (cron */5 起動) では page_id を指定しない。null の場合は queryApprovedPageIds で
  // oldest 1 件を選んで投稿対象にする。workflow_dispatch から手動再投稿する時のみ page_id を渡す。
  pageId: string | null;
}

// Notion page id は 32 桁 hex (dash optional) の UUID 形式。
// HIGH-1 対応: 任意の文字列を受け取って Notion API に渡す前に format check で fail-fast。
const NOTION_PAGE_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const parseArgs = (argv: readonly string[]): PublishArgs => {
  const idx = argv.indexOf('--page-id');
  if (idx === -1) {
    // drain モード (cron 起動)。queryApprovedPageIds で oldest approved を取りに行く。
    return { pageId: null };
  }
  if (idx + 1 >= argv.length) {
    throw new Error('--page-id requires a value');
  }
  const pageId = argv[idx + 1];
  // workflow_dispatch から空文字列が来た場合も drain モード扱い (Notion automation 廃止後の
  // 手動 dispatch で page_id を空のまま実行できるようにする)。
  if (!pageId) return { pageId: null };
  if (!NOTION_PAGE_ID_RE.test(pageId)) {
    throw new Error('--page-id must be a Notion page UUID (32 hex chars, dashes optional)');
  }
  return { pageId };
};

// drain モードで Notion から oldest approved を 1 件選ぶ。queue が空なら null を返す。
// queryApprovedPageIds は config 未設定で空配列を返すため、env 未設定で本 fn を呼んでも安全。
const selectTargetPageId = async (): Promise<string | null> => {
  const ids = await queryApprovedPageIds();
  if (ids.length === 0) {
    logger.info('publish', 'no approved pages, nothing to drain');
    return null;
  }
  logger.info('publish', 'drain mode: picked oldest approved page', {
    pageId: ids[0],
    queueDepth: ids.length,
  });
  return ids[0] ?? null;
};

// Bluesky の最新自前 post から経過時間を見て投稿可否を判定する。
//   - 投稿対象に Bluesky が含まれない (blueskyPosted=true で除外済) → gate 不要、true を返す
//   - getLatestSelfPostAt が throw → fail-safe で false (誤連投を避けるため投稿しない)
//   - shouldPost の結果に従う。skip 時は CI ログで経過分数 / 必要分数を出力
// rng は test 注入用 (production は Math.random)。
export const checkBlueskyIntervalGate = async (
  needsBluesky: boolean,
  now: Date,
  rng: () => number = Math.random,
): Promise<boolean> => {
  if (!needsBluesky) return true;
  const required = computeRequiredMinutes(rng);
  let lastPostAt: Date | null;
  try {
    lastPostAt = await getLatestSelfPostAt();
  } catch (err) {
    logger.error('publish', 'getLatestSelfPostAt failed, fail-safe skip (no post)', {
      error: err instanceof Error ? err.message : String(err),
      requiredMinutes: required,
    });
    return false;
  }
  const ok = shouldPost(lastPostAt, now, required);
  if (!ok && lastPostAt) {
    logger.info('publish', 'interval gate blocked, skipping this run', {
      lastPostAt: lastPostAt.toISOString(),
      elapsedMinutes: elapsedMinutes(lastPostAt, now),
      requiredMinutes: Math.round(required * 10) / 10,
    });
  } else if (ok) {
    logger.info('publish', 'interval gate passed', {
      lastPostAt: lastPostAt ? lastPostAt.toISOString() : null,
      elapsedMinutes: lastPostAt ? elapsedMinutes(lastPostAt, now) : null,
      requiredMinutes: Math.round(required * 10) / 10,
    });
  }
  return ok;
};

export const main = async (argv: readonly string[]): Promise<void> => {
  const startedAt = new Date();
  const runId = `${startedAt.getTime()}-${randomBytes(2).toString('hex')}`;
  const args = parseArgs(argv);
  // drain モード (page_id 未指定) では Notion から oldest approved を選ぶ。queue 空なら early return。
  const pageId = args.pageId ?? (await selectTargetPageId());
  if (!pageId) {
    logger.info('publish', 'drain mode: queue empty, exiting 0');
    return;
  }
  logger.info('publish', 'run started', {
    startedAt: startedAt.toISOString(),
    runId,
    pageId,
    mode: args.pageId ? 'single' : 'drain',
  });

  let payload: DraftPayload;
  try {
    payload = await fetchPageById(pageId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // fetchPageById は 2 種類の理由で throw する。
    //   (a) Status 不整合 (approved 以外 / 未知の status) → 二重発火 / 運用ミス由来、silent return で抑止
    //   (b) 必須 number property が null/NaN (PR B1 で導入) → Notion データ品質バグ、fatal にして気付かせる
    // message に「セール価格」「通常価格」「割引率」のいずれかを含めば (b) と判定。
    const isDataQualityError = /(セール価格|通常価格|割引率)/.test(message);
    if (isDataQualityError) {
      logger.error('publish', 'Notion data quality error, aborting', {
        pageId,
        error: message,
      });
      process.exit(1);
    }
    logger.warn('publish', 'page not eligible for publish', {
      pageId,
      error: message,
    });
    return;
  }

  // 二重ガード: Status=approved だが「投稿日時」がセット済 = 過去に publish 済の row を
  // 何らかの理由で approved に戻したケース (運用ミス / Notion automation 多重発火 race)。
  // Status check (fetchPageById) を擦り抜けるので追加で early return する。
  if (payload.postedAt) {
    logger.warn('publish', 'page already posted, refusing duplicate', {
      pageId,
      asin: payload.asin,
      postedAt: payload.postedAt,
    });
    return;
  }

  // Notion AI 運用では、ドラフト作成時に「投稿文」property が空文字列で入る。人が Notion 上で
  // 文言を埋めずに approved に遷移させると、X/Bluesky に空テキストが流れる事故が起きる。
  // 空 投稿文 の段階では publish を refuse する。Status は approved のまま残し、人が文言を埋めて
  // Notion automation を再発火させれば再投稿される。
  if (payload.postText.trim().length === 0) {
    logger.warn('publish', '投稿文 is empty, refusing to post', {
      pageId,
      asin: payload.asin,
    });
    return;
  }

  // 旧実装では `anySucceeded(result)` で 1 つでも成功すれば Status=posted に遷移していたため、
  // X 文字数上限超で X 失敗 + Bluesky 成功となり、X 側の silent data loss が発生していた。
  // 本 PR で全 required platform 成功時のみ posted に遷移するよう変更したが、X の文字数上限超は
  // 依然両 SNS の投稿状態を不整合化させる (= X 不投稿で X side が approved に残り、cron で
  // 同 ASIN を再 dispatch する流れに乗せると Bluesky が二重投稿される)。これを避けるため
  // 上限超は publish 全体を refuse し、bon が Notion で 投稿文 を短縮した上で再投稿可能なまま
  // approved に残す方針を維持する。
  //
  // 旧実装は `[...str].length` (Unicode code point) で判定していたが、X は weighted character count
  // (CJK / emoji = 2、URL = 23 固定) を使うため、CJK 多めや markdown link `[url](url)` で URL が
  // 二重にカウントされる文 (実バグ row Index 366: codepoint 207 / weighted 292) を取りこぼしていた。
  // post-length.ts の twitter-text 経由で X 公式の weighted count に揃える。
  if (exceedsXWeightedLimit(payload.postText)) {
    logger.warn('publish', '投稿文 exceeds X weighted char limit, refusing to post', {
      pageId,
      asin: payload.asin,
      weightedLength: xWeightedLength(payload.postText),
      codepointLength: [...payload.postText].length,
      limit: POST_TEXT_MAX_CHARS,
    });
    return;
  }

  // PR-1 Phase 2: per-platform 既投稿チェック。Notion checkbox `x_posted` / `bluesky_posted` が
  // true の platform は dispatch から除外し、残り platform のみ retry する (silent loss 解消)。
  const filteredPosters = posters.filter(
    (p) => !(p.name === 'x' && payload.xPosted) && !(p.name === 'bluesky' && payload.blueskyPosted),
  );
  if (filteredPosters.length === 0) {
    // 両既投稿。本来は payload.postedAt 早期 return ガード (line 71-) で先に止まる想定だが、
    // checkbox は true で postedAt が空 (運用ミスで Status=approved に戻されたケース等) でも
    // ここに来る。silent loss を避けるため warn のみで何もしない。
    logger.warn('publish', 'all platforms already posted, nothing to do', {
      pageId,
      asin: payload.asin,
      xPosted: payload.xPosted,
      blueskyPosted: payload.blueskyPosted,
    });
    return;
  }

  // Bluesky spam label 対策 (PR: post-interval): Bluesky 投稿を含む run では、直前の自前 top-level
  // post から 5〜15 分 (random) の間隔が空いていない場合 skip して exit 0 する。X だけ retry の
  // 場合 (xPosted=false, blueskyPosted=true) は gate 不要 — 投稿対象に Bluesky が無いため。
  // 取得失敗 (API down 等) は fail-safe で skip (誤連投リスクを優先回避)。
  // skip 時は Status=approved のまま残り、次の cron */5 で再評価される (queue 消化方式)。
  const needsBluesky = filteredPosters.some((p) => p.name === 'bluesky');
  const gateOk = await checkBlueskyIntervalGate(needsBluesky, new Date());
  if (!gateOk) {
    logger.info('publish', 'skipped by interval gate, exiting 0 (will retry next run)', {
      pageId,
      asin: payload.asin,
    });
    return;
  }

  const input: PostInput = { asin: payload.asin, text: payload.postText };
  const result: PostResult = await dispatch(filteredPosters, input);
  // allRequiredSucceeded: filteredPosters 全 poster が成功した場合のみ true。Status=posted への
  // 遷移は両 platform 完遂時 (= 既投稿 platform 込みで全 platform 投稿済) のみ許可する。
  const allRequiredSucceeded = filteredPosters.every((p) => result[p.name]?.ok === true);
  // post-history.jsonl の schema は `Record<string, boolean>` のまま維持 (URL を持つ新形式は
  // 過去 entry と互換性が崩れるため)。URL は Notion bookmark 化のみに使い、log/history には
  // 入れない。
  const postersBool = Object.fromEntries(
    Object.entries(result).map(([k, v]) => [k, v.ok]),
  );
  const historyEntry = {
    timestamp: new Date().toISOString(),
    runId,
    asin: payload.asin,
    title: payload.title,
    currentPrice: payload.currentPrice,
    referencePrice: payload.referencePrice,
    dropPercent: payload.dropPercent,
    source: 'publish' as const,
    category: payload.category,
    posters: postersBool,
  };
  await appendHistory(historyEntry);

  // updateStatusToPosted は per-platform 制御に変更済 (Status=posted は両 platform 投稿済時のみ)。
  // prior 既投稿フラグも渡し、前回 X だけ成功 → 今回 BSky retry 成功のような per-platform retry
  // シナリオで両 SNS 完遂時に Status=posted に正しく進めるようにする。
  // 失敗 platform は approved のまま残し、次回 publish 再実行で retry できる構造を維持する。
  const links: PostedLinks = {
    x: result.x?.url,
    bluesky: result.bluesky?.url,
  };
  await updateStatusToPosted(pageId, result, new Date(), links, {
    xPosted: payload.xPosted,
    blueskyPosted: payload.blueskyPosted,
  });

  if (allRequiredSucceeded) {
    logger.info('publish', 'run finished', {
      durationMs: Date.now() - startedAt.getTime(),
      asin: payload.asin,
      result,
    });
  } else {
    // dispatch 対象の poster のうち少なくとも 1 つが失敗。Status は approved のまま、
    // 成功 platform の checkbox のみ更新済 → 次回 publish で残り platform を retry。
    logger.warn('publish', 'some posters failed, leaving status=approved for retry', {
      asin: payload.asin,
      result,
    });
  }
};

if (!process.env.VITEST) {
  main(process.argv).catch((err) => {
    logger.error('publish', 'fatal error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
