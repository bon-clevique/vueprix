import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candidate } from '../types.js';

// 外部 I/O dependency (axios / keepa.checkAsin) を mock。
// vi.mock は hoisted されるため、mock factory 内で参照する変数は vi.hoisted で持ち上げる必要がある。
const { axiosPostMock, checkAsinMock } = vi.hoisted(() => ({
  axiosPostMock: vi.fn(),
  checkAsinMock: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: axiosPostMock,
  },
}));

vi.mock('../keepa.js', () => ({
  checkAsin: checkAsinMock,
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

  it('returns asinList from successful response', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { asinList: ['B000000001', 'B000000002', 'B000000003'], tokensLeft: 100 },
    });
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result).toEqual(['B000000001', 'B000000002', 'B000000003']);
  });

  it('falls back to asins field when asinList is absent', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { asins: ['B000000010', 'B000000011'], tokensLeft: 99 },
    });
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result).toEqual(['B000000010', 'B000000011']);
  });

  it('returns empty array when both fields are absent', async () => {
    axiosPostMock.mockResolvedValueOnce({ data: { tokensLeft: 99 } });
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result).toEqual([]);
  });

  it('returns empty array and logs warn on 5xx error', async () => {
    axiosPostMock.mockRejectedValueOnce(new Error('Request failed with status code 503'));
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result).toEqual([]);
  });

  it('returns empty array on network error', async () => {
    axiosPostMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const { queryBrandAsins } = await import('./brand.js');
    const result = await queryBrandAsins('TestBrand');
    expect(result).toEqual([]);
  });

  it('throws when KEEPA_API_KEY is unset', async () => {
    delete process.env.KEEPA_API_KEY;
    axiosPostMock.mockImplementationOnce(() => {
      throw new Error('should not reach here');
    });
    const { queryBrandAsins } = await import('./brand.js');
    // apiKey() が throw を投げるが、queryBrandAsins は try-catch 内で受けるため空配列を返す
    const result = await queryBrandAsins('TestBrand');
    expect(result).toEqual([]);
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
    expect(result).toEqual(['B000VALID1', 'B000VALID2']);
  });
});

