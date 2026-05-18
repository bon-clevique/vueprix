import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildKeepaProduct } from './deals.js';
import { CATEGORY_QUOTA, KEEPA_CATEGORIES } from '../config.js';
import { KeepaTokenGuard } from '../keepa-token-guard.js';
import type { Candidate } from '../types.js';
import type { Deal } from '../keepa.js';
import { logger } from '../logger.js';

// pipelines/deals.ts の pure 関数の unit test。
// collectDeals は外部 I/O (Keepa) を呼ぶため orchestrator.test.ts の integration 経由でも検証されるが、
// Phase 3 (logical-forging-lerdorf) で adaptive pagination を導入したため、page loop の挙動を
// pipelines/deals.test.ts でも pin する。3 ケース: (a) 1 page で quota 充足、(b) max pages まで loop、
// (c) token-low skip。orchestrator.test.ts の mock を流用すると複雑になるため、ここでは
// vi.mock で getDeals を直接 mock し、KEEPA_DEAL_PAGE_MAX も 3 のまま evaluate する。

// vi.hoisted で mock 内から参照する変数を持ち上げる (vi.mock factory が file top に hoist されるため)。
const { getDealsMock } = vi.hoisted(() => ({
  getDealsMock: vi.fn(),
}));

vi.mock('../keepa.js', () => ({
  getDeals: (...args: unknown[]) => getDealsMock(...args),
  // pipelines/deals.ts は KEEPA_DEAL_PAGE_MAX を参照する。Phase 3 の実際の上限である 3 を保持する。
  KEEPA_DEAL_PAGE_MAX: 3,
}));

// passesTitleWhitelist は category ごとに異なる regex を持つ。本 test では adaptive pagination の
// page loop 挙動のみを pin したいので、全 category で常に通る挙動に固定する (title-filter 自身の
// test は title-filter.test.ts で担保済)。
vi.mock('../title-filter.js', () => ({
  passesTitleWhitelist: () => true,
}));

describe('buildKeepaProduct', () => {
  const candidate: Candidate = {
    asin: 'B0DEMO0001',
    title: 'Demo product',
    currentPrice: 850,
    referencePrice: 1000,
    dropPercent: 15,
    source: 'deals',
    category: 'food',
    referenceSource: 'week-avg',
  };

  it('produces a minimal product info (title + currentPrice) from a Candidate', () => {
    const product = buildKeepaProduct(candidate);
    expect(product.title).toBe('Demo product');
    expect(product.currentPrice).toBe(850);
    // dead fields (asin / imageUrl / affiliateUrl) は本 fn の戻り値から削除済 — pin で固定。
    expect(product).toEqual({ title: 'Demo product', currentPrice: 850 });
  });

  it('passes through arbitrary title / price untouched', () => {
    const c: Candidate = { ...candidate, title: 'モバイルバッテリー 10000mAh', currentPrice: 2980 };
    const product = buildKeepaProduct(c);
    expect(product.title).toBe('モバイルバッテリー 10000mAh');
    expect(product.currentPrice).toBe(2980);
  });
});

