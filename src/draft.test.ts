import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 外部 I/O dependency をすべてモック化。各 test 内で mockResolved* を上書きしてシナリオを切替える。
const getDealsMock = vi.fn();
const checkAsinMock = vi.fn();
const getItemsMock = vi.fn();
const createDraftPageMock = vi.fn();
const createPostedPageMock = vi.fn();
const queryDuplicateAsinsMock = vi.fn();
const loadBlocklistMock = vi.fn();
const appendRunLogMock = vi.fn();
const fetchFixedDescriptionsMock = vi.fn();
const dispatchMock = vi.fn();
const appendHistoryMock = vi.fn();

vi.mock('./keepa.js', () => ({
  getDeals: (...args: unknown[]) => getDealsMock(...args),
  checkAsin: (...args: unknown[]) => checkAsinMock(...args),
}));

vi.mock('./paapi.js', () => ({
  getItems: (...args: unknown[]) => getItemsMock(...args),
}));

vi.mock('./notion.js', () => ({
  createDraftPage: (...args: unknown[]) => createDraftPageMock(...args),
  createPostedPage: (...args: unknown[]) => createPostedPageMock(...args),
  queryDuplicateAsins: (...args: unknown[]) => queryDuplicateAsinsMock(...args),
}));

vi.mock('./blocklist.js', () => ({
  loadBlocklist: (...args: unknown[]) => loadBlocklistMock(...args),
}));

vi.mock('./run-log.js', () => ({
  appendRunLog: (...args: unknown[]) => appendRunLogMock(...args),
}));

vi.mock('./fixed-templates.js', async () => {
  const actual = await vi.importActual<typeof import('./fixed-templates.js')>('./fixed-templates.js');
  return {
    // composeFixedPostText は pure fn なので実装を再利用。fetchFixedDescriptions のみ mock。
    composeFixedPostText: actual.composeFixedPostText,
    fetchFixedDescriptions: (...args: unknown[]) => fetchFixedDescriptionsMock(...args),
  };
});

vi.mock('./posters/index.js', async () => {
  const actual = await vi.importActual<typeof import('./posters/index.js')>('./posters/index.js');
  return {
    posters: actual.posters,
    anySucceeded: actual.anySucceeded,
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  };
});

vi.mock('./history.js', () => ({
  appendHistory: (...args: unknown[]) => appendHistoryMock(...args),
}));

// FIXED_ASINS は config.ts に const で定義されているので、mockKeepa の checkAsin に
// "全 ASIN について null を返す" 振る舞いを default 設定し、fixed candidates が混入しないようにする。
// getDeals は GetDealsResult ({ deals, tokensLeft }) を返す。
// test 側では deals 配列だけ渡すケースが大半なので、tokensLeft default は null。
// tokensLeft の値を明示的に observe したい test は dealsResult([...], 42) のように明示する。
const dealsResult = (deals: unknown[], tokensLeft: number | null = null) => ({ deals, tokensLeft });

