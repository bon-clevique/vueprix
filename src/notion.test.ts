import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock @notionhq/client at the module level — vi.mock is hoisted.
const pagesCreateMock = vi.fn();
const pagesUpdateMock = vi.fn();
const pagesRetrieveMock = vi.fn();
const dataSourcesQueryMock = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class MockClient {
    pages = { create: pagesCreateMock, update: pagesUpdateMock, retrieve: pagesRetrieveMock };
    dataSources = { query: dataSourcesQueryMock };
  },
}));

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

describe('createDraftPage', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;

  beforeEach(() => {
    pagesCreateMock.mockReset();
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid-123';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = originalDs;
  });

  it('creates page with Status=pending_review and returns page id', async () => {
    pagesCreateMock.mockResolvedValueOnce({ id: 'page-abc' });
    const { createDraftPage } = await import('./notion.js');
    const id = await createDraftPage({
      asin: 'B0FKLMMS2G',
      title: 'sample',
      postTextX: 'X text',
      postTextBluesky: 'Bluesky text',
      reason: 'reason',
      amazonUrl: 'https://www.amazon.co.jp/dp/B0FKLMMS2G?tag=t-22',
      currentPrice: 850,
      referencePrice: 1000,
      dropPercent: 15,
      category: 'food',
      generatedAt: new Date('2026-05-09T12:00:00.000Z'),
    });
    expect(id).toBe('page-abc');
    expect(pagesCreateMock).toHaveBeenCalledTimes(1);
    const arg = pagesCreateMock.mock.calls[0]?.[0] as {
      parent: unknown;
      properties: Record<string, unknown>;
    };
    expect(arg.parent).toEqual({ type: 'data_source_id', data_source_id: 'ds-uuid-123' });
    // PR-8: Status は status type (旧 select)。書き込み形式 `status: { name }`
    expect(arg.properties.Status).toEqual({ status: { name: 'pending_review' } });
    expect(arg.properties.ASIN).toEqual({ rich_text: [{ type: 'text', text: { content: 'B0FKLMMS2G' } }] });
    expect(arg.properties['投稿文_X']).toEqual({ rich_text: [{ type: 'text', text: { content: 'X text' } }] });
    expect(arg.properties['投稿文_Bluesky']).toEqual({ rich_text: [{ type: 'text', text: { content: 'Bluesky text' } }] });
    expect(arg.properties['Amazon URL']).toEqual({ url: 'https://www.amazon.co.jp/dp/B0FKLMMS2G?tag=t-22' });
    expect(arg.properties['通常価格']).toEqual({ number: 1000 });
    expect(arg.properties['セール価格']).toEqual({ number: 850 });
    expect(arg.properties['割引率']).toEqual({ number: 0.15 });
    // カテゴリは引き続き select type (PR-8 で status 化したのは Status property のみ)
    expect(arg.properties['カテゴリ']).toEqual({ select: { name: 'food' } });
    expect(arg.properties['サクラチェッカーURL']).toEqual({ url: 'https://sakura-checker.jp/search/B0FKLMMS2G/' });
    expect(arg.properties['候補生成日時']).toEqual({ date: { start: '2026-05-09T12:00:00.000Z' } });
    // PR-8: DryRun property は廃止
    expect(arg.properties.DryRun).toBeUndefined();
  });

  it('throws when env not configured', async () => {
    delete process.env.NOTION_API_KEY;
    delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    const { createDraftPage } = await import('./notion.js');
    await expect(
      createDraftPage({
        asin: 'B0',
        title: 't',
        postTextX: 'x',
        postTextBluesky: 'b',
        reason: 'r',
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
      // PR-8: Status は status type に変更 (旧: select)
      Status: { status: { name: status } },
      ASIN: { rich_text: [{ plain_text: 'B0FKL' }] },
      '名前': { title: [{ plain_text: 'sample title' }] },
      '投稿文_X': { rich_text: [{ plain_text: 'X text' }] },
      '投稿文_Bluesky': { rich_text: [{ plain_text: 'Bluesky text' }] },
      '理由': { rich_text: [{ plain_text: 'reason' }] },
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
      postTextX: 'X text',
      postTextBluesky: 'Bluesky text',
      reason: 'reason',
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
        // PR-8: Status は status type
        Status: { status: null },
        ASIN: { rich_text: [{ plain_text: 'B0FKL' }] },
        '名前': { title: [{ plain_text: 'x' }] },
        '投稿文_X': { rich_text: [{ plain_text: '' }] },
        '投稿文_Bluesky': { rich_text: [{ plain_text: '' }] },
        '理由': { rich_text: [{ plain_text: '' }] },
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

  it('throws when Status is not approved (e.g. pending_review)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildPage('pending_review'));
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/pending_review/);
  });

  it('throws when Status=posted (二重投稿防止 hook)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildPage('posted'));
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/posted/);
  });
});

