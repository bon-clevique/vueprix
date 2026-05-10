import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { PostHistoryEntry } from './history.js';

// Mock @notionhq/client at the module level — vi.mock is hoisted.
const pagesCreateMock = vi.fn();
const dataSourcesQueryMock = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class MockClient {
    pages = { create: pagesCreateMock };
    dataSources = { query: dataSourcesQueryMock };
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
  category: 'fixed-list',
  reason: 'test reason',
  dryRun: true,
  posters: { x: true, bluesky: true },
  ...overrides,
});

describe('appendPostToNotion', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
  const originalPartnerTag = process.env.PAAPI_PARTNER_TAG;

  beforeEach(() => {
    pagesCreateMock.mockReset();
    delete process.env.NOTION_API_KEY;
    delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    delete process.env.PAAPI_PARTNER_TAG;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = originalDs;
    if (originalPartnerTag === undefined) delete process.env.PAAPI_PARTNER_TAG;
    else process.env.PAAPI_PARTNER_TAG = originalPartnerTag;
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

  it('sets all 12 properties (名前, 理由, ASIN, Amazon URL, 通常価格, セール価格, 割引率, カテゴリ, サクラチェッカーURL, 候補生成日時, Status, DryRun)', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
    process.env.PAAPI_PARTNER_TAG = 'vueprix-22';
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-1' });

    const { appendPostToNotion } = await import('./notion.js');
    await appendPostToNotion(
      baseEntry({
        asin: 'B0FKLMMS2G',
        currentPrice: 3569,
        referencePrice: 8609,
        dropPercent: 59,
        dryRun: true,
        category: 'food',
        timestamp: '2026-05-09T12:00:00.000Z',
      }),
      'POST_BODY',
    );

    expect(pagesCreateMock).toHaveBeenCalledTimes(1);
    const arg = pagesCreateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    const props = arg.properties;

    // existence check for 名前 / 理由 (existing assertion preserved)
    expect(props['名前']).toBeDefined();
    expect(props['理由']).toBeDefined();

    // ASIN: rich_text content === 'B0FKLMMS2G'
    const asinProp = props.ASIN as { rich_text: Array<{ text: { content: string } }> };
    expect(asinProp.rich_text[0]?.text.content).toBe('B0FKLMMS2G');

    // Amazon URL: affiliate URL with partner tag
    expect(props['Amazon URL']).toEqual({ url: 'https://www.amazon.co.jp/dp/B0FKLMMS2G?tag=vueprix-22' });

    // numeric properties
    expect(props['通常価格']).toEqual({ number: 8609 });
    expect(props['セール価格']).toEqual({ number: 3569 });
    expect(props['割引率']).toEqual({ number: 0.59 });

    // select properties
    expect(props['カテゴリ']).toEqual({ select: { name: 'food' } });
    expect(props.Status).toEqual({ select: { name: 'pending_review' } });

    // url & date properties
    expect(props['サクラチェッカーURL']).toEqual({ url: 'https://sakura-checker.jp/search/B0FKLMMS2G/' });
    expect(props['候補生成日時']).toEqual({ date: { start: '2026-05-09T12:00:00.000Z' } });

    // checkbox
    expect(props.DryRun).toEqual({ checkbox: true });
  });

  it('uses entry.category for カテゴリ select (food/health/fixed-list)', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
    process.env.PAAPI_PARTNER_TAG = 'vueprix-22';

    const { appendPostToNotion } = await import('./notion.js');
    const categories: Array<'food' | 'health' | 'fixed-list'> = ['food', 'health', 'fixed-list'];

    for (const category of categories) {
      pagesCreateMock.mockResolvedValueOnce({ id: `page-${category}` });
      await appendPostToNotion(baseEntry({ category }), 'POST_BODY');
    }

    expect(pagesCreateMock).toHaveBeenCalledTimes(3);
    const callArgs = pagesCreateMock.mock.calls.map(
      (call) => (call[0] as { properties: Record<string, unknown> }).properties,
    );
    expect((callArgs[0]?.['カテゴリ'])).toEqual({ select: { name: 'food' } });
    expect((callArgs[1]?.['カテゴリ'])).toEqual({ select: { name: 'health' } });
    expect((callArgs[2]?.['カテゴリ'])).toEqual({ select: { name: 'fixed-list' } });
  });

  it('Amazon URL is null when PAAPI_PARTNER_TAG is not set', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
    delete process.env.PAAPI_PARTNER_TAG;
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-1' });

    const { appendPostToNotion } = await import('./notion.js');
    await appendPostToNotion(baseEntry({ asin: 'B0FKLMMS2G' }), 'POST_BODY');

    // fail-soft: page creation still succeeds (mock invoked)
    expect(pagesCreateMock).toHaveBeenCalledTimes(1);
    const arg = pagesCreateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties['Amazon URL']).toEqual({ url: null });
  });
});

