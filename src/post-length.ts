import twitterText from 'twitter-text';
import { POST_TEXT_MAX_CHARS } from './config.js';

const { parseTweet } = twitterText;

// X (Twitter) の weighted character count を返す。X 公式アルゴリズム:
//   - ASCII / Latin Extended の主要範囲: 1 文字
//   - CJK / emoji / その他 Unicode: 2 文字
//   - URL: 実長無視で 23 文字 (t.co 短縮)
// 仕様: https://developer.x.com/en/docs/counting-characters
//
// publish 経路では Notion に書かれた 投稿文 をそのまま X / Bluesky 両方に送る。X は weighted、
// Bluesky は code point ベースで上限が異なるため、両 SNS に確実に届けたい本プロジェクトでは
// 厳しい方 (X weighted) で gate する必要がある。
//
// 旧実装は `[...text].length` (Unicode code point) で判定していたため、CJK 多めや URL 入りの
// 投稿文 (例: 「【19%OFF】... 国産大麦100% ... [https://amzn.to/x](https://amzn.to/x)」) が
// code point 200 前後で gate を通過し、X weighted 290 超で X API のみ reject、Bluesky は成功
// → Status=posted with bookmark 1 件、X 投稿が永久に失われる silent data loss が発生していた。
export const xWeightedLength = (text: string): number =>
  parseTweet(text).weightedLength;

// X の weighted character 上限 (POST_TEXT_MAX_CHARS = 280) を超えていれば true。
// publish 側 gate (publish.ts) と composeFixedPostText (fixed-templates.ts) が共通利用する。
export const exceedsXWeightedLimit = (text: string): boolean =>
  xWeightedLength(text) > POST_TEXT_MAX_CHARS;
