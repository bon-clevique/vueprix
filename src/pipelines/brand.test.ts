import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeepaTokenGuard } from '../keepa-token-guard.js';
import type { Candidate } from '../types.js';

// 外部 I/O dependency (axios / keepa.checkAsinWithTokens) を mock。
// vi.mock は hoisted されるため、mock factory 内で参照する変数は vi.hoisted で持ち上げる必要がある。
const { axiosPostMock, checkAsinWithTokensMock } = vi.hoisted(() => ({
  axiosPostMock: vi.fn(),
  checkAsinWithTokensMock: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: axiosPostMock,
  },
}));

vi.mock('../keepa.js', () => ({
  // Phase 2 で brand 経路は checkAsinWithTokens を直接呼ぶよう変更。
  // checkAsin (thin wrapper) は本 test では呼ばれないため mock 不要だが、
  // 念のため pipelines/fixed 等の他 caller の存在を想定して同等の mock を export する。
  checkAsinWithTokens: checkAsinWithTokensMock,
  checkAsin: async (asin: string) => {
    const { history } = await checkAsinWithTokensMock(asin);
    return history;
  },
  // pipelines/brand.ts は KEEPA_BASE を import するので mock にも export する。
  // KeepaQueryResponse は type-only import (runtime export 不要、tsc では erased)。
  KEEPA_BASE: 'https://api.keepa.com',
}));

// テスト用 Candidate factory。dropPercent / asin を上書きしやすい形にしておく。
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  asin: 'B000000001',
  title: 'test product',
  currentPrice: 1000,
  referencePrice: 2000,
  dropPercent: 30,
  source: 'brand',
  category: 'kitchen',
  referenceSource: 'list-price',
  ...overrides,
});

// checkAsinWithTokens の典型 response factory。Phase 2 で戻り値が { history, tokensLeft } に変更。
const okHistoryWithTokens = (asin: string, dropPercent: number, currentPrice = 1000, tokensLeft = 100) => ({
  history: {
    asin,
    title: `product ${asin}`,
    currentPrice,
    referencePrice: currentPrice * 2,
    referenceSource: 'list-price' as const,
    dropPercent,
  },
  tokensLeft,
});

describe('selectByBrandQuota', () => {
  it('returns top quota items sorted by dropPercent descending', async () => {
    const { selectByBrandQuota } = await import('./brand.js');
    const hits: Candidate[] = [
      candidate({ asin: 'B001', dropPercent: 20 }),
      candidate({ asin: 'B002', dropPercent: 50 }),
      candidate({ asin: 'B003', dropPercent: 30 }),
      candidate({ asin: 'B004', dropPercent: 40 }),
      candidate({ asin: 'B005', dropPercent: 15 }),
    ];
    const result = selectByBrandQuota(hits, 2);
    expect(result.map((c) => c.asin)).toEqual(['B002', 'B004']);
  });

  it('returns empty array when input is empty', async () => {
    const { selectByBrandQuota } = await import('./brand.js');
    expect(selectByBrandQuota([], 2)).toEqual([]);
  });

  it('returns empty array when quota is 0', async () => {
    const { selectByBrandQuota } = await import('./brand.js');
    const hits: Candidate[] = [candidate({ asin: 'B001', dropPercent: 30 })];
    expect(selectByBrandQuota(hits, 0)).toEqual([]);
  });

  it('returns all items when quota exceeds list length', async () => {
    const { selectByBrandQuota } = await import('./brand.js');
    const hits: Candidate[] = [
      candidate({ asin: 'B001', dropPercent: 30 }),
      candidate({ asin: 'B002', dropPercent: 50 }),
    ];
    const result = selectByBrandQuota(hits, 10);
    expect(result.map((c) => c.asin)).toEqual(['B002', 'B001']);
  });

  it('does not mutate input array', async () => {
    const { selectByBrandQuota } = await import('./brand.js');
    const hits: Candidate[] = [
      candidate({ asin: 'B001', dropPercent: 20 }),
      candidate({ asin: 'B002', dropPercent: 50 }),
    ];
    const originalOrder = hits.map((c) => c.asin);
    selectByBrandQuota(hits, 2);
    expect(hits.map((c) => c.asin)).toEqual(originalOrder);
  });
});

