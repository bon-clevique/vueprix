import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 外部 I/O dependency をすべてモック化。各 test 内で mockResolved* を上書きしてシナリオを切替える。
const getDealsMock = vi.fn();
const checkAsinMock = vi.fn();
const getItemsMock = vi.fn();
const createDraftPageMock = vi.fn();
const queryDuplicateAsinsMock = vi.fn();
const loadBlocklistMock = vi.fn();

vi.mock('./keepa.js', () => ({
  getDeals: (...args: unknown[]) => getDealsMock(...args),
  checkAsin: (...args: unknown[]) => checkAsinMock(...args),
}));

vi.mock('./paapi.js', () => ({
  getItems: (...args: unknown[]) => getItemsMock(...args),
}));

vi.mock('./notion.js', () => ({
  createDraftPage: (...args: unknown[]) => createDraftPageMock(...args),
  queryDuplicateAsins: (...args: unknown[]) => queryDuplicateAsinsMock(...args),
}));

vi.mock('./blocklist.js', () => ({
  loadBlocklist: (...args: unknown[]) => loadBlocklistMock(...args),
}));

// FIXED_ASINS は config.ts に const で定義されているので、mockKeepa の checkAsin に
// "全 ASIN について null を返す" 振る舞いを default 設定し、fixed candidates が混入しないようにする。
const resetAllMocks = () => {
  getDealsMock.mockReset();
  checkAsinMock.mockReset();
  getItemsMock.mockReset();
  createDraftPageMock.mockReset();
  queryDuplicateAsinsMock.mockReset();
  loadBlocklistMock.mockReset();

  // sane defaults
  getDealsMock.mockResolvedValue([]);
  checkAsinMock.mockResolvedValue(null);
  getItemsMock.mockResolvedValue([]);
  createDraftPageMock.mockResolvedValue('page-mock-id');
  queryDuplicateAsinsMock.mockResolvedValue(new Set<string>());
  loadBlocklistMock.mockResolvedValue(new Set<string>());
};

const buildDeal = (overrides: Partial<{
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
}> = {}) => ({
  asin: 'B000DEAL1',
  title: 'Sample Deal',
  currentPrice: 800,
  referencePrice: 1000,
  dropPercent: 20,
  ...overrides,
});

describe('draft entrypoint', () => {
  it('exports main and does not auto-run when VITEST is set', async () => {
    const mod = await import('./draft.js');
    expect(typeof mod.main).toBe('function');
  });
});

describe('sortByPriority', () => {
  const buildCandidate = (overrides: Partial<{
    asin: string;
    category: 'food' | 'health' | 'pc-desk' | 'gaming' | 'audio' | 'fixed-list';
    dropPercent: number;
  }> = {}) => ({
    asin: overrides.asin ?? 'B000TEST',
    title: 'Test',
    currentPrice: 800,
    referencePrice: 1000,
    dropPercent: overrides.dropPercent ?? 20,
    source: 'deals' as const,
    category: overrides.category ?? 'food' as const,
  });

  it('orders fixed-list before food regardless of dropPercent', async () => {
    const { sortByPriority } = await import('./draft.js');
    const result = sortByPriority([
      buildCandidate({ asin: 'FOOD1', category: 'food', dropPercent: 50 }),
      buildCandidate({ asin: 'FIXED1', category: 'fixed-list', dropPercent: 10 }),
    ]);
    expect(result.map((c) => c.asin)).toEqual(['FIXED1', 'FOOD1']);
  });

  it('orders pc-desk / gaming / audio before health / food', async () => {
    const { sortByPriority } = await import('./draft.js');
    const result = sortByPriority([
      buildCandidate({ asin: 'FOOD', category: 'food' }),
      buildCandidate({ asin: 'HEALTH', category: 'health' }),
      buildCandidate({ asin: 'AUDIO', category: 'audio' }),
      buildCandidate({ asin: 'GAMING', category: 'gaming' }),
      buildCandidate({ asin: 'PC', category: 'pc-desk' }),
    ]);
    expect(result.map((c) => c.asin)).toEqual(['PC', 'GAMING', 'AUDIO', 'HEALTH', 'FOOD']);
  });

  it('sorts by dropPercent descending within the same category', async () => {
    const { sortByPriority } = await import('./draft.js');
    const result = sortByPriority([
      buildCandidate({ asin: 'A', category: 'pc-desk', dropPercent: 15 }),
      buildCandidate({ asin: 'B', category: 'pc-desk', dropPercent: 40 }),
      buildCandidate({ asin: 'C', category: 'pc-desk', dropPercent: 25 }),
    ]);
    expect(result.map((c) => c.asin)).toEqual(['B', 'C', 'A']);
  });

  it('returns an empty array for empty input', async () => {
    const { sortByPriority } = await import('./draft.js');
    expect(sortByPriority([])).toEqual([]);
  });

  it('does not mutate the input array', async () => {
    const { sortByPriority } = await import('./draft.js');
    const input = [
      buildCandidate({ asin: 'FOOD', category: 'food' }),
      buildCandidate({ asin: 'PC', category: 'pc-desk' }),
    ];
    const snapshot = input.map((c) => c.asin);
    sortByPriority(input);
    expect(input.map((c) => c.asin)).toEqual(snapshot);
  });
});

