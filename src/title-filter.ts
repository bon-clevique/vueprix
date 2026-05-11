import type { NotionCategory } from './category.js';

// カテゴリごとの「title に含まれていれば draft 対象とする」ホワイトリスト regex 群。
// マッチ対象は Keepa /deal で取得した商品 title。
// - 配列が空 (`[]`) のカテゴリはホワイトリスト未適用 (= 全件通す)。
// - 配列に 1 件以上ある場合、いずれかにマッチした商品のみ通る。
// - FIXED_ASINS 由来候補 (category=fixed-list) はそもそも本フィルタを通さない。
//
// 設計メモ:
// - 「インク」単独だと互換プリンタインクが大量に通るので、否定先読みで除外している。
// - 「便利」は kitchen 候補だが PC 周辺にも頻出のため初回は外している。誤検知が少ないと判断したら追加可。
// - 「日本製 / 国産」は title に明示しない商品も多く、マッチ率が低い前提。
const CATEGORY_WHITELIST: Record<NotionCategory, readonly RegExp[]> = {
  food: [/(国産|日本産|日本製)/],
  health: [], // 後日キーワード追加予定。現状は素通し。
  kitchen: [/(貝印|山崎実業)/, /(日本製|国産)/],
  stationery: [
    /(SARASA|サラサ)/i,
    /(FRIXION|フリクション)/i,
    /ガラスペン/,
    /(ハイユニ|Hi[- ]?UNI)/i,
    /(パーフェクトペンシル|PERFECT\s?PENCIL)/i,
    /万年筆/,
    /(?<!(?:プリンタ.{0,5}|互換\s?))インク/,
    /(国産|日本製).{0,8}ノート|ノート.{0,8}(国産|日本製)/,
  ],
  'pc-desk': [
    /モニターアーム/,
    /(分離|セパレート|エルゴノ).{0,4}キーボード/,
    /(HHKB|REALFORCE|リアルフォース)/i,
    /トラックボール/,
    /(左手デバイス|TourBox|Stream\s?Deck|Loupedeck)/i,
    /(ドッキングステーション|USB[- ]?C\s?ハブ)/i,
    /Thunderbolt/i,
    /(Mac|MacBook|iMac|iPad|iPhone|Apple)\b/,
    /デスク(ライト|照明|スタンド)/,
    /(日本製|国産)/,
    // 「モニター」単独は誤マッチ多めなので意図的に外している。
    // 「モニターアーム」は別途明示マッチで通る。
  ],
  audio: [
    /(ヘッドホン|イヤホン|スピーカー|DAC|アンプ|オーディオインターフェース)/,
    /(日本製|国産)/,
  ],
  gaming: [
    // whitelist 該当キーワード未指定。1 枠を確保しているが、ほぼ通らない想定。
    /(日本製|国産)/,
  ],
  'fixed-list': [], // FIXED_ASINS は本フィルタを通さない (draft.ts 側で別経路)。
};

export const passesTitleWhitelist = (
  category: NotionCategory,
  title: string,
): boolean => {
  const patterns = CATEGORY_WHITELIST[category];
  if (patterns.length === 0) return true;
  return patterns.some((re) => re.test(title));
};

export { CATEGORY_WHITELIST };
