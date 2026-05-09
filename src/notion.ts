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
//   - NOTION_VUEPRIX_DATA_SOURCE_ID: 投稿文 DB の Database ID (URL 末尾)
//   - NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID: トーンガイドライン DB の Database ID (任意)

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

export interface Guideline {
  text: string;
  tags: string[];
}

const buildClient = (): Client =>
  new Client({
    auth: process.env.NOTION_API_KEY,
    notionVersion: '2026-03-11',
  });

const isGuidelinesConfigured = (): boolean =>
  Boolean(process.env.NOTION_API_KEY) && Boolean(process.env.NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID);

interface NotionRichText {
  plain_text?: string;
}

interface NotionMultiSelectOption {
  name?: string;
}

interface NotionGuidelinePropsTitle {
  type: 'title';
  title?: NotionRichText[];
}

interface NotionGuidelinePropsCheckbox {
  type: 'checkbox';
  checkbox?: boolean;
}

interface NotionGuidelinePropsMultiSelect {
  type: 'multi_select';
  multi_select?: NotionMultiSelectOption[];
}

type NotionGuidelineProperty =
  | NotionGuidelinePropsTitle
  | NotionGuidelinePropsCheckbox
  | NotionGuidelinePropsMultiSelect
  | { type: string };

interface NotionGuidelinePage {
  properties: Record<string, NotionGuidelineProperty>;
}

const extractTitle = (page: NotionGuidelinePage): string => {
  const titleProp = Object.values(page.properties).find((p) => p.type === 'title') as NotionGuidelinePropsTitle | undefined;
  if (!titleProp || !titleProp.title) return '';
  return titleProp.title.map((t) => t.plain_text ?? '').join('').trim();
};

const extractTags = (page: NotionGuidelinePage): string[] => {
  const tagsProp = page.properties.Tags as NotionGuidelinePropsMultiSelect | undefined;
  if (!tagsProp || tagsProp.type !== 'multi_select' || !tagsProp.multi_select) return [];
  return tagsProp.multi_select
    .map((t) => t.name ?? '')
    .filter((name): name is string => name.length > 0);
};

// vueprix トーンガイドライン DB から Active=true なルールを取得し、Title (= ルール本文) と Tags を返す。
// Notion 未設定 / 失敗時は空配列で fail-soft (claude の system prompt 注入が省略されるだけ)。
export const fetchActiveGuidelines = async (): Promise<Guideline[]> => {
  if (!isGuidelinesConfigured()) {
    logger.info('notion', 'guidelines DB not configured, skipping');
    return [];
  }
  const dataSourceId = process.env.NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID as string;
  try {
    const client = buildClient();
    // Notion API v2026-03-11: 旧 databases.query は廃止、dataSources.query に移行。
    // Active=true で filter、最大 100 件 (Notion API の page_size 上限)。
    const res = await client.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        property: 'Active',
        checkbox: { equals: true },
      },
      page_size: 100,
    });
    const guidelines: Guideline[] = (res.results as unknown as NotionGuidelinePage[])
      .map((page) => ({
        text: extractTitle(page),
        tags: extractTags(page),
      }))
      .filter((g) => g.text.length > 0);
    logger.info('notion', 'guidelines fetched', { count: guidelines.length });
    if (guidelines.length > 20) {
      logger.warn('notion', 'large guidelines count may inflate Claude prompt tokens', {
        count: guidelines.length,
      });
    }
    return guidelines;
  } catch (err) {
    const status = (err as { status?: number }).status;
    const code = (err as { code?: string }).code;
    logger.error('notion', 'guidelines fetch failed (continuing with empty list)', {
      status: status ?? null,
      code: code ?? null,
      type: err instanceof Error ? err.constructor.name : typeof err,
    });
    return [];
  }
};

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
  const client = buildClient();
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
