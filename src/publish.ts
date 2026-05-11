import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { appendHistory } from './history.js';
import { logger } from './logger.js';
import {
  fetchPageById,
  updateStatusToPosted,
  type DraftPayload,
} from './notion.js';
import { anySucceeded, dispatch, posters, type PostInput } from './posters/index.js';

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
    // approved 以外で fetchPageById は throw する。二重発火 (既に posted) 等を early return で扱う。
    logger.warn('publish', 'page not eligible for publish', {
      pageId: args.pageId,
      error: err instanceof Error ? err.message : String(err),
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

  // X の文字数上限 (280) を超える 投稿文 が Notion に書かれた場合、X は API エラー、Bluesky は成功する
  // (Bluesky 300 chars 上限内のため)。anySucceeded(result) が true になり Status=posted に遷移し、
  // X への投稿は永久に失われる silent data loss が発生する。両 SNS に確実に投稿する目的を守るため
  // 280 chars 超は publish 全体を refuse する (再投稿可能なまま approved に残す)。
  const POST_TEXT_MAX_CHARS = 280;
  if ([...payload.postText].length > POST_TEXT_MAX_CHARS) {
    logger.warn('publish', '投稿文 exceeds X char limit, refusing to post', {
      pageId: args.pageId,
      asin: payload.asin,
      length: [...payload.postText].length,
      limit: POST_TEXT_MAX_CHARS,
    });
    return;
  }

  const input: PostInput = { asin: payload.asin, text: payload.postText };
  const result = await dispatch(posters, input);
  const succeeded = anySucceeded(result);
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
    posters: result,
  };
  await appendHistory(historyEntry);

  if (succeeded) {
    await updateStatusToPosted(args.pageId, new Date());
    logger.info('publish', 'run finished', {
      durationMs: Date.now() - startedAt.getTime(),
      asin: payload.asin,
      result,
    });
  } else {
    // 全 poster 失敗時は Status を posted に更新しない (再実行で再試行できるよう approved のまま残す)。
    logger.warn('publish', 'all posters failed, leaving status=approved for retry', {
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
