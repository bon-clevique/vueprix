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

  // PR-1 Phase 2: 新 signature `(pageId, result, postedAt, links?)`。result.x.ok / result.bluesky.ok を
  // 見て per-platform 制御で properties を組み立てる。両成功時のみ Status=posted に遷移する。
  it('updates Status=posted + x_posted + bluesky_posted with 投稿日時 when both succeeded', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    const { updateStatusToPosted } = await import('./notion.js');
    await updateStatusToPosted(
      'page-1',
      { x: { ok: true }, bluesky: { ok: true } },
      new Date('2026-05-09T14:00:00.000Z'),
    );
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { page_id: string; properties: Record<string, unknown> };
    expect(arg.page_id).toBe('page-1');
    expect(arg.properties.Status).toEqual({ status: { name: 'posted' } });
    expect(arg.properties['投稿日時']).toEqual({ date: { start: '2026-05-09T14:00:00.000Z' } });
    expect(arg.properties.x_posted).toEqual({ checkbox: true });
    expect(arg.properties.bluesky_posted).toEqual({ checkbox: true });
    // links 未指定なら bookmark append は呼ばれない
    expect(blocksAppendMock).not.toHaveBeenCalled();
  });

  it('appends X / Bluesky bookmark blocks when links are provided and both succeeded', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    blocksAppendMock.mockResolvedValueOnce({});
    const { updateStatusToPosted } = await import('./notion.js');
    await updateStatusToPosted(
      'page-1',
      { x: { ok: true }, bluesky: { ok: true } },
      new Date('2026-05-09T14:00:00.000Z'),
      {
        x: 'https://twitter.com/i/web/status/123',
        bluesky: 'https://bsky.app/profile/vueprix.bsky.social/post/abc',
      },
    );
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

  it('does not call blocks.append when no links are provided', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    const { updateStatusToPosted } = await import('./notion.js');
    await updateStatusToPosted(
      'page-1',
      { x: { ok: true }, bluesky: { ok: true } },
      new Date('2026-05-09T14:00:00.000Z'),
      {},
    );
    expect(blocksAppendMock).not.toHaveBeenCalled();
  });

  // PR-1 Phase 2: 新規 3 ケース pin
  // (a) 両成功 → 既存 1st test で coverage
  // (b) X 失敗 + BSky 成功 → Status 触らず、bluesky_posted のみ true、X bookmark 不在
  it('does not touch Status / 投稿日時 when X failed but BSky succeeded (per-platform retry)', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    blocksAppendMock.mockResolvedValueOnce({});
    const { updateStatusToPosted } = await import('./notion.js');
    // publish.ts:154-156 の動作 (X 失敗時は `result.x?.url` が undefined となり links.x も渡らない)
    // と整合させる。失敗 platform の link を渡さないため bookmark は Bluesky のみで append される。
    await updateStatusToPosted(
      'page-1',
      { x: { ok: false }, bluesky: { ok: true, url: 'https://bsky.app/profile/vueprix.bsky.social/post/abc' } },
      new Date('2026-05-09T14:00:00.000Z'),
      {
        bluesky: 'https://bsky.app/profile/vueprix.bsky.social/post/abc',
      },
    );
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    // Status は touch しない
    expect(arg.properties.Status).toBeUndefined();
    expect(arg.properties['投稿日時']).toBeUndefined();
    expect(arg.properties.x_posted).toBeUndefined();
    expect(arg.properties.bluesky_posted).toEqual({ checkbox: true });
    // bookmark は BSky のみ (X 失敗 → X bookmark なし)
    expect(blocksAppendMock).toHaveBeenCalledTimes(1);
    const blocksArg = blocksAppendMock.mock.calls[0]?.[0] as {
      children: Array<{ type: string; bookmark: { url: string } }>;
    };
    expect(blocksArg.children).toEqual([
      { object: 'block', type: 'bookmark', bookmark: { url: 'https://bsky.app/profile/vueprix.bsky.social/post/abc' } },
    ]);
  });

  // (c) 両失敗 → pages.update が一切呼ばれない (early return)
  it('does not call pages.update when both posters failed (no-op early return)', async () => {
    const { updateStatusToPosted } = await import('./notion.js');
    await updateStatusToPosted(
      'page-1',
      { x: { ok: false }, bluesky: { ok: false } },
      new Date('2026-05-09T14:00:00.000Z'),
      { x: 'https://twitter.com/i/web/status/123' },
    );
    expect(pagesUpdateMock).not.toHaveBeenCalled();
    expect(blocksAppendMock).not.toHaveBeenCalled();
  });

  // Code HIGH-1: prior 既投稿フラグありで残り platform retry 成功 → Status=posted に遷移する
  // ケースを pin する。実シナリオ: 前回 run で X だけ投稿成功 (xPosted=true 保存)、Bluesky は
  // 失敗で approved に残る → 今回 run で Bluesky retry 成功。bothOk = (false || true) && (true || false) = true。
  it('sets Status=posted when prior.xPosted=true and bluesky succeeds now (retry completion)', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    const { updateStatusToPosted } = await import('./notion.js');
    await updateStatusToPosted(
      'page-1',
      { x: { ok: false }, bluesky: { ok: true } },
      new Date('2026-05-09T14:00:00.000Z'),
      {},
      { xPosted: true, blueskyPosted: false }, // prior: X 投稿済
    );
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.Status).toEqual({ status: { name: 'posted' } });
    expect(arg.properties.bluesky_posted).toEqual({ checkbox: true });
    // 今回 x は失敗 → checkbox は追加しない (prior の保存値はそのまま保持される)
    expect(arg.properties.x_posted).toBeUndefined();
  });

  // Arch MED-3: bookmark append が throw しても Status update (pages.update) は成功扱いで
  // 戻る (= updateStatusToPosted が reject しない) ことを pin する。bookmark 喪失 log は error
  // level で出ることも併せて assert。
  it('logs error and returns successfully when bookmark append throws (audit trail loss is non-fatal)', async () => {
    pagesUpdateMock.mockResolvedValueOnce({});
    blocksAppendMock.mockRejectedValueOnce(new Error('blocks append 5xx'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { updateStatusToPosted } = await import('./notion.js');
    await expect(
      updateStatusToPosted(
        'page-1',
        { x: { ok: true }, bluesky: { ok: true } },
        new Date('2026-05-09T14:00:00.000Z'),
        { x: 'https://twitter.com/i/web/status/123', bluesky: 'https://bsky.app/profile/x/post/abc' },
      ),
    ).resolves.toBeUndefined();
    // pages.update は呼ばれて完遂 (Status=posted)
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    expect(blocksAppendMock).toHaveBeenCalledTimes(1);
    // logger.error 経由で 'bookmark append failed' line が console.error に流れる
    const errLines = errorSpy.mock.calls.map((c) => String(c[0]));
    const target = errLines.find((l) => l.includes('"bookmark append failed (status update succeeded)"'));
    expect(target).toBeDefined();
    errorSpy.mockRestore();
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
      // PR-1 Phase 2: checkbox property 不在時は false に丸める。
      xPosted: false,
      blueskyPosted: false,
    });
  });

  // PR-1 Phase 2: per-platform 既投稿フラグの抽出 pin。
  it('extracts xPosted=true / blueskyPosted=true when both checkboxes are set', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildPage('approved', {
        x_posted: { checkbox: true },
        bluesky_posted: { checkbox: true },
      }),
    );
    const { fetchPageById } = await import('./notion.js');
    const payload = await fetchPageById('page-1');
    expect(payload.xPosted).toBe(true);
    expect(payload.blueskyPosted).toBe(true);
  });

  it('extracts xPosted=true / blueskyPosted=false when only X has been posted (silent loss recovery target)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildPage('approved', {
        x_posted: { checkbox: true },
        bluesky_posted: { checkbox: false },
      }),
    );
    const { fetchPageById } = await import('./notion.js');
    const payload = await fetchPageById('page-1');
    expect(payload.xPosted).toBe(true);
    expect(payload.blueskyPosted).toBe(false);
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

  // PR-B1: 必須 number property が null/missing なら throw (fail-fast)。
  // 旧 silent default 0 (extractNumber が `?? 0` を返した) を断つ目的。
  it('throws when セール価格 is null (required number property fail-fast)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildPage('approved', { 'セール価格': { number: null } }),
    );
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/セール価格/);
  });

  it('throws when 通常価格 property is missing entirely', async () => {
    pagesRetrieveMock.mockResolvedValueOnce({
      id: 'page-1',
      properties: {
        Status: { status: { name: 'approved' } },
        ASIN: { rich_text: [{ plain_text: 'B0FKL' }] },
        '名前': { title: [{ plain_text: 'x' }] },
        '投稿文': { rich_text: [{ plain_text: 'text' }] },
        'Amazon URL': { url: null },
        'セール価格': { number: 850 },
        // 通常価格 を意図的に省略
        '割引率': { number: 0.15 },
        'カテゴリ': { select: { name: 'food' } },
      },
    });
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/通常価格/);
  });

  it('throws when 割引率 is NaN (Number.isFinite check)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildPage('approved', { '割引率': { number: NaN } }),
    );
    const { fetchPageById } = await import('./notion.js');
    await expect(fetchPageById('page-1')).rejects.toThrow(/割引率/);
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

