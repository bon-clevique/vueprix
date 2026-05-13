import { describe, expect, it } from 'vitest';
import { composeFixedPostText } from './fixed-templates.js';

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
