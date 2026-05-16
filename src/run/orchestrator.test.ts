import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixedListing } from '../fixed-templates.js';

// 外部 I/O dependency をすべてモック化。各 test 内で mockResolved* を上書きしてシナリオを切替える。
const getDealsMock = vi.fn();
const checkAsinMock = vi.fn();
const getItemsMock = vi.fn();
const createDraftPageMock = vi.fn();
const createPostedPageMock = vi.fn();
const queryDuplicateAsinsMock = vi.fn();
const queryBlacklistAsinsMock = vi.fn();
const loadBlocklistMock = vi.fn();
const appendRunLogMock = vi.fn();
const fetchFixedListingsMock = vi.fn();
const dispatchMock = vi.fn();
const appendHistoryMock = vi.fn();
const readRecentAsinsMock = vi.fn();
const collectBrandHitsMock = vi.fn();

vi.mock('../pipelines/brand.js', () => ({
  collectBrandHits: (...args: unknown[]) => collectBrandHitsMock(...args),
}));

vi.mock('../keepa.js', () => ({
  getDeals: (...args: unknown[]) => getDealsMock(...args),
  checkAsin: (...args: unknown[]) => checkAsinMock(...args),
}));

vi.mock('../paapi.js', () => ({
  getItems: (...args: unknown[]) => getItemsMock(...args),
}));

vi.mock('../notion.js', () => ({
  createDraftPage: (...args: unknown[]) => createDraftPageMock(...args),
  createPostedPage: (...args: unknown[]) => createPostedPageMock(...args),
  queryDuplicateAsins: (...args: unknown[]) => queryDuplicateAsinsMock(...args),
  queryBlacklistAsins: (...args: unknown[]) => queryBlacklistAsinsMock(...args),
}));

vi.mock('../blocklist.js', () => ({
  loadBlocklist: (...args: unknown[]) => loadBlocklistMock(...args),
}));

vi.mock('../run-log.js', () => ({
  appendRunLog: (...args: unknown[]) => appendRunLogMock(...args),
}));

vi.mock('../fixed-templates.js', async () => {
  const actual = await vi.importActual<typeof import('../fixed-templates.js')>('../fixed-templates.js');
  return {
    // composeFixedPostText は pure fn なので実装を再利用。fetchFixedListings のみ mock。
    composeFixedPostText: actual.composeFixedPostText,
    fetchFixedListings: (...args: unknown[]) => fetchFixedListingsMock(...args),
  };
});

vi.mock('../posters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../posters/index.js')>('../posters/index.js');
  return {
    posters: actual.posters,
    anySucceeded: actual.anySucceeded,
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  };
});