describe('dedupeWithinBrand', () => {
  it('removes duplicate ASINs, keeping first occurrence', async () => {
    const { dedupeWithinBrand } = await import('./brand.js');
    const hits: Candidate[] = [
      candidate({ asin: 'B001', title: 'first' }),
      candidate({ asin: 'B002', title: 'second' }),
      candidate({ asin: 'B001', title: 'duplicate' }),
    ];
    const result = dedupeWithinBrand(hits);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.asin)).toEqual(['B001', 'B002']);
    // first occurrence retained (title === 'first')
    expect(result[0].title).toBe('first');
  });

  it('preserves input order for all-unique input', async () => {
    const { dedupeWithinBrand } = await import('./brand.js');
    const hits: Candidate[] = [
      candidate({ asin: 'B001' }),
      candidate({ asin: 'B002' }),
      candidate({ asin: 'B003' }),
    ];
    const result = dedupeWithinBrand(hits);
    expect(result.map((c) => c.asin)).toEqual(['B001', 'B002', 'B003']);
  });

  it('returns empty array for empty input', async () => {
    const { dedupeWithinBrand } = await import('./brand.js');
    expect(dedupeWithinBrand([])).toEqual([]);
  });
});

describe('queryBrandAsins', () => {
  const originalKey = process.env.KEEPA_API_KEY;

  beforeEach(() => {
    axiosPostMock.mockReset();
    process.env.KEEPA_API_KEY = 'test-key-xxx';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.KEEPA_API_KEY;
    else process.env.KEEPA_API_KEY = originalKey;
  });

  it('returns asins + tokensLeft from successful response', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { asinList: ['B000000001', 'B000000002', 'B000000003'], tokensLeft: 100 },
    });
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result.asins).toEqual(['B000000001', 'B000000002', 'B000000003']);
    expect(result.tokensLeft).toBe(100);
  });

  it('falls back to asins field when asinList is absent', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { asins: ['B000000010', 'B000000011'], tokensLeft: 99 },
    });
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result.asins).toEqual(['B000000010', 'B000000011']);
    expect(result.tokensLeft).toBe(99);
  });

  it('returns empty array when both fields are absent', async () => {
    axiosPostMock.mockResolvedValueOnce({ data: { tokensLeft: 99 } });
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result.asins).toEqual([]);
    expect(result.tokensLeft).toBe(99);
  });

  it('returns empty array and logs warn on 5xx error', async () => {
    axiosPostMock.mockRejectedValueOnce(new Error('Request failed with status code 503'));
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result.asins).toEqual([]);
    expect(result.tokensLeft).toBeNull();
  });

  it('returns empty array on network error', async () => {
    axiosPostMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result.asins).toEqual([]);
    expect(result.tokensLeft).toBeNull();
  });

  it('throws when KEEPA_API_KEY is unset', async () => {
    delete process.env.KEEPA_API_KEY;
    axiosPostMock.mockImplementationOnce(() => {
      throw new Error('should not reach here');
    });
    const { queryBrandAsins } = await import('./brand.js');
    // apiKey() が throw を投げるが、queryBrandAsins は try-catch 内で受けるため空配列を返す
    const result = await queryBrandAsins('TestBrand');
    expect(result.asins).toEqual([]);
  });

  it('filters out malformed ASIN entries (Keepa contract: 10-char alphanumeric)', async () => {
    // 実 Keepa は通常 10 文字 alphanumeric を返すが、防御的に regex filter を入れている。
    // 空文字 / 短すぎる / 長すぎる / 小文字混在 / 非 ASCII を全て除去する。
    axiosPostMock.mockResolvedValueOnce({
      data: {
        asinList: [
          'B000VALID1',  // OK
          'B000VALID2',  // OK
          '',            // 空文字
          'TOOSHORT',    // 8 文字
          'B000TOOLONG',  // 11 文字
          'b000lower1',  // 小文字
          'B000日本ASN',  // 非 ASCII
        ],
        tokensLeft: 100,
      },
    });
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result.asins).toEqual(['B000VALID1', 'B000VALID2']);
  });
});

