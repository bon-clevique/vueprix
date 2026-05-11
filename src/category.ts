// Keepa category ID から Notion 投稿文 DB の カテゴリ select 値へのマッピング。
// 新規カテゴリを config.ts KEEPA_CATEGORIES に追加した際は本マップにも追記。
//
// 既存 select option (Notion 側で定義済):
//   food / health / pc-desk / gaming / audio / kitchen / stationery / fixed-list

export type NotionCategory =
  | 'food'
  | 'health'
  | 'pc-desk'
  | 'gaming'
  | 'audio'
  | 'kitchen'
  | 'stationery'
  | 'fixed-list';

const KEEPA_CATEGORY_MAP: Record<number, NotionCategory> = {
  57239051: 'food',      // 食品・飲料・お酒
  160384011: 'health',   // ドラッグストア
  2127209051: 'pc-desk', // パソコン・周辺機器
  637394: 'gaming',      // ゲーム
  3477981: 'audio',      // イヤホン・ヘッドホン本体
  // VERIFY: 下記 2 件は推定値。`tsx scripts/verify-keepa-categories.ts 3833931 86893051` で
  // 名称と productCount を確認のうえ、TBD コメントを外すこと。
  3833931: 'kitchen',    // ホーム&キッチン > キッチン用品 (TBD: verify)
  86893051: 'stationery',// 文房具・オフィス用品 (TBD: verify)
};

export const mapKeepaCategoryToNotion = (categoryId: number): NotionCategory =>
  KEEPA_CATEGORY_MAP[categoryId] ?? 'fixed-list';

export const CATEGORY_FIXED: NotionCategory = 'fixed-list';
