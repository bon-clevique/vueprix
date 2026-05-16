import { describe, expect, it } from 'vitest';
import { exceedsXWeightedLimit, xWeightedLength } from './post-length.js';

describe('xWeightedLength — X weighted character count', () => {
  it('counts ASCII as 1 weighted char each', () => {
    expect(xWeightedLength('hello world')).toBe(11);
    expect(xWeightedLength('a'.repeat(280))).toBe(280);
  });

  it('counts CJK as 2 weighted chars each', () => {
    expect(xWeightedLength('あ')).toBe(2);
    expect(xWeightedLength('国産大麦')).toBe(8);
  });

  it('counts emoji as 2 weighted chars', () => {
    expect(xWeightedLength('🥤')).toBe(2);
  });

  it('counts URL as 23 weighted chars (t.co 短縮)', () => {
    // 実長 23 chars 超でも 23 で打ち止め。
    expect(xWeightedLength('https://amzn.to/4wxeCuh')).toBe(23);
    expect(xWeightedLength('https://example.com/very/long/path/that/is/much/longer')).toBe(23);
  });

  it('counts markdown link [url](url) as 2 separate URLs (= 46 weighted)', () => {
    // X の URL detector は `[`/`]`/`(`/`)` を URL boundary として扱う。
    // markdown link 表記 `[https://...](https://...)` は 2 つの独立した URL として認識され、
    // URL 部分だけで 23 × 2 = 46 weighted char を消費する。本プロジェクトの実バグ再現:
    // codepoint 207 → weighted 292 (280 超で X reject) のうち URL 重複が 23 char 占めていた。
    const markdown = '[https://amzn.to/4wxeCuh](https://amzn.to/4wxeCuh)';
    const plain = 'https://amzn.to/4wxeCuh';
    expect(xWeightedLength(markdown)).toBeGreaterThanOrEqual(xWeightedLength(plain) + 23);
  });
});

describe('exceedsXWeightedLimit — gate for publish refuse', () => {
  it('returns true when CJK content exceeds 280 weighted (= 141 CJK chars)', () => {
    // 'あ' = 2 weighted、141 文字で 282 weighted > 280。
    expect(exceedsXWeightedLimit('あ'.repeat(141))).toBe(true);
    expect(exceedsXWeightedLimit('あ'.repeat(140))).toBe(false);
  });

  it('boundary: ASCII 280 chars passes, 281 fails', () => {
    expect(exceedsXWeightedLimit('a'.repeat(280))).toBe(false);
    expect(exceedsXWeightedLimit('a'.repeat(281))).toBe(true);
  });

  it('reproduces the bug: codepoint < 280 but X weighted > 280 → exceeds', () => {
    // 実バグ row (Index 366 / ミツウロコ麦茶 / 2026-05-16) の 投稿文。
    // codepoint 207、weighted 292、旧 gate (`[...str].length > 280`) を通過していた。
    const buggyText = `🥤【19%OFF】国産大麦100%のラベルレス麦茶（500ml×24本）<br>通常 ¥1,744 → ¥1,409（¥335安）<br>毎日の水分補給や職場・お出かけ用のまとめ買いにも◎ カフェインゼロで気軽にストック。<br><br>#Amazon でチェック→ [https://amzn.to/4wxeCuh](https://amzn.to/4wxeCuh)<br>#麦茶 #まとめ買い #カフェインゼロ`;
    expect([...buggyText].length).toBeLessThan(280); // 旧 gate は通っていた
    expect(exceedsXWeightedLimit(buggyText)).toBe(true); // 新 gate は弾く
  });

  it('same row with plain URL (markdown link を素 URL に置換) passes the new gate', () => {
    // markdown を排除して URL を 1 個にすれば weighted ~265 で 280 以下に収まる。
    const fixedText = `🥤【19%OFF】国産大麦100%のラベルレス麦茶（500ml×24本）<br>通常 ¥1,744 → ¥1,409（¥335安）<br>毎日の水分補給や職場・お出かけ用のまとめ買いにも◎ カフェインゼロで気軽にストック。<br><br>#Amazon でチェック→ https://amzn.to/4wxeCuh<br>#麦茶 #まとめ買い #カフェインゼロ`;
    expect(exceedsXWeightedLimit(fixedText)).toBe(false);
  });
});