describe('incrementFailureCount', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;

  beforeEach(() => {
    pagesUpdateMock.mockReset();
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

  it('first failure (0 → 1): returns blocked=false, no Status update, writes count + error message', async () => {
    pagesRetrieveMock.mockResolvedValueOnce({
      id: 'page-1',
      properties: { '投稿失敗回数': { number: 0 } },
    });
    pagesUpdateMock.mockResolvedValueOnce({});
    const { incrementFailureCount } = await import('./notion.js');
    const result = await incrementFailureCount('page-1', 'x: timeout, bsky: 401');
    expect(result).toEqual({ count: 1, blocked: false });
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as {
      page_id: string;
      properties: Record<string, unknown>;
    };
    expect(arg.page_id).toBe('page-1');
    expect(arg.properties['投稿失敗回数']).toEqual({ number: 1 });
    expect(arg.properties['最終エラー']).toEqual({
      rich_text: [{ type: 'text', text: { content: 'x: timeout, bsky: 401' } }],
    });
    // blocked=false なので Status update は出力されない
    expect(arg.properties.Status).toBeUndefined();
  });

  it('third failure (2 → 3): returns blocked=true, sets Status=blocked, count=3', async () => {
    pagesRetrieveMock.mockResolvedValueOnce({
      id: 'page-1',
      properties: { '投稿失敗回数': { number: 2 } },
    });
    pagesUpdateMock.mockResolvedValueOnce({});
    const { incrementFailureCount } = await import('./notion.js');
    const result = await incrementFailureCount('page-1', 'x: 500, bsky: 500');
    expect(result).toEqual({ count: 3, blocked: true });
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties['投稿失敗回数']).toEqual({ number: 3 });
    // PR-8: Status は status type
    expect(arg.properties.Status).toEqual({ status: { name: 'blocked' } });
  });

  it('treats missing 投稿失敗回数 property as 0 baseline', async () => {
    pagesRetrieveMock.mockResolvedValueOnce({ id: 'page-1', properties: {} });
    pagesUpdateMock.mockResolvedValueOnce({});
    const { incrementFailureCount } = await import('./notion.js');
    const result = await incrementFailureCount('page-1', 'first failure ever');
    expect(result).toEqual({ count: 1, blocked: false });
  });

  it('truncates very long error messages to NOTION_TEXT_LIMIT (1900) on rich_text content', async () => {
    pagesRetrieveMock.mockResolvedValueOnce({
      id: 'page-1',
      properties: { '投稿失敗回数': { number: 0 } },
    });
    pagesUpdateMock.mockResolvedValueOnce({});
    const longMessage = 'a'.repeat(3000);
    const { incrementFailureCount } = await import('./notion.js');
    await incrementFailureCount('page-1', longMessage);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    const richText = arg.properties['最終エラー'] as {
      rich_text: Array<{ text: { content: string } }>;
    };
    const content = richText.rich_text[0]?.text.content ?? '';
    expect([...content].length).toBeLessThanOrEqual(1900);
    expect(content.endsWith('…')).toBe(true);
  });

  it('falls back to count=0 baseline when retrieve fails (still increments to 1)', async () => {
    pagesRetrieveMock.mockRejectedValueOnce(new Error('network glitch'));
    pagesUpdateMock.mockResolvedValueOnce({});
    const { incrementFailureCount } = await import('./notion.js');
    const result = await incrementFailureCount('page-1', 'oops');
    expect(result).toEqual({ count: 1, blocked: false });
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
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

  it('queries with Status filter (pending_review/approved/posted) and returns asin set', async () => {
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
    // PR-8: Status filter は status: { equals } 形式
    expect(filter.and[0]?.or).toEqual([
      { property: 'Status', status: { equals: 'pending_review' } },
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

describe('expireOldDrafts', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;

  beforeEach(() => {
    dataSourcesQueryMock.mockReset();
    pagesUpdateMock.mockReset();
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

  const buildPendingReviewPage = (id: string) => ({
    id,
    // PR-8: Status は status type
    properties: { Status: { status: { name: 'pending_review' } } },
  });

  it('queries pending_review older than slaHours and updates each to expired', async () => {
    const now = new Date('2026-05-09T12:00:00.000Z');
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: [{ id: 'p-old-1', properties: {} }, { id: 'p-old-2', properties: {} }],
      has_more: false,
    });
    // C2: updateStatusToExpired は retrieve→check→update の 2-step
    pagesRetrieveMock.mockResolvedValue(buildPendingReviewPage('p-old-1'));
    pagesUpdateMock.mockResolvedValue({});
    const { expireOldDrafts } = await import('./notion.js');
    const count = await expireOldDrafts(now, 10);
    expect(count).toBe(2);
    expect(pagesUpdateMock).toHaveBeenCalledTimes(2);
    expect(pagesRetrieveMock).toHaveBeenCalledTimes(2);
    const arg = dataSourcesQueryMock.mock.calls[0]?.[0] as { filter: { and: Array<{ property: string; status?: { equals: string }; date?: { before: string } }> } };
    // PR-8: Status filter は status: { equals } 形式
    expect(arg.filter.and[0]?.status).toEqual({ equals: 'pending_review' });
    expect(arg.filter.and[1]?.date?.before).toBe('2026-05-09T02:00:00.000Z');
    const updateArg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(updateArg.properties.Status).toEqual({ status: { name: 'expired' } });
  });

  it('returns 0 when no candidates match', async () => {
    dataSourcesQueryMock.mockResolvedValueOnce({ results: [], has_more: false });
    const { expireOldDrafts } = await import('./notion.js');
    const count = await expireOldDrafts(new Date());
    expect(count).toBe(0);
    expect(pagesUpdateMock).not.toHaveBeenCalled();
  });

  it('skips update when status changed to approved between query and update (C2 race fix)', async () => {
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: [{ id: 'p-1', properties: {} }],
      has_more: false,
    });
    // human が直前に approved に変えたケースを想定 — retrieve 時点では approved
    pagesRetrieveMock.mockResolvedValueOnce({
      id: 'p-1',
      // PR-8: Status は status type
      properties: { Status: { status: { name: 'approved' } } },
    });
    const { expireOldDrafts } = await import('./notion.js');
    const count = await expireOldDrafts(new Date());
    expect(count).toBe(1); // 検出件数は 1
    expect(pagesRetrieveMock).toHaveBeenCalledTimes(1);
    // しかし update は呼ばれない (silent loss 防止)
    expect(pagesUpdateMock).not.toHaveBeenCalled();
  });

  it('uses APPROVAL_SLA_HOURS as default slaHours', async () => {
    const now = new Date('2026-05-09T12:00:00.000Z');
    dataSourcesQueryMock.mockResolvedValueOnce({ results: [], has_more: false });
    const { expireOldDrafts } = await import('./notion.js');
    await expireOldDrafts(now); // slaHours 未指定 → APPROVAL_SLA_HOURS=10 を使う想定
    const arg = dataSourcesQueryMock.mock.calls[0]?.[0] as {
      filter: { and: Array<{ date?: { before: string } }> };
    };
    // 12:00 - 10h = 02:00
    expect(arg.filter.and[1]?.date?.before).toBe('2026-05-09T02:00:00.000Z');
  });

  it('warns when expire count >= EXPIRE_WARN_THRESHOLD (5)', async () => {
    // 5 件 expire → warn 発火
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: Array.from({ length: 5 }, (_, i) => ({ id: `p-${i}`, properties: {} })),
      has_more: false,
    });
    pagesRetrieveMock.mockResolvedValue({
      id: 'p',
      properties: { Status: { status: { name: 'pending_review' } } },
    });
    pagesUpdateMock.mockResolvedValue({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { expireOldDrafts } = await import('./notion.js');
    const count = await expireOldDrafts(new Date());
    expect(count).toBe(5);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const warnLine = lines.find((l) => l.includes('"high expire volume"') && l.includes('"count":5'));
    expect(warnLine).toBeDefined();
    logSpy.mockRestore();
  });

  it('does not warn when expire count < EXPIRE_WARN_THRESHOLD', async () => {
    // 4 件 expire → warn 出ない
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: Array.from({ length: 4 }, (_, i) => ({ id: `p-${i}`, properties: {} })),
      has_more: false,
    });
    pagesRetrieveMock.mockResolvedValue({
      id: 'p',
      properties: { Status: { status: { name: 'pending_review' } } },
    });
    pagesUpdateMock.mockResolvedValue({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { expireOldDrafts } = await import('./notion.js');
    await expireOldDrafts(new Date());
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"high expire volume"'))).toBe(false);
    logSpy.mockRestore();
  });

  it('warns when MAX_QUERY_PAGES cap is reached', async () => {
    dataSourcesQueryMock.mockResolvedValue({
      results: [{ id: 'p', properties: {} }],
      has_more: true,
      next_cursor: 'cursor',
    });
    pagesRetrieveMock.mockResolvedValue({
      id: 'p',
      properties: { Status: { status: { name: 'pending_review' } } },
    });
    pagesUpdateMock.mockResolvedValue({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { expireOldDrafts } = await import('./notion.js');
    await expireOldDrafts(new Date());
    expect(dataSourcesQueryMock).toHaveBeenCalledTimes(10);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const warnLine = lines.find((l) => l.includes('"page cap reached"') && l.includes('expireOldDrafts'));
    expect(warnLine).toBeDefined();
    logSpy.mockRestore();
  });
});