describe('draft.main integration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetAllMocks();
    process.env.PAAPI_PARTNER_TAG = 'test-tag-22';
    // KEEPA_CATEGORIES は config.ts に 5 件あるので、各 categoryId について getDealsMock が呼ばれる。
    // default で空配列を返すので、test 内で個別カテゴリだけ override する。
  });

  afterEach(() => {
    // 元の env に戻す
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it('drops candidates whose ASIN is in the blocklist', async () => {
    // 食品カテゴリで 2 件 deal 返す。1 件は blocklist にある。
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([
          buildDeal({ asin: 'B000BLOCK', title: 'Blocked Item' }),
          buildDeal({ asin: 'B000PASS', title: 'Allowed Item' }),
        ]);
      }
      return Promise.resolve([]);
    });
    loadBlocklistMock.mockResolvedValue(new Set(['B000BLOCK']));

    const { main } = await import('./draft.js');
    await main();

    // createDraftPage は B000PASS のみで呼ばれるはず
    const calledAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(calledAsins).toContain('B000PASS');
    expect(calledAsins).not.toContain('B000BLOCK');
  });

  it('drops candidates whose ASIN is already active in Notion (duplicate)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([
          buildDeal({ asin: 'B000ACTIVE', title: 'Active in Notion' }),
          buildDeal({ asin: 'B000NEW', title: 'New' }),
        ]);
      }
      return Promise.resolve([]);
    });
    queryDuplicateAsinsMock.mockResolvedValue(new Set(['B000ACTIVE']));

    const { main } = await import('./draft.js');
    await main();

    const calledAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(calledAsins).toContain('B000NEW');
    expect(calledAsins).not.toContain('B000ACTIVE');
  });

  it('limits drafts to MAX_POSTS_PER_RUN (=10)', async () => {
    // 15 件返して、10 件だけ draft されることを確認
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(
          Array.from({ length: 15 }, (_, i) =>
            buildDeal({ asin: `B${String(i).padStart(3, '0')}` }),
          ),
        );
      }
      return Promise.resolve([]);
    });

    const { main } = await import('./draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(10);
  });

  it('falls back to Keepa-only when PA-API getItems throws', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([buildDeal({ asin: 'B000FALL', title: 'Fallback Title' })]);
      }
      return Promise.resolve([]);
    });
    getItemsMock.mockRejectedValueOnce(new Error('PA-API down'));

    const { main } = await import('./draft.js');
    await main();

    // PA-API 失敗でも Keepa 由来データで draft 作成は継続する
    expect(createDraftPageMock).toHaveBeenCalledTimes(1);
    const draftArg = createDraftPageMock.mock.calls[0]?.[0] as { asin: string; title: string };
    expect(draftArg.asin).toBe('B000FALL');
    // PA-API fallback 時は Keepa の title を使う
    expect(draftArg.title).toBe('Fallback Title');
  });

  it('uses PA-API product info when available (preferred over Keepa fallback)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([buildDeal({ asin: 'B000PA', title: 'Keepa Title' })]);
      }
      return Promise.resolve([]);
    });
    getItemsMock.mockResolvedValue([
      {
        asin: 'B000PA',
        title: 'PA-API Official Title',
        imageUrl: 'https://example.com/img.jpg',
        currentPrice: 800,
        affiliateUrl: 'https://www.amazon.co.jp/dp/B000PA?tag=test-tag-22',
      },
    ]);

    const { main } = await import('./draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(1);
    const draftArg = createDraftPageMock.mock.calls[0]?.[0] as { title: string };
    expect(draftArg.title).toBe('PA-API Official Title');
  });

  it('returns early when no targets remain after filtering', async () => {
    // 全 deal を blocklist で排除すると targets=0 → createDraftPage 呼ばれず
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([buildDeal({ asin: 'B000ONLY' })]);
      }
      return Promise.resolve([]);
    });
    loadBlocklistMock.mockResolvedValue(new Set(['B000ONLY']));

    const { main } = await import('./draft.js');
    await main();

    expect(createDraftPageMock).not.toHaveBeenCalled();
    // PA-API も呼ばれないはず (targets=0 で early return)
    expect(getItemsMock).not.toHaveBeenCalled();
  });

  it('creates draft with empty postText (Notion AI 運用)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([buildDeal({ asin: 'B000EMPTY', title: 'Empty Test' })]);
      }
      return Promise.resolve([]);
    });

    const { main } = await import('./draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(1);
    const draftArg = createDraftPageMock.mock.calls[0]?.[0] as { postText: string };
    expect(draftArg.postText).toBe('');
  });
});