const resetAllMocks = () => {
  getDealsMock.mockReset();
  checkAsinMock.mockReset();
  getItemsMock.mockReset();
  createDraftPageMock.mockReset();
  createPostedPageMock.mockReset();
  queryDuplicateAsinsMock.mockReset();
  loadBlocklistMock.mockReset();
  appendRunLogMock.mockReset();
  fetchFixedDescriptionsMock.mockReset();
  dispatchMock.mockReset();
  appendHistoryMock.mockReset();

  // sane defaults: tokensLeft は null にして「設定無し」を示す
  // (各 test が個別カテゴリで mockImplementation すれば、その値が lastTokensLeft に反映される)
  getDealsMock.mockResolvedValue(dealsResult([], null));
  checkAsinMock.mockResolvedValue(null);
  getItemsMock.mockResolvedValue([]);
  createDraftPageMock.mockResolvedValue('page-mock-id');
  createPostedPageMock.mockResolvedValue('posted-page-mock-id');
  queryDuplicateAsinsMock.mockResolvedValue(new Set<string>());
  loadBlocklistMock.mockResolvedValue(new Set<string>());
  appendRunLogMock.mockResolvedValue(undefined);
  fetchFixedDescriptionsMock.mockResolvedValue(new Map<string, string>());
  // 固定ASIN 即投稿経路は本 default だと dispatch が呼ばれずに済む (fetchFixedDescriptions が空 Map)。
  // 投稿成功シナリオの test 内で dispatchMock.mockResolvedValueOnce({...}) を上書きする。
  dispatchMock.mockResolvedValue({ x: { ok: false }, bluesky: { ok: false } });
  appendHistoryMock.mockResolvedValue(undefined);
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
        return Promise.resolve(dealsResult([
          buildDeal({ asin: 'B000BLOCK', title: '国産 ブロック対象' }),
          buildDeal({ asin: 'B000PASS', title: '国産 通過対象' }),
        ]));
      }
      return Promise.resolve(dealsResult([]));
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
        return Promise.resolve(dealsResult([
          buildDeal({ asin: 'B000ACTIVE', title: '国産 重複対象' }),
          buildDeal({ asin: 'B000NEW', title: '国産 新規対象' }),
        ]));
      }
      return Promise.resolve(dealsResult([]));
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
          dealsResult(
            Array.from({ length: 15 }, (_, i) =>
              buildDeal({ asin: `B${String(i).padStart(3, '0')}` }),
            ),
          ),
        );
      }
      return Promise.resolve(dealsResult([]));
    });

    const { main } = await import('./draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(5);
  });

  it('falls back to Keepa-only when PA-API getItems throws', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(dealsResult([buildDeal({ asin: 'B000FALL', title: '国産 フォールバック商品' })]));
      }
      return Promise.resolve(dealsResult([]));
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
        return Promise.resolve(dealsResult([buildDeal({ asin: 'B000PA', title: '国産 Keepa Title' })]));
      }
      return Promise.resolve(dealsResult([]));
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
        return Promise.resolve(dealsResult([buildDeal({ asin: 'B000ONLY' })]));
      }
      return Promise.resolve(dealsResult([]));
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
        return Promise.resolve(dealsResult([
          buildDeal({ asin: 'B000NOWL', title: '輸入トマト缶 400g x 24' }),
          buildDeal({ asin: 'B000PASS', title: '国産レモン果汁 500ml' }),
        ]));
      }
      return Promise.resolve(dealsResult([]));
    });

    const { main } = await import('./draft.js');
    await main();

    const calledAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(calledAsins).toContain('B000PASS');
    expect(calledAsins).not.toContain('B000NOWL');
  });

  it('routes fixed-list candidates to direct-post path (not createDraftPage)', async () => {
    // 固定ASIN は Notion 投稿文 DB の紹介文を取得 → X/Bluesky 即投稿 → createPostedPage で記録する
    // 独立フローに乗る。deals 経路の createDraftPage には混ざらない (food quota 5 件が full)。
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(
          dealsResult(
            Array.from({ length: 8 }, (_, i) =>
              buildDeal({ asin: `B${String(i).padStart(3, '0')}`, title: '国産 食品' }),
            ),
          ),
        );
      }
      return Promise.resolve(dealsResult([]));
    });
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B0C1JGD2T6') {
        return Promise.resolve({
          asin,
          title: 'カリタ コーヒーフィルター',
          currentPrice: 800,
          referencePrice: 1000,
          referenceSource: 'list-price' as const,
          dropPercent: 20,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedDescriptionsMock.mockResolvedValue(
      new Map<string, string>([['B0C1JGD2T6', 'カリタの定番フィルター。1〜2人用。']]),
    );
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/post/1' },
      bluesky: { ok: true, url: 'https://bsky.app/post/1' },
    });

    const { main } = await import('./draft.js');
    await main();

    // deals 経路: food quota=5 のみ (固定ASIN は混ざらない)
    expect(createDraftPageMock).toHaveBeenCalledTimes(5);
    const draftAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(draftAsins).not.toContain('B0C1JGD2T6');

    // 固定ASIN 経路: dispatch 呼ばれる + createPostedPage で 1 件記録 + appendHistory で source=fixed-direct
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchInput = dispatchMock.mock.calls[0]?.[1] as { asin: string; text: string };
    expect(dispatchInput.asin).toBe('B0C1JGD2T6');
    expect(dispatchInput.text).toContain('【20% OFF】');
    expect(dispatchInput.text).toContain('カリタの定番フィルター');

    expect(createPostedPageMock).toHaveBeenCalledTimes(1);
    const postedArg = createPostedPageMock.mock.calls[0]?.[0] as { asin: string; postText: string };
    expect(postedArg.asin).toBe('B0C1JGD2T6');
    expect(postedArg.postText).toBe(dispatchInput.text);

    expect(appendHistoryMock).toHaveBeenCalledTimes(1);
    const historyArg = appendHistoryMock.mock.calls[0]?.[0] as { source: string; asin: string };
    expect(historyArg.source).toBe('fixed-direct');
    expect(historyArg.asin).toBe('B0C1JGD2T6');
  });

  it('skips fixed candidates with no description in Notion', async () => {
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B0C1JGD2T6') {
        return Promise.resolve({
          asin,
          title: 'カリタ コーヒーフィルター',
          currentPrice: 800,
          referencePrice: 1000,
          referenceSource: 'list-price' as const,
          dropPercent: 20,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedDescriptionsMock.mockResolvedValue(new Map<string, string>());  // 空 Map

    const { main } = await import('./draft.js');
    await main();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createPostedPageMock).not.toHaveBeenCalled();
    expect(appendHistoryMock).not.toHaveBeenCalled();
  });

  it('does not record fixed candidate when all posters fail', async () => {
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B0C1JGD2T6') {
        return Promise.resolve({
          asin,
          title: 'カリタ コーヒーフィルター',
          currentPrice: 800,
          referencePrice: 1000,
          referenceSource: 'list-price' as const,
          dropPercent: 20,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedDescriptionsMock.mockResolvedValue(
      new Map<string, string>([['B0C1JGD2T6', '紹介文']]),
    );
    dispatchMock.mockResolvedValue({ x: { ok: false }, bluesky: { ok: false } });

    const { main } = await import('./draft.js');
    await main();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(createPostedPageMock).not.toHaveBeenCalled();
    expect(appendHistoryMock).not.toHaveBeenCalled();
  });

  it('uses PA-API SavingBasis as reference when present, overriding Keepa fallback', async () => {
    // Keepa では 1% drop (閾値未満) だが、PA-API SavingBasis (¥1,490) で 28% drop → 投稿される。
    // B07B5CD8NY 想定シナリオ: current=1080, Keepa-only では拾えないが SavingBasis で復活する。
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B07B5CD8NY') {
        return Promise.resolve({
          asin,
          title: 'クリニカ デンタルフロス',
          currentPrice: 1080,
          referencePrice: 1094,           // Keepa new-avg fallback
          referenceSource: 'new-avg' as const,
          dropPercent: 1,                 // Keepa fallback だと閾値未満
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedDescriptionsMock.mockResolvedValue(
      new Map<string, string>([['B07B5CD8NY', 'Y字フロスでスキマケアに最適。']]),
    );
    getItemsMock.mockResolvedValue([
      {
        asin: 'B07B5CD8NY',
        title: 'クリニカ デンタルフロス',
        imageUrl: '',
        currentPrice: 1080,
        affiliateUrl: 'https://www.amazon.co.jp/dp/B07B5CD8NY',
        savingBasis: 1490,
      },
    ]);
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/post/x' },
      bluesky: { ok: true, url: 'https://bsky.app/post/y' },
    });

    const { main } = await import('./draft.js');
    await main();

    // SavingBasis (1490) ベースで dropPercent = round((1490-1080)/1490*100) = 28 → 閾値 15 を超えて投稿される
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchInput = dispatchMock.mock.calls[0]?.[1] as { text: string };
    expect(dispatchInput.text).toContain('【28% OFF】');
    expect(dispatchInput.text).toContain('¥1,490');
    expect(dispatchInput.text).toContain('¥1,080');

    expect(createPostedPageMock).toHaveBeenCalledTimes(1);
    const postedArg = createPostedPageMock.mock.calls[0]?.[0] as {
      referencePrice: number;
      dropPercent: number;
    };
    expect(postedArg.referencePrice).toBe(1490);
    expect(postedArg.dropPercent).toBe(28);
  });

  it('falls back to Keepa when SavingBasis indicates suspiciously high drop (>95%, sanity cap)', async () => {
    // PA-API が ¥99,999 を返した (異常値) → cap 超過で Keepa fallback (20%) に落とす。誇大広告防止。
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B0C1JGD2T6') {
        return Promise.resolve({
          asin,
          title: 'カリタ コーヒーフィルター',
          currentPrice: 800,
          referencePrice: 1000,
          referenceSource: 'list-price' as const,
          dropPercent: 20,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedDescriptionsMock.mockResolvedValue(
      new Map<string, string>([['B0C1JGD2T6', 'カリタの定番フィルター。']]),
    );
    getItemsMock.mockResolvedValue([
      {
        asin: 'B0C1JGD2T6',
        title: 'カリタ コーヒーフィルター',
        imageUrl: '',
        currentPrice: 800,
        affiliateUrl: 'https://www.amazon.co.jp/dp/B0C1JGD2T6',
        savingBasis: 99999,  // 異常値: (99999-800)/99999 = 99.2% > 95
      },
    ]);
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/p' },
      bluesky: { ok: true, url: 'https://bsky.app/p' },
    });

    const { main } = await import('./draft.js');
    await main();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchInput = dispatchMock.mock.calls[0]?.[1] as { text: string };
    expect(dispatchInput.text).toContain('【20% OFF】');  // Keepa fallback
    const postedArg = createPostedPageMock.mock.calls[0]?.[0] as { referencePrice: number };
    expect(postedArg.referencePrice).toBe(1000);  // SavingBasis 99999 が rejected、Keepa の 1000 が採用
  });

  it('falls back to Keepa reference when SavingBasis is missing', async () => {
    // PA-API レスポンスに savingBasis 無し → Keepa fallback (20% drop) で投稿される。
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B0C1JGD2T6') {
        return Promise.resolve({
          asin,
          title: 'カリタ コーヒーフィルター',
          currentPrice: 800,
          referencePrice: 1000,
          referenceSource: 'list-price' as const,
          dropPercent: 20,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedDescriptionsMock.mockResolvedValue(
      new Map<string, string>([['B0C1JGD2T6', 'カリタの定番フィルター。']]),
    );
    getItemsMock.mockResolvedValue([
      {
        asin: 'B0C1JGD2T6',
        title: 'カリタ コーヒーフィルター',
        imageUrl: '',
        currentPrice: 800,
        affiliateUrl: 'https://www.amazon.co.jp/dp/B0C1JGD2T6',
        // savingBasis なし
      },
    ]);
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/p' },
      bluesky: { ok: true, url: 'https://bsky.app/p' },
    });

    const { main } = await import('./draft.js');
    await main();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchInput = dispatchMock.mock.calls[0]?.[1] as { text: string };
    expect(dispatchInput.text).toContain('【20% OFF】');  // Keepa fallback の dropPercent

    const postedArg = createPostedPageMock.mock.calls[0]?.[0] as {
      referencePrice: number;
      dropPercent: number;
    };
    expect(postedArg.referencePrice).toBe(1000);  // Keepa list-price
    expect(postedArg.dropPercent).toBe(20);
  });

  it('skips fixed candidate when neither SavingBasis nor Keepa reach threshold', async () => {
    // Keepa 1% + SavingBasis なし or current 以下 → 閾値判定で skip、投稿されない。
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B07B5CD8NY') {
        return Promise.resolve({
          asin,
          title: 'クリニカ デンタルフロス',
          currentPrice: 1080,
          referencePrice: 1094,
          referenceSource: 'new-avg' as const,
          dropPercent: 1,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedDescriptionsMock.mockResolvedValue(
      new Map<string, string>([['B07B5CD8NY', 'Y字フロス。']]),
    );
    getItemsMock.mockResolvedValue([]);  // PA-API 空レスポンス

    const { main } = await import('./draft.js');
    await main();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createPostedPageMock).not.toHaveBeenCalled();
  });

  it('skips fixed candidate when active set already contains it (24h cooldown)', async () => {
    queryDuplicateAsinsMock.mockResolvedValue(new Set<string>(['B0C1JGD2T6']));
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B0C1JGD2T6') {
        return Promise.resolve({
          asin,
          title: 'カリタ コーヒーフィルター',
          currentPrice: 800,
          referencePrice: 1000,
          referenceSource: 'list-price' as const,
          dropPercent: 20,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedDescriptionsMock.mockResolvedValue(
      new Map<string, string>([['B0C1JGD2T6', '紹介文']]),
    );

    const { main } = await import('./draft.js');
    await main();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createPostedPageMock).not.toHaveBeenCalled();
  });

  it('creates draft with empty postText (Notion AI 運用)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(dealsResult([buildDeal({ asin: 'B000EMPTY', title: '国産 空文 Test' })]));
      }
      return Promise.resolve(dealsResult([]));
    });

    const { main } = await import('./draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(1);
    const draftArg = createDraftPageMock.mock.calls[0]?.[0] as { postText: string };
    expect(draftArg.postText).toBe('');
  });
});