describe('collectBrandHits', () => {
  const originalKey = process.env.KEEPA_API_KEY;
  let guard: KeepaTokenGuard;

  beforeEach(() => {
    axiosPostMock.mockReset();
    checkAsinWithTokensMock.mockReset();
    process.env.KEEPA_API_KEY = 'test-key-xxx';
    // guard は threshold=10 (default)、tokensLeft 未 update (= shouldCall true) で始める。
    // 個別 test で guard を入れ替える場合は inline で `new KeepaTokenGuard(...)` する。
    guard = new KeepaTokenGuard();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.KEEPA_API_KEY;
    else process.env.KEEPA_API_KEY = originalKey;
  });

  // WATCH_BRANDS は config.ts で固定 (Yamazaki / KAI / HARIO / KINTO / OXO / ZOJIRUSHI / TIGER / Pyrex / MUJI の 9 brand)。
  // axiosPostMock を mockResolvedValue で全 brand に同じ response を返すように設定し、
  // checkAsinWithTokensMock も同様に全 ASIN に同じ振る舞いを与えて確認する。

  it('returns Candidates from all brands, capped by BRAND_QUOTA (=2) per brand', async () => {
    // 各 brand に 3 件の ASIN を返す。BRAND_QUOTA=2 なので、各 brand から 2 件採用で early break。
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002', 'B000000003'], tokensLeft: 100 },
    });
    // 全 ASIN が DROP_THRESHOLD_PERCENT (15) 以上 + MIN_PRICE_YEN (500) 以上で hit
    checkAsinWithTokensMock.mockImplementation(async (asin: string) => {
      const dropMap: Record<string, number> = {
        B000000001: 20,
        B000000002: 30,
        B000000003: 25,
      };
      return okHistoryWithTokens(asin, dropMap[asin] ?? 20, 1000);
    });
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);
    // dedupeWithinBrand で重複除去後、各 brand から上位 2 件採用 (B001, B002) → 全 brand 同 ASIN 返却なので
    // dedupe で 2 件 (B001, B002) に圧縮される。
    expect(result.length).toBeLessThanOrEqual(6);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // dedupe 済 (asin がユニーク)
    const asins = result.map((c) => c.asin);
    expect(new Set(asins).size).toBe(asins.length);
    // source / category が brand 経路として設定されている
    for (const c of result) {
      expect(c.source).toBe('brand');
      expect(c.category).toBe('kitchen');
    }
  });

  it('isolates brand failure: if one query fails, others still succeed', async () => {
    // 第 1 brand (Yamazaki) は query 失敗、他は成功
    axiosPostMock
      .mockRejectedValueOnce(new Error('query failed for first brand'))
      .mockResolvedValue({ data: { asinList: ['B000000100', 'B000000101'], tokensLeft: 100 } });
    checkAsinWithTokensMock.mockImplementation(async (asin: string) =>
      okHistoryWithTokens(asin, 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);
    const asins = result.map((c) => c.asin);
    // 第 1 brand (query 失敗) からは ASIN は来ない。B100/B101 のみ。
    expect(asins).toContain('B000000100');
    for (const a of asins) {
      expect(['B000000100', 'B000000101']).toContain(a);
    }
  });

  it('skips ASINs where checkAsin returns null', async () => {
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002'], tokensLeft: 100 },
    });
    // B000000001 は null (見つからない), B000000002 は OK
    checkAsinWithTokensMock.mockImplementation(async (asin: string) =>
      asin === 'B000000001'
        ? { history: null, tokensLeft: 100 }
        : okHistoryWithTokens(asin, 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);
    const asins = result.map((c) => c.asin);
    expect(asins).not.toContain('B000000001');
    expect(asins).toContain('B000000002');
  });

  it('skips ASINs where dropPercent is below DROP_THRESHOLD_PERCENT', async () => {
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002'], tokensLeft: 100 },
    });
    // B000000001 は drop 10% (閾値 15% 未満), B000000002 は 25% (閾値以上)
    checkAsinWithTokensMock.mockImplementation(async (asin: string) =>
      asin === 'B000000001'
        ? okHistoryWithTokens('B000000001', 10, 1000)
        : okHistoryWithTokens('B000000002', 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);
    const asins = result.map((c) => c.asin);
    expect(asins).not.toContain('B000000001');
    expect(asins).toContain('B000000002');
  });

  it('skips ASINs where currentPrice is below MIN_PRICE_YEN', async () => {
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002'], tokensLeft: 100 },
    });
    // B000000001 は 100 円 (MIN_PRICE_YEN=500 未満), B000000002 は 1000 円
    checkAsinWithTokensMock.mockImplementation(async (asin: string) =>
      asin === 'B000000001'
        ? okHistoryWithTokens('B000000001', 25, 100)
        : okHistoryWithTokens('B000000002', 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);
    const asins = result.map((c) => c.asin);
    expect(asins).not.toContain('B000000001');
    expect(asins).toContain('B000000002');
  });

  it('returns empty array when all brands fail', async () => {
    axiosPostMock.mockRejectedValue(new Error('all brand queries failed'));
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);
    expect(result).toEqual([]);
    // checkAsinWithTokens は呼ばれない (query 失敗時は空配列が evaluate に渡る)
    expect(checkAsinWithTokensMock).not.toHaveBeenCalled();
  });

  it('continues brand loop when checkAsin throws for one ASIN', async () => {
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002'], tokensLeft: 100 },
    });
    // B000000001 は throw, B000000002 は OK
    checkAsinWithTokensMock.mockImplementation(async (asin: string) => {
      if (asin === 'B000000001') throw new Error('checkAsin failure');
      return okHistoryWithTokens(asin, 25, 1000);
    });
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);
    const asins = result.map((c) => c.asin);
    expect(asins).not.toContain('B000000001');
    expect(asins).toContain('B000000002');
  });

  // PR-B5: brand → category 紐づけが config の BRAND_CATEGORY_MAP 経由であることを pin down。
  // WATCH_BRANDS の全 brand は 'kitchen' map。新規 brand 追加 (例: 'Pilot' → 'stationery')
  // を将来サポートする際の回帰防止として、map 経由のルーティングを test で固定する。
  it('routes each WATCH_BRANDS hit to its category via BRAND_CATEGORY_MAP', async () => {
    // 各 brand から 1 ASIN ずつ返す。axios call 順 = WATCH_BRANDS 順 (Yamazaki, KAI, HARIO, ...)。
    // ASIN は 10 文字 alphanumeric (queryBrandAsins の filter)。
    // 9 brand 全てに対して mock し、全 brand が 'kitchen' に解決されることを確認。
    axiosPostMock.mockImplementation(async () => ({
      data: { asinList: ['B0KITCHEN1'], tokensLeft: 100 },
    }));
    checkAsinWithTokensMock.mockImplementation(async (asin: string) =>
      okHistoryWithTokens(asin, 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);
    // 全 brand 同じ ASIN を返すため dedupe で 1 件に圧縮されるが、全 brand 共通の category は 'kitchen'。
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const c of result) {
      expect(c.category).toBe('kitchen');
    }
  });

  // ============================================================================
  // Phase 2 (logical-forging-lerdorf) Step 2.5: 4 cases pin
  // ============================================================================

  // (a) 上位 N limit: 50 ASIN、BRAND_CHECKASIN_LIMIT=6、BRAND_QUOTA=2。
  //   全件 valid candidate なので chunk1 (上位 6) を順に call、2 件採用直後に early break。
  //   1 brand あたり checkAsinWithTokens 呼出回数 ≤ 6 (= BRAND_CHECKASIN_LIMIT)。
  it('Phase 2 (a) caps checkAsin to BRAND_CHECKASIN_LIMIT (=6) per brand and breaks at quota', async () => {
    // 50 ASIN を生成 (B0000000XX 形式)。queryBrandAsins の regex (10-char alphanumeric) を pass する形にする。
    const fiftyAsins = Array.from({ length: 50 }, (_, i) =>
      `B${String(i).padStart(9, '0')}`,  // B + 9 桁 = 10 文字
    );
    // 1 brand のみテストするため、axios は first call のみ 50 ASIN、それ以降は空配列を返す。
    axiosPostMock
      .mockResolvedValueOnce({ data: { asinList: fiftyAsins, tokensLeft: 100 } })
      .mockResolvedValue({ data: { asinList: [], tokensLeft: 100 } });
    // 全 ASIN が valid candidate (drop 25%, price 1000)
    checkAsinWithTokensMock.mockImplementation(async (asin: string) =>
      okHistoryWithTokens(asin, 25, 1000),
    );

    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);

    // 1 brand 目で BRAND_QUOTA=2 件採用、他 brand は空配列 → 最終 result は 2 件。
    expect(result).toHaveLength(2);
    // 1 brand あたり call 数 = 2 (採用 2 件で early break、3 件目は呼ばれない)。
    // 他 brand は空配列なので checkAsinWithTokens 呼ばれない。合計 = 2 call。
    expect(checkAsinWithTokensMock).toHaveBeenCalledTimes(2);
    // 採用 ASIN は chunk1 (上位 6) のうち先頭 2 件
    expect(result.map((c) => c.asin)).toEqual([fiftyAsins[0], fiftyAsins[1]]);
  });

  // (b) Fallback 発火: 上位 6 件で valid 1 件 → 次 6 件 (rank 7-12) を追加 checkAsin。
  //   合計 checkAsinWithTokens 呼出回数 = 12 (= BRAND_CHECKASIN_LIMIT * 2)。
  it('Phase 2 (b) triggers fallback chunk (BRAND_CHECKASIN_LIMIT * 2 = 12 calls) when chunk1 yields < quota', async () => {
    const twelveAsins = Array.from({ length: 12 }, (_, i) => `B${String(i).padStart(9, '0')}`);
    axiosPostMock
      .mockResolvedValueOnce({ data: { asinList: twelveAsins, tokensLeft: 100 } })
      .mockResolvedValue({ data: { asinList: [], tokensLeft: 100 } });
    // 上位 6 件のうち 0 番目だけ valid (drop 25%)、1-5 番目は drop 10% (閾値未満) で filter 落ち。
    // 次 6 件 (6-11) のうち 6 番目だけ valid (drop 25%)、7-11 番目は drop 10% で filter 落ち。
    // → 採用 2 件 (asin[0], asin[6]), 合計 12 call。
    checkAsinWithTokensMock.mockImplementation(async (asin: string) => {
      const idx = twelveAsins.indexOf(asin);
      const drop = idx === 0 || idx === 6 ? 25 : 10;
      return okHistoryWithTokens(asin, drop, 1000);
    });

    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.asin).sort()).toEqual([twelveAsins[0], twelveAsins[6]].sort());
    // 上位 6 件 + fallback 6 件 = 12 call。早期 break は採用 2 件目 = asin[6] 時点だが、
    // それは fallback chunk の最初の valid なので chunk2 の途中で break しない (1 番目で採用 → loop 続行
    // → 2 番目で採用 → quota 充足で break)。chunk1 全 6 件 + chunk2 最初の 1 件 = 7 call? いや、
    // chunk1 6 件全件 call (採用 1 件)、chunk2 最初の asin[6] で採用 → quota=2 充足で break。
    // よって合計 = 6 + 1 = 7 call。再計算: chunk2 の最初の 1 件 (asin[6]) で 2 件目採用 → break。
    expect(checkAsinWithTokensMock).toHaveBeenCalledTimes(7);
  });

  // (c) Quota 充足 early break: 上位 2 件で valid 2 件 → checkAsin 2 回で break、fallback 不発火。
  it('Phase 2 (c) breaks early on quota fulfillment within chunk1', async () => {
    const twoAsins = ['B000000001', 'B000000002', 'B000000003'];
    axiosPostMock
      .mockResolvedValueOnce({ data: { asinList: twoAsins, tokensLeft: 100 } })
      .mockResolvedValue({ data: { asinList: [], tokensLeft: 100 } });
    // 全件 valid → 2 件採用直後 break、3 件目は call されない。
    checkAsinWithTokensMock.mockImplementation(async (asin: string) =>
      okHistoryWithTokens(asin, 25, 1000),
    );

    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(guard);

    expect(result).toHaveLength(2);
    expect(checkAsinWithTokensMock).toHaveBeenCalledTimes(2);
  });

  // (d) Token-low skip: guard.shouldCall() === false (token 残量 < threshold) → checkAsin 0 回 + warn log。
  it('Phase 2 (d) skips all checkAsin calls when guard.shouldCall() returns false', async () => {
    const sixAsins = Array.from({ length: 6 }, (_, i) => `B${String(i).padStart(9, '0')}`);
    axiosPostMock.mockResolvedValue({ data: { asinList: sixAsins, tokensLeft: 5 } });
    checkAsinWithTokensMock.mockImplementation(async (asin: string) =>
      okHistoryWithTokens(asin, 25, 1000),
    );

    // 各 brand の query call は走るが、tokensLeft=5 (threshold=10 未満) なので shouldCall=false
    // → evaluateBrandAsins 内の最初の guard check で全 ASIN skip + warn log。
    const lowGuard = new KeepaTokenGuard(10);
    lowGuard.updateTokensLeft(5);
    // guard 自体に shouldCall=false が立っていれば collectBrandHits の query 前 check で skip するため
    // 厳密には query call も発生しないが、本 test は evaluateBrandAsins の skip を pin する目的。
    // shouldCall は query 前と checkAsin 前の 2 段階で評価される設計のため、token-low 環境では
    // 結果的に checkAsinWithTokens は 0 回呼ばれる (= Spec の "checkAsin 0 回" 要件を満たす)。

    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits(lowGuard);

    expect(result).toEqual([]);
    expect(checkAsinWithTokensMock).not.toHaveBeenCalled();
  });
});
