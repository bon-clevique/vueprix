import type { NotionCategory } from './category.js';

export const FIXED_ASINS: readonly string[] = [
  "B0C1JGD2T6", // カリタ コーヒーフィルター ウェーブシリーズ KWF-155 ホワイト 50枚×2個
  "B09QMHL2NN", // 青森産 ホタテ貝殻焼成パウダー 1kg パウチ 野菜洗い・掃除用
  "B0779N9GZF", // LOHAStyle スーパー大麦 バーリーマックス 800g レジスタントスターチ
  "B07B5CD8NY", // クリニカ アドバンテージ デンタルフロス Y字タイプ 18本入×3個
  "B06VTRH7Z8", // NICHIGA 国産重曹 1kg 食品添加物 東ソー製
  "B09JL4R6SX", // HARIO 浸漬式ドリッパー スイッチ360 SSD-360-B 耐熱ガラス ブラック
  "B01H09CWNG", // カリタ ウェーブドリッパー WDS-155 ステンレス製 燕職人手作り 1~2人用
  "B0B5GP4S36", // コマンダンテ アメリカンチェリー C40 MK4 ニトロブレード コーヒーグラインダー [並行輸入品]
  "B0BNHTX3YD",
  "B0CH9LZRJP",
];

// Amazon.co.jp = Keepa domain 5
// Verified via scripts/verify-keepa-categories.ts. See docs/notes/keepa-categories.md.
//   57239051   → 食品・飲料・お酒 (2.2M, food)
//   160384011  → ドラッグストア (3.6M, health)
//   2127209051 → パソコン・周辺機器 (6.4M, pc-desk)
//   637394     → ゲーム (489K, gaming)
//   3477981    → イヤホン・ヘッドホン本体 (93K, audio)
//   3833931    → ホーム&キッチン > キッチン用品 (TBD: verify, kitchen)
//   86893051   → 文房具・オフィス用品 (TBD: verify, stationery)
export const KEEPA_DOMAIN = 5;
export const KEEPA_CATEGORIES: readonly number[] = [
  57239051,
  160384011,
  2127209051,
  637394,
  3477981,
  3833931,
  86893051,
];

// Keepa /deal sortType: 1 = 値下率の高い順 (試験運用、要 A/B)。
// 旧: 4 (deal score) はジャンク商品が混ざりやすかったため、より明示的なシグナルに変更。
export const KEEPA_DEAL_SORT_TYPE = 1;

// カテゴリごとの draft 上限 (Keepa deals 由来のみ。FIXED_ASINS はこの枠外で別途追加される)。
// 合計 20 枠。1 カテゴリが空でも他に再分配しない (fail-safe / シンプル運用)。
export const CATEGORY_QUOTA: Record<NotionCategory, number> = {
  food: 5,
  health: 3,
  kitchen: 3,
  stationery: 3,
  'pc-desk': 3,
  audio: 2,
  gaming: 1,
  'fixed-list': 0, // quota 対象外 (FIXED_ASINS は別経路で追加)
};

// quota 配分内のタイブレークと、quota 外で fixed を上に積む際の参考順序。
export const CATEGORY_PRIORITY: readonly NotionCategory[] = [
  'fixed-list',
  'food',
  'health',
  'kitchen',
  'stationery',
  'pc-desk',
  'audio',
  'gaming',
];

export const DROP_THRESHOLD_PERCENT = 15;
export const HISTORY_DAYS = 90;

// 安全装置 (PA-API / Notion 連打抑制)。CATEGORY_QUOTA 合計 + FIXED_ASINS 想定数を上回る値で運用。
export const MAX_POSTS_PER_RUN = 30;
export const MIN_PRICE_YEN = 500;
export const COOLDOWN_HOURS = 24;

export const POST_HISTORY_PATH = "data/post-history.jsonl";

// queryDuplicateAsins の Notion paging 上限。
// page_size=100 × MAX_QUERY_PAGES = 1000 件。到達時は warn ログ + 切り上げ (要拡張シグナル)。
export const MAX_QUERY_PAGES = 10;
