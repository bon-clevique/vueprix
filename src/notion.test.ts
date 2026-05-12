import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock @notionhq/client at the module level — vi.mock is hoisted.
const pagesCreateMock = vi.fn();
const pagesUpdateMock = vi.fn();
const pagesRetrieveMock = vi.fn();
const dataSourcesQueryMock = vi.fn();
const blocksAppendMock = vi.fn();
// Client constructor 引数を観測するための spy。retry / timeoutMs option が
// notion.ts の buildClient() で正しく渡っていることを assert する。
const clientCtorSpy = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class MockClient {
    constructor(options?: unknown) {
      clientCtorSpy(options);
    }
    pages = { create: pagesCreateMock, update: pagesUpdateMock, retrieve: pagesRetrieveMock };
    dataSources = { query: dataSourcesQueryMock };
    blocks = { children: { append: blocksAppendMock } };
  },
}));

describe('createDraftPage', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;

  beforeEach(() => {
    pagesCreateMock.mockReset();
    clientCtorSpy.mockReset();
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = originalDs;
  });

  it('creates page with Status=backlog and returns page id', async () => {
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-abc' });
    const { createDraftPage } = await import('./notion.js');
    const id = await createDraftPage({
      asin: 'B0FKLMMS2G',
      title: 'sample',
      postText: 'unified post text',
      amazonUrl: 'https://www.amazon.co.jp/dp/B0FKLMMS2G?tag=t-22',
      currentPrice: 850,
      referencePrice: 1000,
      dropPercent: 15,
      category: 'food',
      generatedAt: new Date('2026-05-09T12:00:00.000Z'),
    });
    expect(id).toBe('page-abc');
    expect(pagesCreateMock).toHaveBeenCalledTimes(1);
    // buildClient() が timeoutMs / retry option を Client に渡していることを assert。
    // 9:58 JST 2026-05-12 の Notion API request_timeout を retry でしのぐための regression。
    const ctorArg = clientCtorSpy.mock.calls[0]?.[0] as {
      timeoutMs?: number;
      retry?: { maxRetries?: number };
    };
    expect(ctorArg.timeoutMs).toBe(30_000);
    expect(ctorArg.retry).toEqual({
      maxRetries: 3,
      initialRetryDelayMs: 1_000,
      maxRetryDelayMs: 8_000,
    });
    const arg = pagesCreateMock.mock.calls[0]?.[0] as {
      parent: unknown;
      properties: Record<string, unknown>;
    };
    expect(arg.parent).toEqual({ type: 'data_source_id', data_source_id: 'ds-uuid-123' });
    expect(arg.properties.Status).toEqual({ status: { name: 'backlog' } });
    expect(arg.properties.ASIN).toEqual({ rich_text: [{ type: 'text', text: { content: 'B0FKLMMS2G' } }] });
    expect(arg.properties['投稿文']).toEqual({ rich_text: [{ type: 'text', text: { content: 'unified post text' } }] });
    expect(arg.properties['Amazon URL']).toEqual({ url: 'https://www.amazon.co.jp/dp/B0FKLMMS2G?tag=t-22' });
    expect(arg.properties['通常価格']).toEqual({ number: 1000 });
    expect(arg.properties['セール価格']).toEqual({ number: 850 });
    expect(arg.properties['割引率']).toEqual({ number: 0.15 });
    expect(arg.properties['カテゴリ']).toEqual({ select: { name: 'food' } });
    expect(arg.properties['サクラチェッカーURL']).toEqual({ url: 'https://sakura-checker.jp/search/B0FKLMMS2G/' });
    expect(arg.properties['候補生成日時']).toEqual({ date: { start: '2026-05-09T12:00:00.000Z' } });
    // Statutory: 削除済 property は書き込まれない
    expect(arg.properties['理由']).toBeUndefined();
    expect(arg.properties['投稿文_X']).toBeUndefined();
    expect(arg.properties['投稿文_Bluesky']).toBeUndefined();
  });

  it('throws when env not configured', async () => {
    delete process.env.NOTION_API_KEY;
    delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    const { createDraftPage } = await import('./notion.js');
    await expect(
      createDraftPage({
        asin: 'B0',
        title: 't',
        postText: '',
        amazonUrl: null,
        currentPrice: 0,
        referencePrice: 0,
        dropPercent: 0,
        category: 'food',
        generatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe('updateStatusToPosted', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;

  beforeEach(() => {
    pagesUpdateMock.mockReset();
    blocksAppendMock.mockReset();
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = originalDs;
  });

  it('updates Status=posted with 投稿日時 timestamp', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    const { updateStatusToPosted } = await import('./notion.js');
    await updateStatusToPosted('page-1', new Date('2026-05-09T14:00:00.000Z'));
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { page_id: string; properties: Record<string, unknown> };
    expect(arg.page_id).toBe('page-1');
    // PR-8: Status は status type
    expect(arg.properties.Status).toEqual({ status: { name: 'posted' } });
    expect(arg.properties['投稿日時']).toEqual({ date: { start: '2026-05-09T14:00:00.000Z' } });
    // links 未指定なら bookmark append は呼ばれない
    expect(blocksAppendMock).not.toHaveBeenCalled();
  });

  it('appends X / Bluesky bookmark blocks when links are provided', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    blocksAppendMock.mockResolvedValueOnce({});
    const { updateStatusToPosted } = await import('./notion.js');
    await updateStatusToPosted('page-1', new Date('2026-05-09T14:00:00.000Z'), {
      x: 'https://twitter.com/i/web/status/123',
      bluesky: 'https://bsky.app/profile/vueprix.bsky.social/post/abc',
    });
    expect(blocksAppendMock).toHaveBeenCalledTimes(1);
    const arg = blocksAppendMock.mock.calls[0]?.[0] as {
      block_id: string;
      children: Array<{ type: string; bookmark: { url: string } }>;
    };
    expect(arg.block_id).toBe('page-1');
    expect(arg.children).toEqual([
      { object: 'block', type: 'bookmark', bookmark: { url: 'https://twitter.com/i/web/status/123' } },
      { object: 'block', type: 'bookmark', bookmark: { url: 'https://bsky.app/profile/vueprix.bsky.social/post/abc' } },
    ]);
  });

  it('appends only the available link when one poster URL is missing', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    blocksAppendMock.mockResolvedValueOnce({});
    const { updateStatusToPosted } = await import('./notion.js');
    await updateStatusToPosted('page-1', new Date('2026-05-09T14:00:00.000Z'), {
      x: 'https://twitter.com/i/web/status/123',
    });
    expect(blocksAppendMock).toHaveBeenCalledTimes(1);
    const arg = blocksAppendMock.mock.calls[0]?.[0] as { children: unknown[] };
    expect(arg.children).toHaveLength(1);
  });

  it('does not call blocks.append when no links are provided', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    const { updateStatusToPosted } = await import('./notion.js');
    await updateStatusToPosted('page-1', new Date('2026-05-09T14:00:00.000Z'), {});
    expect(blocksAppendMock).not.toHaveBeenCalled();
  });
});

describe('fetchPageById', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;

  beforeEach(() => {
    pagesRetrieveMock.mockReset();
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = originalDs;
  });

  const buildPage = (status: string, overrides: Record<string, unknown> = {}) => ({
    id: 'page-1',
    properties: {
      Status: { status: { name: status } },
      ASIN: { rich_text: [{ plain_text: 'B0FKL' }] },
      '名前': { title: [{ plain_text: 'sample title' }] },
      '投稿文': { rich_text: [{ plain_text: 'unified post text' }] },
      'Amazon URL': { url: 'https://amzn.example/B0FKL' },
      'セール価格': { number: 850 },
      '通常価格': { number: 1000 },
      '割引率': { number: 0.15 },
      'カテゴリ': { select: { name: 'food' } },
      ...overrides,
    },
  });

  it('returns DraftPayload when Status=approved', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildPage('approved'));
    const { fetchPageById } = await import('./notion.js');
    const payload = await fetchPageById('page-1');
    expect(payload).toEqual({
      pageId: 'page-1',
      asin: 'B0FKL',
      title: 'sample title',
      postText: 'unified post text',
      amazonUrl: 'https://amzn.example/B0FKL',
      currentPrice: 850,
      referencePrice: 1000,
      dropPercent: 15,
      category: 'food',
      postedAt: null,
    });
  });

  it('extracts postedAt when 投稿日時 is set on the page', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildPage('approved', {
        '投稿日時': { date: { start: '2026-05-09T14:00:00.000Z' } },
      }),
    );
    const { fetchPageById } = await import('./notion.js');
    const payload = await fetchPageById('page-1');
    expect(payload.postedAt).toBe('2026-05-09T14:00:00.000Z');
  });

  it('postedAt is null when 投稿日時 property is absent', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildPage('approved'));
    const { fetchPageById } = await import('./notion.js');
    const payload = await fetchPageById('page-1');
    expect(payload.postedAt).toBeNull();
  });

  it('postedAt is null when 投稿日時 date.start is empty string (publish guard reinforcement)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildPage('approved', {
        '投稿日時': { date: { start: '' } },
      }),
    );
    const { fetchPageById } = await import('./notion.js');
    const payload = await fetchPageById('page-1');
    expect(payload.postedAt).toBeNull();
  });

  it('throws on unknown Status value (membership check via type guard)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildPage('weird_value'));
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/not a known Status value/);
  });

  it('throws on empty Status value', async () => {
    pagesRetrieveMock.mockResolvedValueOnce({
      id: 'page-1',
      properties: {
        Status: { status: null },
        ASIN: { rich_text: [{ plain_text: 'B0FKL' }] },
        '名前': { title: [{ plain_text: 'x' }] },
        '投稿文': { rich_text: [{ plain_text: '' }] },
        'Amazon URL': { url: null },
        'セール価格': { number: 0 },
        '通常価格': { number: 0 },
        '割引率': { number: 0 },
        'カテゴリ': { select: { name: 'food' } },
      },
    });
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/not a known Status value/);
  });

  it('falls back to fixed-list when category is unknown', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildPage('approved', { 'カテゴリ': { select: { name: 'unknown_category' } } }),
    );
    const { fetchPageById } = await import('./notion.js');
    const payload = await fetchPageById('page-1');
    expect(payload.category).toBe('fixed-list');
  });

  it('throws when Status is not approved (e.g. backlog)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildPage('backlog'));
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/backlog/);
  });

  it('throws when Status is doing (Notion AI 作業中)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildPage('doing'));
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/doing/);
  });

  it('throws when Status=posted (二重投稿防止 hook)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildPage('posted'));
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/posted/);
  });
});

