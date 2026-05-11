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

// title はデフォルトで food whitelist (`国産|日本産|日本製`) を通すようにしている。
// title 関連を検証する test は明示的に title を override すること。
const buildDeal = (overrides: Partial<{
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
}> = {}) => ({
  asin: 'B000DEAL1',
  title: '国産 サンプル商品',
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

describe('selectByQuota', () => {
  type Cat = 'food' | 'health' | 'kitchen' | 'stationery' | 'pc-desk' | 'gaming' | 'audio' | 'fixed-list';
  const buildCandidate = (overrides: Partial<{
    asin: string;
    category: Cat;
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

  it('caps each category at its quota', async () => {
    const { selectByQuota } = await import('./draft.js');
    // food quota=5: 7 候補のうち 5 件のみ採用される
    const inputs = Array.from({ length: 7 }, (_, i) =>
      buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
    );
    const result = selectByQuota(inputs);
    expect(result.filter((c) => c.category === 'food')).toHaveLength(5);
  });

  it('within a category, picks the top dropPercent', async () => {
    const { selectByQuota } = await import('./draft.js');
    // audio quota=2: dropPercent 40, 30 が選ばれ、10 は落ちる
    const result = selectByQuota([
      buildCandidate({ asin: 'A1', category: 'audio', dropPercent: 10 }),
      buildCandidate({ asin: 'A2', category: 'audio', dropPercent: 40 }),
      buildCandidate({ asin: 'A3', category: 'audio', dropPercent: 30 }),
    ]);
    expect(result.map((c) => c.asin).sort()).toEqual(['A2', 'A3']);
  });

  it('does not redistribute unused quota to other categories', async () => {
    const { selectByQuota } = await import('./draft.js');
    // pc-desk 候補が 0 件でも、food が quota(5) を超えて採用されない
    const inputs = Array.from({ length: 8 }, (_, i) =>
      buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
    );
    const result = selectByQuota(inputs);
    expect(result.filter((c) => c.category === 'food')).toHaveLength(5);
    expect(result).toHaveLength(5);
  });

  it('respects custom quota argument', async () => {
    const { selectByQuota } = await import('./draft.js');
    const customQuota = {
      food: 1,
      health: 1,
      kitchen: 0,
      stationery: 0,
      'pc-desk': 0,
      audio: 0,
      gaming: 0,
      'fixed-list': 0,
    } as const;
    const result = selectByQuota(
      [
        buildCandidate({ asin: 'F1', category: 'food', dropPercent: 50 }),
        buildCandidate({ asin: 'F2', category: 'food', dropPercent: 30 }),
        buildCandidate({ asin: 'H1', category: 'health', dropPercent: 20 }),
      ],
      customQuota,
    );
    expect(result.map((c) => c.asin).sort()).toEqual(['F1', 'H1']);
  });

  it('returns empty array for empty input', async () => {
    const { selectByQuota } = await import('./draft.js');
    expect(selectByQuota([])).toEqual([]);
  });

  it('does not mutate the input array', async () => {
    const { selectByQuota } = await import('./draft.js');
    const input = [
      buildCandidate({ asin: 'A', category: 'food', dropPercent: 30 }),
      buildCandidate({ asin: 'B', category: 'food', dropPercent: 50 }),
    ];
    const snapshot = input.map((c) => c.asin);
    selectByQuota(input);
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
    // title は food whitelist を通すよう「国産」を含める。
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([
          buildDeal({ asin: 'B000BLOCK', title: '国産 ブロック対象' }),
          buildDeal({ asin: 'B000PASS', title: '国産 通過対象' }),
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
          buildDeal({ asin: 'B000ACTIVE', title: '国産 重複対象' }),
          buildDeal({ asin: 'B000NEW', title: '国産 新規対象' }),
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

  it('limits food drafts to its CATEGORY_QUOTA (=5) regardless of how many deals returned', async () => {
    // food カテゴリで 15 件返しても CATEGORY_QUOTA.food (=5) を超えない
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

    expect(createDraftPageMock).toHaveBeenCalledTimes(5);
  });

  it('falls back to Keepa-only when PA-API getItems throws', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([buildDeal({ asin: 'B000FALL', title: '国産 フォールバック商品' })]);
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
    expect(draftArg.title).toBe('国産 フォールバック商品');
  });

  it('uses PA-API product info when available (preferred over Keepa fallback)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([buildDeal({ asin: 'B000PA', title: '国産 Keepa Title' })]);
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

  it('drops candidates whose title does not match category whitelist', async () => {
    // food category whitelist は (国産|日本産|日本製) を要求するため、これに該当しない
    // title はフィルタで落ちる。
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([
          buildDeal({ asin: 'B000NOWL', title: '輸入トマト缶 400g x 24' }),
          buildDeal({ asin: 'B000PASS', title: '国産レモン果汁 500ml' }),
        ]);
      }
      return Promise.resolve([]);
    });

    const { main } = await import('./draft.js');
    await main();

    const calledAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(calledAsins).toContain('B000PASS');
    expect(calledAsins).not.toContain('B000NOWL');
  });

  it('includes fixed candidates outside the per-category quota cap', async () => {
    // food quota=5 を埋めた上で、fixed (FIXED_ASINS) からも 1 件追加されることを確認。
    // fixed 候補は CATEGORY_QUOTA の対象外で別経路。
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(
          Array.from({ length: 8 }, (_, i) =>
            buildDeal({ asin: `B${String(i).padStart(3, '0')}`, title: '国産 食品' }),
          ),
        );
      }
      return Promise.resolve([]);
    });
    // checkAsin (FIXED_ASINS の各 ASIN について) — 1 件だけ history を返す
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B0C1JGD2T6') {
        return Promise.resolve({
          asin,
          title: 'カリタ コーヒーフィルター',
          currentPrice: 800,
          minPrice90d: 1000,
          dropPercent: 20,
        });
      }
      return Promise.resolve(null);
    });

    const { main } = await import('./draft.js');
    await main();

    // food=5 + fixed=1 で 6 件になる (food quota 5 を超えても fixed は別枠)
    expect(createDraftPageMock).toHaveBeenCalledTimes(6);
    const calledAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(calledAsins).toContain('B0C1JGD2T6');
  });

  it('creates draft with empty postText (Notion AI 運用)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve([buildDeal({ asin: 'B000EMPTY', title: '国産 空文 Test' })]);
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
