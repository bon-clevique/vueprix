import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeFixedPostText } from './fixed-templates.js';

const dataSourcesQueryMock = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class MockClient {
    dataSources = { query: dataSourcesQueryMock };
  },
}));

describe('composeFixedPostText', () => {
  const description = 'HARIO 浸漬式ドリッパー。淹れたいときに押すだけ簡単抽出。';
  const url = 'https://www.amazon.co.jp/dp/B09JL4R6SX?tag=example-22';

  it('renders header + description + url in three blocks separated by blank lines', () => {
    const text = composeFixedPostText(description, 34, 2903, 4399, url);
    expect(text).toBe(
      `【34% OFF】¥4,399 → ¥2,903\n\n${description}\n\n${url}`,
    );
  });

  it('formats prices with ja-JP comma separators and half-width yen sign', () => {
    const text = composeFixedPostText(description, 50, 1234567, 2500000, url);
    expect(text).toContain('¥2,500,000 → ¥1,234,567');
    expect(text).not.toContain('￥');  // 全角 yen を含まない
  });

  it('returns null when composed text exceeds X 280-character limit', () => {
    const long = 'あ'.repeat(280);  // description だけで上限超え
    const text = composeFixedPostText(long, 34, 2903, 4399, url);
    expect(text).toBeNull();
  });

  it('returns null for empty description (defensive)', () => {
    const text = composeFixedPostText('', 34, 2903, 4399, url);
    expect(text).toBeNull();
  });

  it('returns null for whitespace-only description', () => {
    const text = composeFixedPostText('   \n  ', 34, 2903, 4399, url);
    expect(text).toBeNull();
  });

  it('trims leading and trailing whitespace from description but keeps internal newlines', () => {
    const multiline = '  1 行目\n2 行目  ';
    const text = composeFixedPostText(multiline, 34, 2903, 4399, url);
    expect(text).toContain('1 行目\n2 行目');
    expect(text).not.toMatch(/  1 行目/);  // 先頭の余白が削除されていること
  });

  it('handles 0% drop (edge case — caller should filter, but compose should not error)', () => {
    const text = composeFixedPostText(description, 0, 4399, 4399, url);
    expect(text).toContain('【0% OFF】¥4,399 → ¥4,399');
  });

  it('neutralizes leading half-width @ (X mention) to full-width ＠', () => {
    const text = composeFixedPostText('@example さんもおすすめ', 34, 2903, 4399, url);
    expect(text).toContain('＠example');
    expect(text).not.toMatch(/(?:^|\s)@example/);
  });

  it('neutralizes @ after whitespace but leaves @ embedded in words alone', () => {
    // email-like literal は中和不要 (mention は前にスペースが必要)。実用上 `foo@bar.com` は wordlike。
    const text = composeFixedPostText('問い合わせは support@example.com まで', 34, 2903, 4399, url);
    expect(text).toContain('support@example.com');
  });
});

describe('fetchFixedListings — Amazon URL extraction (PR-#47)', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_FIXED_ASIN_DATA_SOURCE_ID;

  beforeEach(() => {
    dataSourcesQueryMock.mockReset();
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_FIXED_ASIN_DATA_SOURCE_ID = 'ds-fixed-uuid';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_FIXED_ASIN_DATA_SOURCE_ID;
    else process.env.NOTION_FIXED_ASIN_DATA_SOURCE_ID = originalDs;
  });

  const buildPage = (asin: string, overrides: Record<string, unknown> = {}) => ({
    properties: {
      ASIN: { title: [{ plain_text: asin }] },
      '投稿文': { rich_text: [{ plain_text: 'sample description' }] },
      ...overrides,
    },
  });

  it('extracts Amazon URL property into FixedListing.amazonUrl', async () => {
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: [
        buildPage('B0AAAA', {
          'Amazon URL': { url: 'https://amzn.to/short-link-1' },
        }),
      ],
    });
    const { fetchFixedListings } = await import('./fixed-templates.js');
    const map = await fetchFixedListings();
    expect(map.get('B0AAAA')?.amazonUrl).toBe('https://amzn.to/short-link-1');
  });

  it('leaves amazonUrl undefined when Amazon URL property is null/empty', async () => {
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: [
        buildPage('B0BBBB', { 'Amazon URL': { url: null } }),
        buildPage('B0CCCC', { 'Amazon URL': { url: '   ' } }),
        buildPage('B0DDDD'),  // property 自体無し
      ],
    });
    const { fetchFixedListings } = await import('./fixed-templates.js');
    const map = await fetchFixedListings();
    expect(map.get('B0BBBB')?.amazonUrl).toBeUndefined();
    expect(map.get('B0CCCC')?.amazonUrl).toBeUndefined();
    expect(map.get('B0DDDD')?.amazonUrl).toBeUndefined();
  });

  it('trims leading/trailing whitespace from Amazon URL', async () => {
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: [
        buildPage('B0EEEE', {
          'Amazon URL': { url: '  https://amzn.to/trimmed-link  ' },
        }),
      ],
    });
    const { fetchFixedListings } = await import('./fixed-templates.js');
    const map = await fetchFixedListings();
    expect(map.get('B0EEEE')?.amazonUrl).toBe('https://amzn.to/trimmed-link');
  });

  it('rejects non-http(s) schemes (defense against accidental free-form text or javascript: scheme)', async () => {
    dataSourcesQueryMock.mockResolvedValueOnce({
      results: [
        buildPage('B0FFFF', { 'Amazon URL': { url: 'javascript:alert(1)' } }),
        buildPage('B0GGGG', { 'Amazon URL': { url: 'plain text without scheme' } }),
        buildPage('B0HHHH', { 'Amazon URL': { url: 'ftp://example.com/path' } }),
      ],
    });
    const { fetchFixedListings } = await import('./fixed-templates.js');
    const map = await fetchFixedListings();
    expect(map.get('B0FFFF')?.amazonUrl).toBeUndefined();
    expect(map.get('B0GGGG')?.amazonUrl).toBeUndefined();
    expect(map.get('B0HHHH')?.amazonUrl).toBeUndefined();
  });
});