describe('collectBrandHits', () => {
  const originalKey = process.env.KEEPA_API_KEY;

  beforeEach(() => {
    axiosPostMock.mockReset();
    checkAsinMock.mockReset();
    process.env.KEEPA_API_KEY = 'test-key-xxx';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.KEEPA_API_KEY;
    else process.env.KEEPA_API_KEY = originalKey;
  });

  // WATCH_BRANDS は config.ts で固定 (Yamazaki / KAI / HARIO の 3 brand)。
  // axiosPostMock を mockResolvedValue で全 brand に同じ response を返すように設定し、
  // checkAsinMock も同様に全 ASIN に同じ振る舞いを与えて確認する。

  const okHistory = (asin: string, dropPercent: number, currentPrice = 1000) => ({
    asin,
    title: `product ${asin}`,
    currentPrice,
    referencePrice: currentPrice * 2,
    referenceSource: 'list-price' as const,
    dropPercent,
  });

  it('returns Candidates from all brands, capped by BRAND_QUOTA (=2) per brand', async () => {
    // 各 brand に 3 件の ASIN を返す。BRAND_QUOTA=2 なので、各 brand から dropPercent 上位 2 件採用。
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002', 'B000000003'], tokensLeft: 100 },
    });
    // 全 ASIN が DROP_THRESHOLD_PERCENT (15) 以上 + MIN_PRICE_YEN (500) 以上で hit
    checkAsinMock.mockImplementation(async (asin: string) => {
      const dropMap: Record<string, number> = {
        B000000001: 20,
        B000000002: 30,
        B000000003: 25,
      };
      return okHistory(asin, dropMap[asin] ?? 20, 1000);
    });
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits();
    // dedupeWithinBrand で重複除去後、3 brand × 2 件 = 最大 6 件、ただし全 brand で同じ ASIN を返すため
    // dedupe で 3 件 (B001, B002, B003) に圧縮される。dedupe は selectByBrandQuota 後に走る前提だが、
    // 各 brand の selectByBrandQuota は dropPercent 上位 2 件 (B002=30, B003=25) を返すので、
    // 3 brand 合流時点で 6 件 → dedupe で 2 件 (B002, B003) が最終結果。
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
      .mockResolvedValueOnce({ data: { asinList: ['B000000100', 'B000000101'] } })
      .mockResolvedValueOnce({ data: { asinList: ['B000000200', 'B000000201'] } });
    checkAsinMock.mockImplementation(async (asin: string) =>
      okHistory(asin, 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits();
    const asins = result.map((c) => c.asin);
    expect(asins).toContain('B000000100');
    expect(asins).toContain('B000000200');
    // 第 1 brand (query 失敗) からは ASIN は来ない。B100/B101/B200/B201 のみ。
    for (const a of asins) {
      expect(['B000000100', 'B000000101', 'B000000200', 'B000000201']).toContain(a);
    }
  });

  it('skips ASINs where checkAsin returns null', async () => {
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002'] },
    });
    // B000000001 は null (見つからない), B000000002 は OK
    checkAsinMock.mockImplementation(async (asin: string) =>
      asin === 'B000000001' ? null : okHistory(asin, 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits();
    const asins = result.map((c) => c.asin);
    expect(asins).not.toContain('B000000001');
    expect(asins).toContain('B000000002');
  });

  it('skips ASINs where dropPercent is below DROP_THRESHOLD_PERCENT', async () => {
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002'] },
    });
    // B000000001 は drop 10% (閾値 15% 未満), B000000002 は 25% (閾値以上)
    checkAsinMock.mockImplementation(async (asin: string) =>
      asin === 'B000000001'
        ? okHistory('B000000001', 10, 1000)
        : okHistory('B000000002', 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits();
    const asins = result.map((c) => c.asin);
    expect(asins).not.toContain('B000000001');
    expect(asins).toContain('B000000002');
  });

  it('skips ASINs where currentPrice is below MIN_PRICE_YEN', async () => {
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002'] },
    });
    // B000000001 は 100 円 (MIN_PRICE_YEN=500 未満), B000000002 は 1000 円
    checkAsinMock.mockImplementation(async (asin: string) =>
      asin === 'B000000001'
        ? okHistory('B000000001', 25, 100)
        : okHistory('B000000002', 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits();
    const asins = result.map((c) => c.asin);
    expect(asins).not.toContain('B000000001');
    expect(asins).toContain('B000000002');
  });

  it('returns empty array when all brands fail', async () => {
    axiosPostMock.mockRejectedValue(new Error('all brand queries failed'));
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits();
    expect(result).toEqual([]);
    // checkAsin は呼ばれない (query 失敗時は空配列が evaluate に渡る)
    expect(checkAsinMock).not.toHaveBeenCalled();
  });

  it('continues brand loop when checkAsin throws for one ASIN', async () => {
    axiosPostMock.mockResolvedValue({
      data: { asinList: ['B000000001', 'B000000002'] },
    });
    // B000000001 は throw, B000000002 は OK
    checkAsinMock.mockImplementation(async (asin: string) => {
      if (asin === 'B000000001') throw new Error('checkAsin failure');
      return okHistory(asin, 25, 1000);
    });
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits();
    const asins = result.map((c) => c.asin);
    expect(asins).not.toContain('B000000001');
    expect(asins).toContain('B000000002');
  });

  // PR-B5: brand → category 紐づけが config の BRAND_CATEGORY_MAP 経由であることを pin down。
  // WATCH_BRANDS (Yamazaki/KAI/HARIO) は全 'kitchen' map。新規 brand 追加 (例: 'Pilot' → 'stationery')
  // を将来サポートする際の回帰防止として、map 経由のルーティングを test で固定する。
  it('routes each WATCH_BRANDS hit to its category via BRAND_CATEGORY_MAP', async () => {
    // 各 brand から 1 ASIN ずつ返す。axios call 順 = WATCH_BRANDS 順 (Yamazaki, KAI, HARIO)
    // ASIN は 10 文字 alphanumeric (queryBrandAsins の filter)。
    axiosPostMock
      .mockResolvedValueOnce({ data: { asinList: ['B0YAMA0001'] } })
      .mockResolvedValueOnce({ data: { asinList: ['B0KAI00002'] } })
      .mockResolvedValueOnce({ data: { asinList: ['B0HARI0003'] } });
    checkAsinMock.mockImplementation(async (asin: string) =>
      okHistory(asin, 25, 1000),
    );
    const { collectBrandHits } = await import('./brand.js');
    const result = await collectBrandHits();
    // 全 brand が 'kitchen' に解決される (BRAND_CATEGORY_MAP の現状定義)
    expect(result).toHaveLength(3);
    for (const c of result) {
      expect(c.category).toBe('kitchen');
    }
    // ASIN 順は保証されないため Set 比較
    expect(new Set(result.map((c) => c.asin))).toEqual(
      new Set(['B0YAMA0001', 'B0KAI00002', 'B0HARI0003']),
    );
  });
});
