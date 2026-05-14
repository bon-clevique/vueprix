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
  // 3833931 / 86893051 は PR-A B10 (2026-05-14) で verify した結果、それぞれ
  // Keepa response に存在せず / 「果物」で 57239051 (食品全体) に包含、と判明したため削除。
  // 詳細: docs/notes/keepa-categories.md
  // kitchen / stationery の NotionCategory 型 option は brand 経路 (BRAND_CATEGORY_MAP) と
  // 将来拡張のため Notion select option として維持する。
};

export const mapKeepaCategoryToNotion = (categoryId: number): NotionCategory =>
  KEEPA_CATEGORY_MAP[categoryId] ?? 'fixed-list';

export const CATEGORY_FIXED: NotionCategory = 'fixed-list';
