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
  57239051: 'food',      // 食品・飲料・お酒 (2.2M, verified 2026-05-06)
  160384011: 'health',   // ドラッグストア (verified 2026-05-06)
  2127209051: 'pc-desk', // パソコン・周辺機器 (verified 2026-05-06)
  637394: 'gaming',      // ゲーム (verified 2026-05-06)
  3477981: 'audio',      // イヤホン・ヘッドホン本体 (verified 2026-05-06)
  // PR-volume-1: kitchen / stationery を deals 経路にも展開 (旧: brand 経路のみ)。
  // scripts/verify-keepa-categories.ts で Keepa 上の name / productCount を検証してから運用。
  3828871: 'kitchen',     // ホーム&キッチン (Amazon.co.jp root)
  159241011: 'stationery',// 文房具・オフィス用品 (Amazon.co.jp root)
};

export const mapKeepaCategoryToNotion = (categoryId: number): NotionCategory =>
  KEEPA_CATEGORY_MAP[categoryId] ?? 'fixed-list';

export const CATEGORY_FIXED: NotionCategory = 'fixed-list';