describe('fetchActiveGuidelines', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalGuidelinesDs = process.env.NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID;

  beforeEach(() => {
    dataSourcesQueryMock.mockReset();
    delete process.env.NOTION_API_KEY;
    delete process.env.NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalGuidelinesDs === undefined) delete process.env.NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID = originalGuidelinesDs;
  });

  it('returns empty array when env not configured', async () => {
    const { fetchActiveGuidelines } = await import('./notion.js');
    const result = await fetchActiveGuidelines();
    expect(result).toEqual([]);
    expect(dataSourcesQueryMock).not.toHaveBeenCalled();
  });

  it('queries with Active=true filter and parses title + tags', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID = 'guidelines-ds-id';
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: [
        {
          properties: {
            '名前': {
              type: 'title',
              title: [{ plain_text: '食品カテゴリでは「ふだんの食卓」を優先' }],
            },
            Active: { type: 'checkbox', checkbox: true },
            Tags: {
              type: 'multi_select',
              multi_select: [{ name: 'food' }, { name: 'general' }],
            },
          },
        },
        {
          properties: {
            '名前': {
              type: 'title',
              title: [{ plain_text: '醤油・出汁系では味の表現を1単語入れる' }],
            },
            Active: { type: 'checkbox', checkbox: true },
            Tags: { type: 'multi_select', multi_select: [] },
          },
        },
      ],
    });

    const { fetchActiveGuidelines } = await import('./notion.js');
    const result = await fetchActiveGuidelines();

    expect(dataSourcesQueryMock).toHaveBeenCalledTimes(1);
    const arg = dataSourcesQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.data_source_id).toBe('guidelines-ds-id');
    expect(arg.filter).toEqual({ property: 'Active', checkbox: { equals: true } });
    expect(result).toEqual([
      { text: '食品カテゴリでは「ふだんの食卓」を優先', tags: ['food', 'general'] },
      { text: '醤油・出汁系では味の表現を1単語入れる', tags: [] },
    ]);
  });

  it('skips guidelines with empty title', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID = 'guidelines-ds-id';
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: [
        {
          properties: {
            '名前': { type: 'title', title: [] },
            Active: { type: 'checkbox', checkbox: true },
          },
        },
        {
          properties: {
            '名前': { type: 'title', title: [{ plain_text: 'valid' }] },
            Active: { type: 'checkbox', checkbox: true },
          },
        },
      ],
    });
    const { fetchActiveGuidelines } = await import('./notion.js');
    const result = await fetchActiveGuidelines();
    expect(result).toEqual([{ text: 'valid', tags: [] }]);
  });

  it('returns empty array on API error (does not throw)', async () => {
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_GUIDELINES_DATA_SOURCE_ID = 'guidelines-ds-id';
    dataSourcesQueryMock.mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { status: 404, code: 'object_not_found' }),
    );
    const { fetchActiveGuidelines } = await import('./notion.js');
    await expect(fetchActiveGuidelines()).resolves.toEqual([]);
  });
});
