import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBody,
  isPaapiConfigured,
  isRetryable,
  parseProducts,
  type PaapiResponse,
} from './paapi.js';

describe('isRetryable', () => {
  it('retries on 429', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
  });

  it('retries on 5xx', () => {
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 599 })).toBe(true);
  });

  it('does not retry on 4xx (other than 429)', () => {
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  it('does not retry on 2xx/3xx', () => {
    expect(isRetryable({ status: 200 })).toBe(false);
    expect(isRetryable({ status: 301 })).toBe(false);
  });

  it('retries on known network error codes', () => {
    expect(isRetryable({ code: 'ENOTFOUND' })).toBe(true);
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryable({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isRetryable({ code: 'EAI_AGAIN' })).toBe(true);
    expect(isRetryable({ code: 'EPIPE' })).toBe(true);
  });

  it('does not retry on unknown error codes (e.g., ENOENT)', () => {
    expect(isRetryable({ code: 'ENOENT' })).toBe(false);
    expect(isRetryable({ code: 'EACCES' })).toBe(false);
    expect(isRetryable({ code: 'SomeAuthError' })).toBe(false);
  });

  it('does not retry on plain Error without status/code', () => {
    expect(isRetryable(new Error('plain'))).toBe(false);
    expect(isRetryable({})).toBe(false);
  });
});

// PR-C B4: pure function カバレッジ向上。
// buildBody は env (PAAPI_PARTNER_TAG) 経由なので env mock 必須。
describe('buildBody', () => {
  const originalTag = process.env.PAAPI_PARTNER_TAG;

  beforeEach(() => {
    process.env.PAAPI_PARTNER_TAG = 'test-tag-22';
  });

  afterEach(() => {
    if (originalTag === undefined) delete process.env.PAAPI_PARTNER_TAG;
    else process.env.PAAPI_PARTNER_TAG = originalTag;
  });

  it('embeds PartnerTag from env and ItemIds from arg', () => {
    const body = JSON.parse(buildBody(['B000ABCDE0', 'B000ABCDE1']));
    expect(body.PartnerTag).toBe('test-tag-22');
    expect(body.ItemIds).toEqual(['B000ABCDE0', 'B000ABCDE1']);
    expect(body.PartnerType).toBe('Associates');
    expect(body.Marketplace).toBe('www.amazon.co.jp');
    expect(body.Operation).toBe('GetItems');
  });

  it('requests SavingBasis resource (固定ASIN reference price のため)', () => {
    const body = JSON.parse(buildBody(['B000ABCDE0']));
    expect(body.Resources).toContain('Offers.Listings.SavingBasis');
    expect(body.Resources).toContain('ItemInfo.Title');
    expect(body.Resources).toContain('Offers.Listings.Price');
    expect(body.Resources).toContain('Images.Primary.Medium');
  });

  it('throws when PAAPI_PARTNER_TAG is unset', () => {
    delete process.env.PAAPI_PARTNER_TAG;
    expect(() => buildBody(['B000ABCDE0'])).toThrow(/PAAPI_PARTNER_TAG/);
  });
});

describe('parseProducts', () => {
  // helper: 最小限の PaapiResponse を生成
  const buildItem = (overrides: Record<string, unknown> = {}) => ({
    ASIN: 'B000ABCDE0',
    DetailPageURL: 'https://www.amazon.co.jp/dp/B000ABCDE0?tag=t',
    ItemInfo: { Title: { DisplayValue: 'Sample Product' } },
    Images: { Primary: { Medium: { URL: 'https://m.media-amazon.com/img.jpg' } } },
    Offers: {
      Listings: [
        {
          Price: { Amount: 850, DisplayAmount: '￥850' },
        },
      ],
    },
    ...overrides,
  });

  it('returns ProductInfo array for valid response (正常系)', () => {
    const res: PaapiResponse = { ItemsResult: { Items: [buildItem()] } };
    const products = parseProducts(res);
    expect(products).toHaveLength(1);
    expect(products[0]).toEqual({
      asin: 'B000ABCDE0',
      title: 'Sample Product',
      imageUrl: 'https://m.media-amazon.com/img.jpg',
      currentPrice: 850,
      affiliateUrl: 'https://www.amazon.co.jp/dp/B000ABCDE0?tag=t',
    });
  });

  it('returns empty array when ItemsResult is missing', () => {
    expect(parseProducts({})).toEqual([]);
    expect(parseProducts({ ItemsResult: {} })).toEqual([]);
    expect(parseProducts({ ItemsResult: { Items: [] } })).toEqual([]);
  });

  it('continues parsing when Errors are present (partial failure)', () => {
    const res: PaapiResponse = {
      ItemsResult: { Items: [buildItem()] },
      Errors: [{ Code: 'InvalidParameterValue', Message: 'ASIN xxx not found' }],
    };
    const products = parseProducts(res);
    expect(products).toHaveLength(1);  // valid item は残る
    expect(products[0]?.asin).toBe('B000ABCDE0');
  });

  it('filters out items missing required fields (title / detailUrl / price)', () => {
    const res: PaapiResponse = {
      ItemsResult: {
        Items: [
          buildItem(),  // valid
          buildItem({ ItemInfo: { Title: undefined } }),  // title 欠落
          buildItem({ DetailPageURL: undefined }),  // detailUrl 欠落
          buildItem({ Offers: { Listings: [{}] } }),  // price 欠落
        ],
      },
    };
    expect(parseProducts(res)).toHaveLength(1);  // valid 1 件のみ
  });

  it('extracts SavingBasis when present and positive (固定ASIN reference price 用)', () => {
    const res: PaapiResponse = {
      ItemsResult: {
        Items: [
          buildItem({
            Offers: {
              Listings: [
                {
                  Price: { Amount: 850 },
                  SavingBasis: { Amount: 1490, DisplayAmount: '￥1,490' },
                },
              ],
            },
          }),
        ],
      },
    };
    const products = parseProducts(res);
    expect(products[0]?.savingBasis).toBe(1490);
  });

  it('omits savingBasis when 0 or negative or missing', () => {
    const cases = [
      { savingBasisAmount: undefined, label: 'missing' },
      { savingBasisAmount: 0, label: 'zero' },
      { savingBasisAmount: -100, label: 'negative' },
    ];
    for (const { savingBasisAmount } of cases) {
      const res: PaapiResponse = {
        ItemsResult: {
          Items: [
            buildItem({
              Offers: {
                Listings: [
                  {
                    Price: { Amount: 850 },
                    ...(savingBasisAmount !== undefined
                      ? { SavingBasis: { Amount: savingBasisAmount } }
                      : {}),
                  },
                ],
              },
            }),
          ],
        },
      };
      const products = parseProducts(res);
      expect(products[0]?.savingBasis).toBeUndefined();
    }
  });

  it('rounds non-integer prices via Math.round', () => {
    const res: PaapiResponse = {
      ItemsResult: {
        Items: [buildItem({ Offers: { Listings: [{ Price: { Amount: 850.7 } }] } })],
      },
    };
    expect(parseProducts(res)[0]?.currentPrice).toBe(851);
  });

  it('defaults imageUrl to empty string when missing', () => {
    const res: PaapiResponse = {
      ItemsResult: { Items: [buildItem({ Images: undefined })] },
    };
    expect(parseProducts(res)[0]?.imageUrl).toBe('');
  });
});

describe('isPaapiConfigured', () => {
  const originalAccess = process.env.PAAPI_ACCESS_KEY;
  const originalSecret = process.env.PAAPI_SECRET_KEY;

  afterEach(() => {
    if (originalAccess === undefined) delete process.env.PAAPI_ACCESS_KEY;
    else process.env.PAAPI_ACCESS_KEY = originalAccess;
    if (originalSecret === undefined) delete process.env.PAAPI_SECRET_KEY;
    else process.env.PAAPI_SECRET_KEY = originalSecret;
  });

  it('returns true when both access and secret keys are set', () => {
    process.env.PAAPI_ACCESS_KEY = 'AKIA-test';
    process.env.PAAPI_SECRET_KEY = 'secret-test';
    expect(isPaapiConfigured()).toBe(true);
  });

  it('returns false when either key is missing', () => {
    delete process.env.PAAPI_ACCESS_KEY;
    process.env.PAAPI_SECRET_KEY = 'secret-test';
    expect(isPaapiConfigured()).toBe(false);

    process.env.PAAPI_ACCESS_KEY = 'AKIA-test';
    delete process.env.PAAPI_SECRET_KEY;
    expect(isPaapiConfigured()).toBe(false);
  });

  it('returns false when both keys are absent', () => {
    delete process.env.PAAPI_ACCESS_KEY;
    delete process.env.PAAPI_SECRET_KEY;
    expect(isPaapiConfigured()).toBe(false);
  });
});
