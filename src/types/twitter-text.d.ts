// twitter-text v3 (https://github.com/twitter/twitter-text) は型定義を同梱せず @types も無い。
// 本 file は本プロジェクトで利用する `parseTweet` の最小 surface のみ手書き宣言する。
// 公式仕様: https://developer.x.com/en/docs/counting-characters
declare module 'twitter-text' {
  interface ParsedTweet {
    /** X 上限 (280) に対する充填率 (0-1000)。実用では使わないが API 表面に存在。 */
    permillage: number;
    /** weightedLength <= 280 かつ非空 / 不正文字無しなら true。空文字も false 扱いに注意。 */
    valid: boolean;
    /** UTF-16 code unit count 相当 (Unicode code point とは別。実用では使わない)。 */
    displayRangeStart: number;
    displayRangeEnd: number;
    validRangeStart: number;
    validRangeEnd: number;
    /** X の weighted character count: ASCII=1, CJK / emoji=2, URL=23 (固定)。 */
    weightedLength: number;
  }
  interface TwitterText {
    parseTweet(text: string): ParsedTweet;
  }
  const twitterText: TwitterText;
  export default twitterText;
}
