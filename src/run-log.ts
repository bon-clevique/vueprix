import { Client } from '@notionhq/client';
import { logger } from './logger.js';

// Notion run-log DB に各 cron run を 1 row として書き込む best-effort module。
// schema は Notion DB「Run logs」(data_source_id は env で指定) に対応。
// 書き込み失敗は draft.ts の exit code に影響させない (catch + log)。
//
// 関連:
//   - schema: NOTION_VUEPRIX_RUN_LOG_DATA_SOURCE_ID DB の properties (name/started_at/duration_ms/
//     status/deals_total/tokens_left/targets_selected/drafts_created/error_message/notion_retries/
//     gha_run_url) と本ファイルの property 書き込みは 1:1 対応している
//   - 呼び出し元: src/draft.ts main() の finally ブロック
//   - retry: 書き込み自体は最大 2 attempts (短命 timeout で run 全体を止めないため)

export type RunStatus = 'success' | 'partial' | 'failure';

export interface RunLogPayload {
  runId: string;
  startedAt: Date;
  durationMs: number;
  status: RunStatus;
  dealsTotal: number;
  tokensLeft: number | null;
  targetsSelected: number;
  draftsCreated: number;
  errorMessage: string | null;
  notionRetries: number;
}

const ERROR_MESSAGE_MAX_CHARS = 1900;

const buildGhaRunUrl = (): string | null => {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repo || !runId) return null;
  return `https://github.com/${repo}/actions/runs/${runId}`;
};

export const appendRunLog = async (payload: RunLogPayload): Promise<void> => {
  const dataSourceId = process.env.NOTION_VUEPRIX_RUN_LOG_DATA_SOURCE_ID;
  if (!dataSourceId || !process.env.NOTION_API_KEY) {
    logger.warn('run-log', 'env not set, skipping', {
      hasApiKey: Boolean(process.env.NOTION_API_KEY),
      hasDataSourceId: Boolean(dataSourceId),
    });
    return;
  }
  try {
    const client = new Client({
      auth: process.env.NOTION_API_KEY,
      notionVersion: '2026-03-11',
      timeoutMs: 15_000,
      retry: { maxRetries: 2, initialRetryDelayMs: 1_000, maxRetryDelayMs: 4_000 },
    });
    const ghaUrl = buildGhaRunUrl();
    const truncatedError = payload.errorMessage
      ? payload.errorMessage.slice(0, ERROR_MESSAGE_MAX_CHARS)
      : null;
    await client.pages.create({
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: {
        name: { title: [{ type: 'text', text: { content: payload.runId } }] },
        started_at: { date: { start: payload.startedAt.toISOString() } },
        duration_ms: { number: payload.durationMs },
        status: { select: { name: payload.status } },
        deals_total: { number: payload.dealsTotal },
        ...(payload.tokensLeft !== null
          ? { tokens_left: { number: payload.tokensLeft } }
          : {}),
        targets_selected: { number: payload.targetsSelected },
        drafts_created: { number: payload.draftsCreated },
        ...(truncatedError
          ? {
              error_message: {
                rich_text: [{ type: 'text', text: { content: truncatedError } }],
              },
            }
          : {}),
        notion_retries: { number: payload.notionRetries },
        ...(ghaUrl ? { gha_run_url: { url: ghaUrl } } : {}),
      },
    });
    logger.info('run-log', 'appended', {
      runId: payload.runId,
      status: payload.status,
      draftsCreated: payload.draftsCreated,
    });
  } catch (err) {
    logger.error('run-log', 'append failed (non-fatal)', {
      runId: payload.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