describe('queryDuplicateAsins', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;

  beforeEach(() => {
    dataSourcesQueryMock.mockReset();
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = originalDs;
  });

  it('returns empty set when env not configured', async () => {
    delete process.env.NOTION_API_KEY;
    delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    const { queryDuplicateAsins } = await import('./notion.js');
    const result = await queryDuplicateAsins(new Date());
    expect(result).toEqual(new Set());
    expect(dataSourcesQueryMock).not.toHaveBeenCalled();
  });

  it('queries with Status filter (backlog/doing/approved/posted) and returns asin set', async () => {
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: [
        { id: 'p1', properties: { ASIN: { rich_text: [{ plain_text: 'B001' }] } } },
        { id: 'p2', properties: { ASIN: { rich_text: [{ plain_text: 'B002' }] } } },
      ],
      has_more: false,
    });
    const { queryDuplicateAsins } = await import('./notion.js');
    const result = await queryDuplicateAsins(new Date('2026-05-09T12:00:00.000Z'));
    expect(result).toEqual(new Set(['B001', 'B002']));
    const arg = dataSourcesQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.data_source_id).toBe('ds-uuid-123');
    const filter = arg.filter as { and: Array<{ or?: Array<{ property: string; status?: { equals: string } }>; property?: string; date?: { on_or_after: string } }> };
    expect(filter.and).toHaveLength(2);
    // 4 値で重複防止 (rejected は意図的に除外 → 再候補化を許可)
    expect(filter.and[0]?.or).toEqual([
      { property: 'Status', status: { equals: 'backlog' } },
      { property: 'Status', status: { equals: 'doing' } },
      { property: 'Status', status: { equals: 'approved' } },
      { property: 'Status', status: { equals: 'posted' } },
    ]);
    expect(filter.and[1]?.property).toBe('候補生成日時');
  });

  it('paginates when has_more=true', async () => {
    dataSourcesQueryMock
      .mockResolvedValueOnce({
        results: [{ id: 'p1', properties: { ASIN: { rich_text: [{ plain_text: 'B001' }] } } }],
        has_more: true,
        next_cursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        results: [{ id: 'p2', properties: { ASIN: { rich_text: [{ plain_text: 'B002' }] } } }],
        has_more: false,
      });
    const { queryDuplicateAsins } = await import('./notion.js');
    const result = await queryDuplicateAsins(new Date());
    expect(result).toEqual(new Set(['B001', 'B002']));
    expect(dataSourcesQueryMock).toHaveBeenCalledTimes(2);
    const secondArg = dataSourcesQueryMock.mock.calls[1]?.[0] as { start_cursor?: string };
    expect(secondArg.start_cursor).toBe('cursor-2');
  });

  it('warns when MAX_QUERY_PAGES cap is reached (has_more still true after final page)', async () => {
    // 全 10 page で has_more=true を返し続けるケース → cap hit。
    dataSourcesQueryMock.mockResolvedValue({
      results: [{ id: 'p', properties: { ASIN: { rich_text: [{ plain_text: 'B999' }] } } }],
      has_more: true,
      next_cursor: 'next',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { queryDuplicateAsins } = await import('./notion.js');
    await queryDuplicateAsins(new Date());
    // MAX_QUERY_PAGES = 10 page まで叩いて止まる
    expect(dataSourcesQueryMock).toHaveBeenCalledTimes(10);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const warnLine = lines.find((l) => l.includes('"page cap reached"') && l.includes('queryDuplicateAsins'));
    expect(warnLine).toBeDefined();
    logSpy.mockRestore();
  });
});