// Phase 3 (logical-forging-lerdorf) Step 3.3: collectDeals の adaptive page loop を pin。
// KEEPA_CATEGORIES (config.ts) は 7 件 (food / health / pc-desk / gaming / audio / kitchen / stationery)。
// 本 describe では title whitelist を mock で常時 true 化しているため、deal の title は任意で良い。
describe('collectDeals (adaptive pagination)', () => {
  const dealOf = (asin: string, currentPrice = 800, referencePrice = 1000): Deal => ({
    asin,
    title: `dummy ${asin}`,
    currentPrice,
    referencePrice,
    dropPercent: 20,
    referenceSource: 'week-avg',
  });

  // n 件分の Deal を生成。ASIN は test ごとに区別しやすい prefix を付ける。
  const buildPayload = (prefix: string, n: number): Deal[] =>
    Array.from({ length: n }, (_, i) => dealOf(`${prefix}${String(i).padStart(5, '0')}`));

  // 全 category について、最大 quota (food=10) 以上の deals を返す mock。
  // food=10 / health=8 / pc-desk=5 / kitchen=5 / stationery=5 / audio=3 / gaming=2。
  // 1 page で全 category が quota 充足 → 各 category page=0 のみで loop break。
  const enoughForAnyQuota = 10;

  beforeEach(() => {
    getDealsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // (a) 1 page で quota 充足 → 各 category で getDeals は page=0 のみ 1 回呼ばれる。
  it('(a) breaks page loop at page=0 when quota is fulfilled in single page', async () => {
    getDealsMock.mockImplementation((_categoryId: number, _page: number) =>
      Promise.resolve({
        deals: buildPayload('A', enoughForAnyQuota),
        tokensLeft: 100,
      }),
    );

    const { collectDeals } = await import('./deals.js');
    const guard = new KeepaTokenGuard();
    const result = await collectDeals(guard);

    // KEEPA_CATEGORIES (7 件) × 1 page = 7 call。各 call の page 引数は 0。
    expect(getDealsMock).toHaveBeenCalledTimes(KEEPA_CATEGORIES.length);
    for (const call of getDealsMock.mock.calls) {
      expect(call[1]).toBe(0);
    }
    // food category (quota=10) は 10 件 push されているはず。
    const foodCandidates = result.candidates.filter((c) => c.category === 'food');
    expect(foodCandidates.length).toBe(CATEGORY_QUOTA.food);
  });

  // (b) quota 未充足 → KEEPA_DEAL_PAGE_MAX (=3) 回まで loop する。
  // 各 page で 1 件のみ返す (food quota=10 に到達しない)。ただし gaming (quota=2) は
  // 2 page 目で quota 達成 → 3 page 目を skip する。category 別 expected を分けて確認する。
  it('(b) loops up to KEEPA_DEAL_PAGE_MAX when quota not fulfilled (per-category)', async () => {
    getDealsMock.mockImplementation((categoryId: number, page: number) =>
      Promise.resolve({
        deals: [dealOf(`C${categoryId}P${page}X`.padEnd(10, 'Z').slice(0, 10))],
        tokensLeft: 100,
      }),
    );

    const { collectDeals } = await import('./deals.js');
    const guard = new KeepaTokenGuard();
    await collectDeals(guard);

    // food (57239051) は quota=10 に到達しないため 3 page 全て呼ばれる (page=0, 1, 2)。
    const foodCalls = getDealsMock.mock.calls.filter((c) => c[0] === 57239051);
    expect(foodCalls.map((c) => c[1])).toEqual([0, 1, 2]);
    // health (160384011) も quota=8 で同様に 3 page 呼ばれる。
    const healthCalls = getDealsMock.mock.calls.filter((c) => c[0] === 160384011);
    expect(healthCalls.map((c) => c[1])).toEqual([0, 1, 2]);
    // gaming (637394) は quota=2 → page=0 で 1 件、page=1 で 1 件 (累計 2 = quota) → 達成して break。
    // page=2 は呼ばれない。
    const gamingCalls = getDealsMock.mock.calls.filter((c) => c[0] === 637394);
    expect(gamingCalls.map((c) => c[1])).toEqual([0, 1]);
  });

  // (c) token-low skip: guard.shouldCall() が page=1 の前で false を返すと、page=0 だけ完了して
  // page=1 進入直前で warn log + break (page=2 までは到達しない、break で page loop 抜けるため)。
  // 本 test では最初の category の page=0 で tokensLeft=5 を返した時点で guard が 5 (< threshold=10) を
  // 持ち、以降の全 category × 全 page を skip する。
  // 結果として: 最初の category (food) だけ page=0 で 1 call、それ以降の category は全 skip。
  // warn log: 最初の category page=1 で break 直前に 1 回 + 残り 6 category × page=0 進入直前で 6 回 = 7 回。
  it('(c) skips remaining pages and warns when guard.shouldCall() returns false (token-low)', async () => {
    getDealsMock.mockImplementation((_categoryId: number, _page: number) =>
      Promise.resolve({ deals: [dealOf('B000PHASE3')], tokensLeft: 5 }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const { collectDeals } = await import('./deals.js');
    const guard = new KeepaTokenGuard();
    await collectDeals(guard);

    // 最初の category (food=57239051) で page=0 のみ呼ばれる。それ以降の category では全 page skip。
    expect(getDealsMock).toHaveBeenCalledTimes(1);
    expect(getDealsMock.mock.calls[0]?.[0]).toBe(57239051);
    expect(getDealsMock.mock.calls[0]?.[1]).toBe(0);

    // token-low-skip warn log:
    //   - 最初の category (food) の page=1 進入直前で 1 回 (break するため page=2 はそもそも開始しない)
    //   - 残り 6 category の page=0 進入直前で 6 回
    // 合計 7 回。
    const tokenLowWarns = warnSpy.mock.calls.filter(
      (c) => c[1] === 'token-low-skip',
    );
    expect(tokenLowWarns.length).toBe(KEEPA_CATEGORIES.length);
    // 最初の warn は food / page=1 / remaining=2 (KEEPA_DEAL_PAGE_MAX(3) - page(1) = 2)。
    expect(tokenLowWarns[0]?.[2]).toMatchObject({
      categoryId: 57239051,
      page: 1,
      remaining: 2,
    });
    // 2 番目の warn は次 category (160384011=health) / page=0 / remaining=3。
    expect(tokenLowWarns[1]?.[2]).toMatchObject({
      categoryId: 160384011,
      page: 0,
      remaining: 3,
    });
  });
});
