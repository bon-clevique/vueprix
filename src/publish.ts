import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { POST_TEXT_MAX_CHARS } from './config.js';
import { appendHistory } from './history.js';
import { logger } from './logger.js';
import {
  fetchPageById,
  updateStatusToPosted,
  type DraftPayload,
  type PostedLinks,
} from './notion.js';
import { dispatch, posters, type PostInput, type PostResult } from './posters/index.js';

interface PublishArgs {
  pageId: string;
}

// Notion page id は 32 桁 hex (dash optional) の UUID 形式。
// HIGH-1 対応: 任意の文字列を受け取って Notion API に渡す前に format check で fail-fast。
const NOTION_PAGE_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const parseArgs = (argv: readonly string[]): PublishArgs => {
  const idx = argv.indexOf('--page-id');
  if (idx === -1 || idx + 1 >= argv.length) {
    throw new Error('Usage: tsx src/publish.ts --page-id <notion-page-id>');
  }
  const pageId = argv[idx + 1];
  if (!pageId) throw new Error('--page-id requires a value');
  if (!NOTION_PAGE_ID_RE.test(pageId)) {
    throw new Error('--page-id must be a Notion page UUID (32 hex chars, dashes optional)');
  }
  return { pageId };
};

export const main = async (argv: readonly string[]): Promise<void> => {
  const startedAt = new Date();
  const runId = `${startedAt.getTime()}-${randomBytes(2).toString('hex')}`;
  const args = parseArgs(argv);
  logger.info('publish', 'run started', {
    startedAt: startedAt.toISOString(),
    runId,
    pageId: args.pageId,
  });

  let payload: DraftPayload;
  try {
    payload = await fetchPageById(args.pageId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // fetchPageById は 2 種類の理由で throw する。
    //   (a) Status 不整合 (approved 以外 / 未知の status) → 二重発火 / 運用ミス由来、silent return で抑止
    //   (b) 必須 number property が null/NaN (PR B1 で導入) → Notion データ品質バグ、fatal にして気付かせる
    // message に「セール価格」「通常価格」「割引率」のいずれかを含めば (b) と判定。
    const isDataQualityError = /(セール価格|通常価格|割引率)/.test(message);
    if (isDataQualityError) {
      logger.error('publish', 'Notion data quality error, aborting', {
        pageId: args.pageId,
        error: message,
      });
      process.exit(1);
    }
    logger.warn('publish', 'page not eligible for publish', {
      pageId: args.pageId,
      error: message,
    });
    return;
  }

  // 二重ガード: Status=approved だが「投稿日時」がセット済 = 過去に publish 済の row を
  // 何らかの理由で approved に戻したケース (運用ミス / Notion automation 多重発火 race)。
  // Status check (fetchPageById) を擦り抜けるので追加で early return する。
  if (payload.postedAt) {
    logger.warn('publish', 'page already posted, refusing duplicate', {
      pageId: args.pageId,
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
      pageId: args.pageId,
      asin: payload.asin,
    });
    return;
  }

  // 旧実装では `anySucceeded(result)` で 1 つでも成功すれば Status=posted に遷移していたため
  // X 文字数上限超で X 失敗 + Bluesky 成功となり、X 側の silent data loss が発生していた。
  // 本 PR で全 required platform 成功時のみ posted に遷移するよう変更したが、X の文字数上限超は
  // 依然両 SNS の投稿状態を不整合化させる (= X 不投稿で X side が approved に残り、cron で
  // 同 ASIN を再 dispatch する流れに乗せると Bluesky が二重投稿される)。これを避けるため
  // 上限超は publish 全体を refuse し、bon が Notion で 投稿文 を短縮した上で再投稿可能なまま
  // approved に残す方針を維持する。
  if ([...payload.postText].length > POST_TEXT_MAX_CHARS) {
    logger.warn('publish', '投稿文 exceeds X char limit, refusing to post', {
      pageId: args.pageId,
      asin: payload.asin,
      length: [...payload.postText].length,
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
      pageId: args.pageId,
      asin: payload.asin,
      xPosted: payload.xPosted,
      blueskyPosted: payload.blueskyPosted,
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
  await updateStatusToPosted(args.pageId, result, new Date(), links, {
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
