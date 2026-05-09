import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { PostHistoryEntry } from './history.js';

// Mock @notionhq/client at the module level — vi.mock is hoisted.
const pagesCreateMock = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class MockClient {
    pages = { create: pagesCreateMock };
  },
}));

const baseEntry = (overrides: Partial<PostHistoryEntry> = {}): PostHistoryEntry => ({
  timestamp: '2026-05-09T12:00:00.000Z',
  runId: 'r-1',
  asin: 'B000',
  title: 'sample product',
  currentPrice: 850,
  referencePrice: 1000,
  dropPercent: 15,
  source: 'fixed',
  reason: 'test reason',
  dryRun: true,
  posters: { x: true, bluesky: true },
  ...overrides,
});

describe('appendPostToNotion', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;

  beforeEach(() => {
    pagesCreateMock.mockReset();
    delete process.env.NOTION_API_KEY;
    delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = originalDs;
  });

  it('skips when env not configured (no Notion call)', async () => {
    const { appendPostToNotion } = await import('./notion.js');
    await appendPostToNotion(baseEntry(), 'post text');
    expect(pagesCreateMock).not.toHaveBeenCalled();
  });

  it('skips when only NOTION_API_KEY is set without data source id', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    const { appendPostToNotion } = await import('./notion.js');
    await appendPostToNotion(baseEntry(), 'post text');
    expect(pagesCreateMock).not.toHaveBeenCalled();
  });

  it('calls pages.create with expected database_id and properties when configured', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-1' });

    const { appendPostToNotion } = await import('./notion.js');
    await appendPostToNotion(
      baseEntry({ title: 'カリタ コーヒーフィルター', reason: '朝のコーヒーに', dryRun: true }),
      '【値下がり】カリタ...全文',
    );

    expect(pagesCreateMock).toHaveBeenCalledTimes(1);
    const arg = pagesCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.parent).toEqual({ type: 'database_id', database_id: 'ds-uuid-123' });
    const props = arg.properties as Record<string, unknown>;
    expect(props['名前']).toBeDefined();
    expect(props['理由']).toBeDefined();
    expect(props.DryRun).toEqual({ checkbox: true });
  });

  it('prefixes [DRY RUN] in body when dryRun=true', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-1' });

    const { appendPostToNotion } = await import('./notion.js');
    await appendPostToNotion(baseEntry({ dryRun: true }), 'POST_BODY');

    const arg = pagesCreateMock.mock.calls[0]?.[0] as { children: Array<{ paragraph: { rich_text: Array<{ text: { content: string } }> } }> };
    const bodyContent = arg.children[0]?.paragraph.rich_text[0]?.text.content ?? '';
    expect(bodyContent.startsWith('[DRY RUN]\n')).toBe(true);
    expect(bodyContent).toContain('POST_BODY');
  });

  it('does not prefix [DRY RUN] when dryRun=false', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-1' });

    const { appendPostToNotion } = await import('./notion.js');
    await appendPostToNotion(baseEntry({ dryRun: false }), 'POST_BODY');

    const arg = pagesCreateMock.mock.calls[0]?.[0] as { children: Array<{ paragraph: { rich_text: Array<{ text: { content: string } }> } }> };
    const bodyContent = arg.children[0]?.paragraph.rich_text[0]?.text.content ?? '';
    expect(bodyContent.startsWith('[DRY RUN]')).toBe(false);
    expect(bodyContent).toBe('POST_BODY');
  });

  it('does not throw when Notion API fails (logs and continues)', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
    pagesCreateMock.mockRejectedValueOnce(Object.assign(new Error('API unavailable'), { status: 503, code: 'service_unavailable' }));

    const { appendPostToNotion } = await import('./notion.js');
    await expect(appendPostToNotion(baseEntry(), 'POST_BODY')).resolves.toBeUndefined();
  });

  it('truncates very long title to 200 chars', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-1' });

    const longTitle = 'あ'.repeat(500);
    const { appendPostToNotion } = await import('./notion.js');
    await appendPostToNotion(baseEntry({ title: longTitle }), 'body');

    const arg = pagesCreateMock.mock.calls[0]?.[0] as { properties: { '名前': { title: Array<{ text: { content: string } }> } } };
    const titleContent = arg.properties['名前'].title[0]?.text.content ?? '';
    expect([...titleContent].length).toBeLessThanOrEqual(200);
  });

  it('does not split surrogate pairs (emoji / supplementary CJK)', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-1' });

    // 😀 = 1 grapheme but 2 UTF-16 code units. naive slice() at odd boundary breaks it.
    const emojiTitle = '😀'.repeat(300);
    const { appendPostToNotion } = await import('./notion.js');
    await appendPostToNotion(baseEntry({ title: emojiTitle }), 'body');

    const arg = pagesCreateMock.mock.calls[0]?.[0] as { properties: { '名前': { title: Array<{ text: { content: string } }> } } };
    const titleContent = arg.properties['名前'].title[0]?.text.content ?? '';
    // 結果は 200 文字 (絵文字数) 以内で、replacement char (U+FFFD) を含まない
    expect([...titleContent].length).toBeLessThanOrEqual(200);
    expect(titleContent).not.toContain('�');
  });
});