describe('draft.main run-log integration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetAllMocks();
    process.env.PAAPI_PARTNER_TAG = 'test-tag-22';
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it('appends run-log with status=success when run completes normally', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(
          dealsResult([buildDeal({ asin: 'B000OK', title: '国産 OK' })], 42),
        );
      }
      return Promise.resolve(dealsResult([]));
    });

    const { main } = await import('./draft.js');
    await main();

    expect(appendRunLogMock).toHaveBeenCalledTimes(1);
    const arg = appendRunLogMock.mock.calls[0]?.[0] as {
      status: string;
      tokensLeft: number | null;
      draftsCreated: number;
      targetsSelected: number;
      errorMessage: string | null;
    };
    expect(arg.status).toBe('success');
    expect(arg.tokensLeft).toBe(42);
    expect(arg.draftsCreated).toBe(1);
    expect(arg.targetsSelected).toBe(1);
    expect(arg.errorMessage).toBeNull();
  });

  it('appends run-log with status=failure when queryDuplicateAsins throws', async () => {
    queryDuplicateAsinsMock.mockRejectedValueOnce(
      new Error('Request to Notion API has timed out'),
    );
    // process.exit(1) を吸収 — main() catch 末尾で呼ばれる
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);

    const { main } = await import('./draft.js');
    await expect(main()).rejects.toThrow('__exit__');

    expect(appendRunLogMock).toHaveBeenCalledTimes(1);
    const arg = appendRunLogMock.mock.calls[0]?.[0] as {
      status: string;
      errorMessage: string | null;
      draftsCreated: number;
    };
    expect(arg.status).toBe('failure');
    expect(arg.errorMessage).toBe('Request to Notion API has timed out');
    expect(arg.draftsCreated).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('appends run-log with status=partial when some createDraftPage fails', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(
          dealsResult([
            buildDeal({ asin: 'B000A', title: '国産 A' }),
            buildDeal({ asin: 'B000B', title: '国産 B' }),
          ]),
        );
      }
      return Promise.resolve(dealsResult([]));
    });
    // 1 件目は成功、2 件目は throw
    createDraftPageMock
      .mockResolvedValueOnce('page-1')
      .mockRejectedValueOnce(new Error('Notion 5xx'));

    const { main } = await import('./draft.js');
    await main();

    expect(appendRunLogMock).toHaveBeenCalledTimes(1);
    const arg = appendRunLogMock.mock.calls[0]?.[0] as {
      status: string;
      draftsCreated: number;
      targetsSelected: number;
    };
    expect(arg.status).toBe('partial');
    expect(arg.draftsCreated).toBe(1);
    expect(arg.targetsSelected).toBe(2);
  });
});
