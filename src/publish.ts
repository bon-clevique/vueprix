import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { buildAffiliateUrl, requirePartnerTag } from './affiliate.js';
import { appendHistory } from './history.js';
import { logger } from './logger.js';
import { fetchPageById, updateStatusToPosted, type DraftPayload } from './notion.js';
import type { ProductInfo } from './paapi.js';
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

// HIGH (code) 対応: PAAPI_PARTNER_TAG 未設定時の silent fallback を廃止。
// Notion 側に Amazon URL があればそれを優先、なければ requirePartnerTag() で fail-fast。
const buildProductFromPayload = (payload: DraftPayload): ProductInfo => ({
  asin: payload.asin,
  title: payload.title,
  imageUrl: '',
  currentPrice: payload.currentPrice,
  affiliateUrl: payload.amazonUrl ?? buildAffiliateUrl(payload.asin, requirePartnerTag()),
});

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

  const product = buildProductFromPayload(payload);
  const input: PostInput = {
    product,
    reason: payload.reason,
    referencePrice: payload.referencePrice,
    dropPercent: payload.dropPercent,
  };

  // DryRun=true の page は実投稿せず Status=posted に更新するだけ (テスト用の動作)。
  if (payload.dryRun) {
    logger.info('publish', 'dryRun page, skipping posters and marking posted', {
      pageId: args.pageId,
      asin: payload.asin,
    });
    await updateStatusToPosted(args.pageId, new Date());
    return;
  }

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
    reason: payload.reason,
    dryRun: false,
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
