import { Client } from '@notionhq/client';
import { logger } from './logger.js';
import type { PostHistoryEntry } from './history.js';

// Notion DB「vueprix 投稿文」へ 1 投稿対象 1 ページとして append。
// jsonl の append と並行して呼ばれる補助記録。Notion 失敗で投稿フローを止めない。
//
// DB schema (最小設計):
//   - 名前 (title): 商品名
//   - 理由 (rich_text): Claude 生成 reason
//   - DryRun (checkbox): DRY_RUN 区別用
//   - page 本文: SNS 投稿全文 1 paragraph block
//
// 環境変数:
//   - NOTION_API_KEY: integration の internal token
//   - NOTION_VUEPRIX_DATA_SOURCE_ID: DB の data_source_id (URL 末尾の UUID)

// 1 rich_text/title element 上限は Notion 側 2000 chars。安全マージンで 1900 にする。
const NOTION_TEXT_LIMIT = 1900;
// spread + slice + join で UTF-16 surrogate pair (絵文字 / 補助 CJK) safe な切り詰め。
// history.ts の truncateTitle と同パターン。
const truncate = (text: string, max = NOTION_TEXT_LIMIT): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

const isConfigured = (): boolean =>
  Boolean(process.env.NOTION_API_KEY) && Boolean(process.env.NOTION_VUEPRIX_DATA_SOURCE_ID);

export const appendPostToNotion = async (
  entry: PostHistoryEntry,
  postText: string,
): Promise<void> => {
  if (!isConfigured()) {
    logger.info('notion', 'NOTION env not configured, skipping (jsonl-only mode)');
    return;
  }
  const dataSourceId = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID as string;
  const bodyText = entry.dryRun ? `[DRY RUN]\n${postText}` : postText;
  // Client を local で都度生成: env 変更を即反映 + module singleton 経由のテスト分離リスクを回避。
  // 実 cron では 1 run あたり 2 件、立ち上げコスト無視できる。
  const client = new Client({
    auth: process.env.NOTION_API_KEY,
    notionVersion: '2026-03-11',
  });
  try {
    await client.pages.create({
      parent: { type: 'database_id', database_id: dataSourceId },
      properties: {
        '名前': {
          title: [{ type: 'text', text: { content: truncate(entry.title, 200) } }],
        },
        '理由': {
          rich_text: [{ type: 'text', text: { content: truncate(entry.reason) } }],
        },
        DryRun: {
          checkbox: entry.dryRun,
        },
      },
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: truncate(bodyText) } }],
          },
        },
      ],
    });
    logger.info('notion', 'page appended', { asin: entry.asin });
  } catch (err) {
    const status = (err as { status?: number }).status;
    const code = (err as { code?: string }).code;
    logger.error('notion', 'append failed (continuing)', {
      asin: entry.asin,
      status: status ?? null,
      code: code ?? null,
      type: err instanceof Error ? err.constructor.name : typeof err,
    });
  }
};
