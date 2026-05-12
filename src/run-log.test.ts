import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock @notionhq/client at the module level — vi.mock is hoisted.
const pagesCreateMock = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class MockClient {
    pages = { create: pagesCreateMock };
  },
}));

describe('appendRunLog', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_RUN_LOG_DATA_SOURCE_ID;
  const originalRepo = process.env.GITHUB_REPOSITORY;
  const originalRunId = process.env.GITHUB_RUN_ID;

  const basePayload = {
    runId: '1778547533457-443b',
    startedAt: new Date('2026-05-12T00:58:53.457Z'),
    durationMs: 13_922,
    dealsTotal: 18,
    tokensLeft: 16,
    targetsSelected: 7,
    draftsCreated: 7,
    errorMessage: null,
    notionRetries: 0,
  };

  beforeEach(() => {
    pagesCreateMock.mockReset();
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_RUN_LOG_DATA_SOURCE_ID = 'ds-runlog-456';
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_RUN_ID;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_VUEPRIX_RUN_LOG_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_RUN_LOG_DATA_SOURCE_ID = originalDs;
    if (originalRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepo;
    if (originalRunId === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = originalRunId;
  });

  it('skips silently when NOTION_VUEPRIX_RUN_LOG_DATA_SOURCE_ID is not set', async () => {
    delete process.env.NOTION_VUEPRIX_RUN_LOG_DATA_SOURCE_ID;
    const { appendRunLog } = await import('./run-log.js');
    await expect(
      appendRunLog({ ...basePayload, status: 'success' }),
    ).resolves.toBeUndefined();
    expect(pagesCreateMock).not.toHaveBeenCalled();
  });

  it('skips silently when NOTION_API_KEY is not set', async () => {
    delete process.env.NOTION_API_KEY;
    const { appendRunLog } = await import('./run-log.js');
    await expect(
      appendRunLog({ ...basePayload, status: 'success' }),
    ).resolves.toBeUndefined();
    expect(pagesCreateMock).not.toHaveBeenCalled();
  });

  it('writes a row with success status and all properties', async () => {
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-runlog-1' });
    const { appendRunLog } = await import('./run-log.js');
    await appendRunLog({ ...basePayload, status: 'success' });
    expect(pagesCreateMock).toHaveBeenCalledTimes(1);
    const arg = pagesCreateMock.mock.calls[0]?.[0] as {
      parent: unknown;
      properties: Record<string, unknown>;
    };
    expect(arg.parent).toEqual({ type: 'data_source_id', data_source_id: 'ds-runlog-456' });
    expect(arg.properties.name).toEqual({
      title: [{ type: 'text', text: { content: '1778547533457-443b' } }],
    });
    expect(arg.properties.started_at).toEqual({ date: { start: '2026-05-12T00:58:53.457Z' } });
    expect(arg.properties.duration_ms).toEqual({ number: 13_922 });
    expect(arg.properties.status).toEqual({ select: { name: 'success' } });
    expect(arg.properties.deals_total).toEqual({ number: 18 });
    expect(arg.properties.tokens_left).toEqual({ number: 16 });
    expect(arg.properties.targets_selected).toEqual({ number: 7 });
    expect(arg.properties.drafts_created).toEqual({ number: 7 });
    expect(arg.properties.notion_retries).toEqual({ number: 0 });
    // errorMessage が null のときは error_message property が省略される
    expect(arg.properties.error_message).toBeUndefined();
    // GHA env 未設定なので gha_run_url も省略
    expect(arg.properties.gha_run_url).toBeUndefined();
  });

  it('omits tokens_left when null', async () => {
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-runlog-2' });
    const { appendRunLog } = await import('./run-log.js');
    await appendRunLog({ ...basePayload, status: 'success', tokensLeft: null });
    const arg = pagesCreateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.tokens_left).toBeUndefined();
  });

  it('writes failure row with truncated error_message', async () => {
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-runlog-3' });
    const longError = 'x'.repeat(3000);
    const { appendRunLog } = await import('./run-log.js');
    await appendRunLog({
      ...basePayload,
      status: 'failure',
      errorMessage: longError,
      draftsCreated: 0,
    });
    const arg = pagesCreateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.status).toEqual({ select: { name: 'failure' } });
    const errorProp = arg.properties.error_message as {
      rich_text: Array<{ text: { content: string } }>;
    };
    expect(errorProp.rich_text[0]?.text.content.length).toBe(1900);
  });

  it('includes gha_run_url when GitHub Actions env is set', async () => {
    process.env.GITHUB_REPOSITORY = 'bon-clevique/vueprix';
    process.env.GITHUB_RUN_ID = '25706600219';
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-runlog-4' });
    const { appendRunLog } = await import('./run-log.js');
    await appendRunLog({ ...basePayload, status: 'success' });
    const arg = pagesCreateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.gha_run_url).toEqual({
      url: 'https://github.com/bon-clevique/vueprix/actions/runs/25706600219',
    });
  });

  it('does not throw when Notion API call fails (best-effort)', async () => {
    pagesCreateMock.mockRejectedValueOnce(new Error('Notion timeout'));
    const { appendRunLog } = await import('./run-log.js');
    await expect(
      appendRunLog({ ...basePayload, status: 'success' }),
    ).resolves.toBeUndefined();
    expect(pagesCreateMock).toHaveBeenCalledTimes(1);
  });
});