vi.mock('../history.js', () => ({
  appendHistory: (...args: unknown[]) => appendHistoryMock(...args),
  readRecentAsins: (...args: unknown[]) => readRecentAsinsMock(...args),
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
  queryBlacklistAsinsMock.mockReset();
  loadBlocklistMock.mockReset();
  appendRunLogMock.mockReset();
  fetchFixedListingsMock.mockReset();
  dispatchMock.mockReset();
  appendHistoryMock.mockReset();
  readRecentAsinsMock.mockReset();
  collectBrandHitsMock.mockReset();

  // sane defaults: tokensLeft は null にして「設定無し」を示す
  // (各 test が個別カテゴリで mockImplementation すれば、その値が lastTokensLeft に反映される)
  getDealsMock.mockResolvedValue(dealsResult([], null));
  checkAsinMock.mockResolvedValue(null);
  getItemsMock.mockResolvedValue([]);
  createDraftPageMock.mockResolvedValue('page-mock-id');
  createPostedPageMock.mockResolvedValue('posted-page-mock-id');
  queryDuplicateAsinsMock.mockResolvedValue(new Set<string>());
  queryBlacklistAsinsMock.mockResolvedValue(new Set<string>());
  loadBlocklistMock.mockResolvedValue(new Set<string>());
  appendRunLogMock.mockResolvedValue(undefined);
  fetchFixedListingsMock.mockResolvedValue(new Map<string, FixedListing>());
  // 固定ASIN 即投稿経路は本 default だと dispatch が呼ばれずに済む (fetchFixedListings が空 Map)。
  // 投稿成功シナリオの test 内で dispatchMock.mockResolvedValueOnce({...}) を上書きする。
  dispatchMock.mockResolvedValue({ x: { ok: false }, bluesky: { ok: false } });
  appendHistoryMock.mockResolvedValue(undefined);
  readRecentAsinsMock.mockResolvedValue(new Set<string>());
  // brand 経路 default: 空配列 (個別 test で brand Candidate を返したい場合は上書きする)。
  collectBrandHitsMock.mockResolvedValue([]);
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
  referenceSource: 'week-avg' as const,
  ...overrides,
});

describe('orchestrator.main integration', () => {
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

    const { main } = await import('../draft.js');
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

    const { main } = await import('../draft.js');
    await main();

    const calledAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(calledAsins).toContain('B000NEW');
    expect(calledAsins).not.toContain('B000ACTIVE');
  });

  // PR-A3: activeAsins = Notion (primary) ∪ post-history.jsonl (secondary)。
  // jsonl 側にのみ存在する ASIN も draft 経路で skip されることを pin down する。
  it('drops candidates present in post-history.jsonl even when not in Notion (secondary guard)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(dealsResult([
          buildDeal({ asin: 'B0HISTORY', title: '国産 履歴のみ重複' }),
          buildDeal({ asin: 'B000NEW', title: '国産 新規' }),
        ]));
      }
      return Promise.resolve(dealsResult([]));
    });
    // Notion 側は空、history 側に B0HISTORY あり
    queryDuplicateAsinsMock.mockResolvedValue(new Set<string>());
    readRecentAsinsMock.mockResolvedValue(new Set(['B0HISTORY']));

    const { main } = await import('../draft.js');
    await main();

    const calledAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(calledAsins).toContain('B000NEW');
    expect(calledAsins).not.toContain('B0HISTORY');
  });

  // Notion ブラックリスト DB に登録された ASIN は cooldown 関係なく恒久除外される。
  // env 未設定 (queryBlacklistAsins が空 Set 返却) でも既存除外経路は維持される。
  it('drops candidates present in Notion blacklist DB (permanent block)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(dealsResult([
          buildDeal({ asin: 'B0BLACKLST', title: '国産 ブラックリスト対象' }),
          buildDeal({ asin: 'B000NEW', title: '国産 新規' }),
        ]));
      }
      return Promise.resolve(dealsResult([]));
    });
    queryDuplicateAsinsMock.mockResolvedValue(new Set<string>());
    readRecentAsinsMock.mockResolvedValue(new Set<string>());
    queryBlacklistAsinsMock.mockResolvedValue(new Set(['B0BLACKLST']));

    const { main } = await import('../draft.js');
    await main();

    const calledAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(calledAsins).toContain('B000NEW');
    expect(calledAsins).not.toContain('B0BLACKLST');
  });

  // blocklist.md (file) と Notion ブラックリスト DB は OR で適用される。
  // 片方にだけ存在する ASIN も両方にある ASIN も draft されない。
  it('unions blocklist.md and Notion blacklist DB (OR-applied)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(dealsResult([
          buildDeal({ asin: 'B000FILE0', title: '国産 md のみ' }),
          buildDeal({ asin: 'B000NDB00', title: '国産 Notion DB のみ' }),
          buildDeal({ asin: 'B000BOTH0', title: '国産 両方' }),
          buildDeal({ asin: 'B000PASS0', title: '国産 通過' }),
        ]));
      }
      return Promise.resolve(dealsResult([]));
    });
    loadBlocklistMock.mockResolvedValue(new Set(['B000FILE0', 'B000BOTH0']));
    queryBlacklistAsinsMock.mockResolvedValue(new Set(['B000NDB00', 'B000BOTH0']));

    const { main } = await import('../draft.js');
    await main();

    const calledAsins = createDraftPageMock.mock.calls.map((c) => (c[0] as { asin: string }).asin);
    expect(calledAsins).toContain('B000PASS0');
    expect(calledAsins).not.toContain('B000FILE0');
    expect(calledAsins).not.toContain('B000NDB00');
    expect(calledAsins).not.toContain('B000BOTH0');
  });

  it('caps total drafts at MAX_POSTS_PER_RUN (overflow 有効化、food 単独で 60 件を超えない)', async () => {
    // food 100 件返しても MAX_POSTS_PER_RUN=60 で頭打ちになる。
    // CATEGORY_QUOTA.food=10 (base) + Pass2 overflow が food のみで埋める → 計 60。
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(
          dealsResult(
            Array.from({ length: 100 }, (_, i) =>
              buildDeal({ asin: `B${String(i).padStart(3, '0')}` }),
            ),
          ),
        );
      }
      return Promise.resolve(dealsResult([]));
    });

    const { main } = await import('../draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(60);
  });

  it('falls back to Keepa-only when PA-API getItems throws', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(dealsResult([buildDeal({ asin: 'B000FALL', title: '国産 フォールバック商品' })]));
      }
      return Promise.resolve(dealsResult([]));
    });
    getItemsMock.mockRejectedValueOnce(new Error('PA-API down'));

    const { main } = await import('../draft.js');
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

    const { main } = await import('../draft.js');
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

    const { main } = await import('../draft.js');
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

    const { main } = await import('../draft.js');
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        ['B0C1JGD2T6', { description: 'カリタの定番フィルター。1〜2人用。' }],
      ]),
    );
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/post/1' },
      bluesky: { ok: true, url: 'https://bsky.app/post/1' },
    });

    const { main } = await import('../draft.js');
    await main();

    // deals 経路: food (8 件入力 → quota=10 範囲内、全件採用)。固定ASIN は混ざらない
    expect(createDraftPageMock).toHaveBeenCalledTimes(8);
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
    fetchFixedListingsMock.mockResolvedValue(new Map<string, FixedListing>());  // 空 Map

    const { main } = await import('../draft.js');
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([['B0C1JGD2T6', { description: '紹介文' }]]),
    );
    dispatchMock.mockResolvedValue({ x: { ok: false }, bluesky: { ok: false } });

    const { main } = await import('../draft.js');
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        ['B07B5CD8NY', { description: 'Y字フロスでスキマケアに最適。' }],
      ]),
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

    const { main } = await import('../draft.js');
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        ['B0C1JGD2T6', { description: 'カリタの定番フィルター。' }],
      ]),
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

    const { main } = await import('../draft.js');
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        ['B0C1JGD2T6', { description: 'カリタの定番フィルター。' }],
      ]),
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

    const { main } = await import('../draft.js');
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([['B07B5CD8NY', { description: 'Y字フロス。' }]]),
    );
    getItemsMock.mockResolvedValue([]);  // PA-API 空レスポンス

    const { main } = await import('../draft.js');
    await main();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createPostedPageMock).not.toHaveBeenCalled();
  });

  it('skips fixed candidate when active set already contains it (30-day cooldown)', async () => {
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([['B0C1JGD2T6', { description: '紹介文' }]]),
    );

    const { main } = await import('../draft.js');
    await main();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createPostedPageMock).not.toHaveBeenCalled();
  });

  it('uses manual reference price when SavingBasis is missing and Keepa drop is below threshold', async () => {
    // B07B5CD8NY 想定: current=1080, Keepa fallback 1% (閾値未満), SavingBasis 無し。
    // Notion 手動入力 参考定価 ¥1,490 で dropPercent = round((1490-1080)/1490*100) = 28 → 投稿される。
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        ['B07B5CD8NY', { description: 'Y字フロス。', manualReferencePrice: 1490 }],
      ]),
    );
    getItemsMock.mockResolvedValue([]);  // SavingBasis 無し
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/p' },
      bluesky: { ok: true, url: 'https://bsky.app/p' },
    });

    const { main } = await import('../draft.js');
    await main();

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

  it('prefers SavingBasis over manual reference price when both present', async () => {
    // SavingBasis (¥4,400) と manualReferencePrice (¥5,000) が両方ある場合、SavingBasis を優先。
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B09JL4R6SX') {
        return Promise.resolve({
          asin,
          title: 'HARIO ドリッパー',
          currentPrice: 2903,
          referencePrice: 4399,
          referenceSource: 'list-price' as const,
          dropPercent: 34,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        ['B09JL4R6SX', { description: 'HARIO ドリッパー。', manualReferencePrice: 5000 }],
      ]),
    );
    getItemsMock.mockResolvedValue([
      {
        asin: 'B09JL4R6SX',
        title: 'HARIO ドリッパー',
        imageUrl: '',
        currentPrice: 2903,
        affiliateUrl: 'https://www.amazon.co.jp/dp/B09JL4R6SX',
        savingBasis: 4400,
      },
    ]);
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/p' },
      bluesky: { ok: true, url: 'https://bsky.app/p' },
    });

    const { main } = await import('../draft.js');
    await main();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchInput = dispatchMock.mock.calls[0]?.[1] as { text: string };
    // SavingBasis 4400 ベース: round((4400-2903)/4400*100) = 34
    expect(dispatchInput.text).toContain('【34% OFF】');
    expect(dispatchInput.text).toContain('¥4,400');
    expect(dispatchInput.text).toContain('¥2,903');

    expect(createPostedPageMock).toHaveBeenCalledTimes(1);
    const postedArg = createPostedPageMock.mock.calls[0]?.[0] as { referencePrice: number };
    expect(postedArg.referencePrice).toBe(4400);  // manual 5000 ではなく SavingBasis 4400
  });

  it('falls back to Keepa when manualReferencePrice <= current (defensive)', async () => {
    // manualReferencePrice (¥1,000) が current (¥1,080) 以下 → manual 採用しない → Keepa fallback。
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B07B5CD8NY') {
        return Promise.resolve({
          asin,
          title: 'クリニカ デンタルフロス',
          currentPrice: 1080,
          referencePrice: 1100,
          referenceSource: 'new-avg' as const,
          dropPercent: 20,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        ['B07B5CD8NY', { description: 'Y字フロス。', manualReferencePrice: 1000 }],
      ]),
    );
    getItemsMock.mockResolvedValue([]);  // SavingBasis 無し
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/p' },
      bluesky: { ok: true, url: 'https://bsky.app/p' },
    });

    const { main } = await import('../draft.js');
    await main();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchInput = dispatchMock.mock.calls[0]?.[1] as { text: string };
    expect(dispatchInput.text).toContain('【20% OFF】');
    expect(dispatchInput.text).toContain('¥1,100');
    expect(dispatchInput.text).toContain('¥1,080');

    const postedArg = createPostedPageMock.mock.calls[0]?.[0] as { referencePrice: number };
    expect(postedArg.referencePrice).toBe(1100);  // Keepa fallback
  });

  it('falls back to Keepa when manualReferencePrice drop exceeds sanity cap (>95%)', async () => {
    // manualReferencePrice (¥999,999) は current (¥1,000) に対して 99.9% drop > 95% cap → reject。
    // Keepa fallback (20%, ¥1,250) に落とす。current は MIN_PRICE_YEN (500) より上にしておく。
    checkAsinMock.mockImplementation((asin: string) => {
      if (asin === 'B0C1JGD2T6') {
        return Promise.resolve({
          asin,
          title: 'カリタ コーヒーフィルター',
          currentPrice: 1000,
          referencePrice: 1250,
          referenceSource: 'list-price' as const,
          dropPercent: 20,
        });
      }
      return Promise.resolve(null);
    });
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        ['B0C1JGD2T6', { description: 'カリタの定番フィルター。', manualReferencePrice: 999999 }],
      ]),
    );
    getItemsMock.mockResolvedValue([]);  // SavingBasis 無し
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/p' },
      bluesky: { ok: true, url: 'https://bsky.app/p' },
    });

    const { main } = await import('../draft.js');
    await main();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchInput = dispatchMock.mock.calls[0]?.[1] as { text: string };
    expect(dispatchInput.text).toContain('【20% OFF】');
    expect(dispatchInput.text).toContain('¥1,250');
    expect(dispatchInput.text).toContain('¥1,000');

    const postedArg = createPostedPageMock.mock.calls[0]?.[0] as { referencePrice: number };
    expect(postedArg.referencePrice).toBe(1250);  // Keepa fallback (manual 999999 が cap 超過で reject)
  });

  it('creates draft with empty postText (Notion AI 運用)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(dealsResult([buildDeal({ asin: 'B000EMPTY', title: '国産 空文 Test' })]));
      }
      return Promise.resolve(dealsResult([]));
    });

    const { main } = await import('../draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(1);
    const draftArg = createDraftPageMock.mock.calls[0]?.[0] as { postText: string };
    expect(draftArg.postText).toBe('');
  });

  // PR-volume-1: deals/brand 経路でも PA-API SavingBasis があれば reference を再解決し、
  // Amazon UI の打消し線価格に整合させる。Notion DB に書き込む値も SavingBasis 由来 に上書きされる。
  it('re-resolves deals reference with PA-API SavingBasis when available', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(
          dealsResult([
            buildDeal({
              asin: 'B0SAVING1',
              title: '国産 値下げ商品',
              currentPrice: 800,
              referencePrice: 1000,  // Keepa week-avg fallback
              dropPercent: 20,
            }),
          ]),
        );
      }
      return Promise.resolve(dealsResult([]));
    });
    getItemsMock.mockResolvedValue([
      {
        asin: 'B0SAVING1',
        title: '国産 値下げ商品 (PA-API)',
        imageUrl: '',
        currentPrice: 800,
        affiliateUrl: 'https://www.amazon.co.jp/dp/B0SAVING1',
        savingBasis: 1500,  // Amazon UI 打消し線 ¥1,500
      },
    ]);

    const { main } = await import('../draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(1);
    const draftArg = createDraftPageMock.mock.calls[0]?.[0] as {
      referencePrice: number;
      dropPercent: number;
      referenceSource: string;
    };
    // SavingBasis (1500) で再計算: (1500-800)/1500 = 46.6% → 47
    expect(draftArg.referencePrice).toBe(1500);
    expect(draftArg.dropPercent).toBe(47);
    expect(draftArg.referenceSource).toBe('paapi-saving-basis');
  });

  it('drops deals candidate when SavingBasis re-resolution pushes drop below threshold', async () => {
    // Keepa では 20% drop だが SavingBasis 観点では small (10%) → DROP_THRESHOLD_PERCENT (15) 未満 → skip。
    // ただし SavingBasis ≤ current の場合は applySavingBasis が candidate を元のまま返すので、
    // ここでは「SavingBasis > current でも drop が threshold 未満」になるシナリオを組む。
    // current=900, savingBasis=1000 → drop=10% < 15% → skip。
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(
          dealsResult([
            buildDeal({
              asin: 'B0SMALLDR',
              title: '国産 小さい値下げ',
              currentPrice: 900,
              referencePrice: 1125,  // Keepa: 20% drop
              dropPercent: 20,
            }),
          ]),
        );
      }
      return Promise.resolve(dealsResult([]));
    });
    getItemsMock.mockResolvedValue([
      {
        asin: 'B0SMALLDR',
        title: '国産 小さい値下げ',
        imageUrl: '',
        currentPrice: 900,
        affiliateUrl: 'https://www.amazon.co.jp/dp/B0SMALLDR',
        savingBasis: 1000,  // 10% drop
      },
    ]);

    const { main } = await import('../draft.js');
    await main();

    expect(createDraftPageMock).not.toHaveBeenCalled();
  });

  it('keeps Keepa reference when SavingBasis exceeds sanity cap', async () => {
    // savingBasis=99999 / current=800 → 99% drop > MAX_REASONABLE_DROP_PERCENT (95) → reject、
    // Keepa fallback (20%) で draft 作成される。
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(
          dealsResult([
            buildDeal({
              asin: 'B0EXCESS1',
              title: '国産 異常値 SavingBasis',
              currentPrice: 800,
              referencePrice: 1000,
              dropPercent: 20,
            }),
          ]),
        );
      }
      return Promise.resolve(dealsResult([]));
    });
    getItemsMock.mockResolvedValue([
      {
        asin: 'B0EXCESS1',
        title: '国産 異常値 SavingBasis',
        imageUrl: '',
        currentPrice: 800,
        affiliateUrl: 'https://www.amazon.co.jp/dp/B0EXCESS1',
        savingBasis: 99999,
      },
    ]);

    const { main } = await import('../draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(1);
    const draftArg = createDraftPageMock.mock.calls[0]?.[0] as {
      referencePrice: number;
      dropPercent: number;
      referenceSource: string;
    };
    // Keepa fallback (week-avg) のまま
    expect(draftArg.referencePrice).toBe(1000);
    expect(draftArg.dropPercent).toBe(20);
    expect(draftArg.referenceSource).toBe('week-avg');
  });

  // PR-#47: deals/brand 経路の draft は amazonUrl=null で作成し、bon がサクラチェッカー +
  // Amazon で affiliate 短縮リンクを取得して手動入力する運用に統一する。
  it('createDraftPage receives amazonUrl=null for deals path (manual fill-in workflow)', async () => {
    getDealsMock.mockImplementation((categoryId: number) => {
      if (categoryId === 57239051) {
        return Promise.resolve(dealsResult([buildDeal({ asin: 'B000DEAL', title: '国産 商品' })]));
      }
      return Promise.resolve(dealsResult([]));
    });

    const { main } = await import('../draft.js');
    await main();

    expect(createDraftPageMock).toHaveBeenCalledTimes(1);
    const draftArg = createDraftPageMock.mock.calls[0]?.[0] as { asin: string; amazonUrl: string | null };
    expect(draftArg.asin).toBe('B000DEAL');
    expect(draftArg.amazonUrl).toBeNull();
  });

  // PR-#47: 固定ASIN DB に bon が入力した短縮リンク (amzn.to/...) を SNS 投稿 + Notion 記録の双方で使う。
  it('fixed-direct uses listing.amazonUrl (short link) when present, in both SNS post and createPostedPage', async () => {
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        [
          'B0C1JGD2T6',
          {
            description: 'カリタの定番フィルター。',
            amazonUrl: 'https://amzn.to/short-link-abc',
          },
        ],
      ]),
    );
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/post/1' },
      bluesky: { ok: true, url: 'https://bsky.app/post/1' },
    });

    const { main } = await import('../draft.js');
    await main();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchInput = dispatchMock.mock.calls[0]?.[1] as { text: string };
    expect(dispatchInput.text).toContain('https://amzn.to/short-link-abc');
    expect(dispatchInput.text).not.toContain('?tag=');

    expect(createPostedPageMock).toHaveBeenCalledTimes(1);
    const postedArg = createPostedPageMock.mock.calls[0]?.[0] as { amazonUrl: string | null };
    expect(postedArg.amazonUrl).toBe('https://amzn.to/short-link-abc');
  });

  // PR-#47: 固定ASIN DB に Amazon URL 未設定の場合は buildAffiliateUrl の generic URL に fallback。
  // SNS 投稿 break 防止のための defense (運用上は bon が短縮リンクを必ず入れる前提)。
  it('fixed-direct falls back to buildAffiliateUrl when listing.amazonUrl is undefined', async () => {
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
    fetchFixedListingsMock.mockResolvedValue(
      new Map<string, FixedListing>([
        ['B0C1JGD2T6', { description: 'カリタの定番フィルター。' }],  // amazonUrl 未設定
      ]),
    );
    dispatchMock.mockResolvedValue({
      x: { ok: true, url: 'https://x.com/post/1' },
      bluesky: { ok: true, url: 'https://bsky.app/post/1' },
    });

    const { main } = await import('../draft.js');
    await main();

    const dispatchInput = dispatchMock.mock.calls[0]?.[1] as { text: string };
    expect(dispatchInput.text).toContain('https://www.amazon.co.jp/dp/B0C1JGD2T6?tag=test-tag-22');

    const postedArg = createPostedPageMock.mock.calls[0]?.[0] as { amazonUrl: string | null };
    expect(postedArg.amazonUrl).toBe('https://www.amazon.co.jp/dp/B0C1JGD2T6?tag=test-tag-22');
  });
});

describe('orchestrator.main run-log integration', () => {
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

    const { main } = await import('../draft.js');
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

    const { main } = await import('../draft.js');
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

  it('appends run-log with status=failure when queryBlacklistAsins throws (Notion fatal policy)', async () => {
    queryBlacklistAsinsMock.mockRejectedValueOnce(
      new Error('Notion blacklist DB 503'),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);

    const { main } = await import('../draft.js');
    await expect(main()).rejects.toThrow('__exit__');

    expect(appendRunLogMock).toHaveBeenCalledTimes(1);
    const arg = appendRunLogMock.mock.calls[0]?.[0] as {
      status: string;
      errorMessage: string | null;
    };
    expect(arg.status).toBe('failure');
    expect(arg.errorMessage).toBe('Notion blacklist DB 503');
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

    const { main } = await import('../draft.js');
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
