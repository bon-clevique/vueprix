export const FIXED_ASINS: readonly string[] = [
  "B0C1JGD2T6", // カリタ コーヒーフィルター ウェーブシリーズ KWF-155 ホワイト 50枚×2個
  "B09QMHL2NN", // 青森産 ホタテ貝殻焼成パウダー 1kg パウチ 野菜洗い・掃除用
  "B0779N9GZF", // LOHAStyle スーパー大麦 バーリーマックス 800g レジスタントスターチ
  "B07B5CD8NY", // クリニカ アドバンテージ デンタルフロス Y字タイプ 18本入×3個
  "B06VTRH7Z8", // NICHIGA 国産重曹 1kg 食品添加物 東ソー製
  "B09JL4R6SX", // HARIO 浸漬式ドリッパー スイッチ360 SSD-360-B 耐熱ガラス ブラック
  "B01H09CWNG", // カリタ ウェーブドリッパー WDS-155 ステンレス製 燕職人手作り 1~2人用
  "B0B5GP4S36", // コマンダンテ アメリカンチェリー C40 MK4 ニトロブレード コーヒーグラインダー [並行輸入品]
];

// Amazon.co.jp = Keepa domain 5
// Verified via scripts/verify-keepa-categories.ts. See docs/notes/keepa-categories.md.
//   57239051   → 食品・飲料・お酒 (2.2M, food)
//   160384011  → ドラッグストア (3.6M, health)
//   2127209051 → パソコン・周辺機器 (6.4M, pc-desk)
//   637394     → ゲーム (489K, gaming)
//   3477981    → イヤホン・ヘッドホン本体 (93K, audio)
export const KEEPA_DOMAIN = 5;
export const KEEPA_CATEGORIES: readonly number[] = [
  57239051,
  160384011,
  2127209051,
  637394,
  3477981,
];

export const DROP_THRESHOLD_PERCENT = 15;
export const HISTORY_DAYS = 90;

export const MAX_POSTS_PER_RUN = 2;
export const MIN_PRICE_YEN = 500;
export const COOLDOWN_HOURS = 24;

export const X_MAX_CHARS = 280;
export const BSKY_MAX_CHARS = 300;

export const POST_HISTORY_PATH = "data/post-history.jsonl";

export const CLAUDE_MODEL = "claude-sonnet-4-20250514";
export const CLAUDE_MAX_TOKENS = 100;
