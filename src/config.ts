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
];

// Amazon.co.jp = Keepa domain 5
// Verified via scripts/verify-keepa-categories.ts. See docs/notes/keepa-categories.md.
//   57239051   → 食品・飲料・お酒 (2.2M, food)
//   160384011  → ドラッグストア (3.6M, health)
//   2127209051 → パソコン・周辺機器 (6.4M, pc-desk)
//   637394     → ゲーム (489K, gaming)
//   3477981    → イヤホン・ヘッドホン本体 (93K, audio)
// 3833931 / 86893051 は PR-A B10 (2026-05-14) で verify した結果、それぞれ Keepa response に
// 存在せず / 「果物」(食品全体に包含) と判明したため削除。詳細: docs/notes/keepa-categories.md
export const KEEPA_DOMAIN = 5;
// 各 ID の Keepa 上での妥当性は scripts/verify-keepa-categories.ts で確認すること。
// docs/notes/keepa-categories.md に詳細。
//
// 3828871   → ホーム&キッチン (root, ~Amazon.co.jp 標準 browse node)
// 159241011 → 文房具・オフィス用品 (root, ~Amazon.co.jp 標準 browse node)
// 上記 2 ID は 2026 時点で Amazon.co.jp 上に長期存在する root browse node。Keepa /deal で
// 0 件返却する場合は ID 変更があった可能性 → verify script で再確認する。
export const KEEPA_CATEGORIES: readonly number[] = [
  57239051,
  160384011,
  2127209051,
  637394,
  3477981,
  3828871,
  159241011,
];

// Keepa /deal sortType: 1 = 値下率の高い順 (試験運用、要 A/B)。
// 旧: 4 (deal score) はジャンク商品が混ざりやすかったため、より明示的なシグナルに変更。
export const KEEPA_DEAL_SORT_TYPE = 1;

// KeepaTokenGuard の skip 閾値。1 call あたり 5-6 token 消費するため
// threshold=10 なら 1 call 余裕を持って次 call 可能、それ未満は借入リスク。
export const KEEPA_TOKEN_THRESHOLD = 10;

// カテゴリごとの draft 上限 (Keepa deals 由来のみ。FIXED_ASINS はこの枠外で別途追加される)。
// 合計 38 枠 (base allocation)。capacity (MAX_POSTS_PER_RUN) を上回ったぶんは
// quota.ts の Pass2 overflow が dropPercent 降順で再分配する。
// 「中庸」プリセット (PR-volume-1) — 1 日 12 run x ~50 件で 月 X 投稿の余裕枠を確保。
export const CATEGORY_QUOTA: Record<NotionCategory, number> = {
  food: 10,
  health: 8,
  kitchen: 5,
  stationery: 5,
  'pc-desk': 5,
  audio: 3,
  gaming: 2,
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

// 安全装置 (PA-API / Notion 連打抑制)。CATEGORY_QUOTA 合計 + BRAND_QUOTA × WATCH_BRANDS + FIXED_ASINS 想定数を上回る値で運用。
// quota.ts に capacity=MAX_POSTS_PER_RUN を渡すことで Pass2 overflow を解放、未消化カテゴリ枠を他カテゴリで埋める。
export const MAX_POSTS_PER_RUN = 60;
export const MIN_PRICE_YEN = 500;
// 30 日 (720h)。短い cooldown では同一 ASIN が頻繁に再候補化される。
// cooldown 拡張で queryDuplicateAsins の対象件数が増えるため、MAX_QUERY_PAGES=10 (1,000 件)
// 接近を `page cap reached` warn ログで監視する必要あり (src/notion.ts)。
export const COOLDOWN_HOURS = 720;

export const POST_HISTORY_PATH = "data/post-history.jsonl";

// X (Twitter) 投稿文字数上限。Bluesky は 300 chars でより緩いが両 SNS に同じ text を投げるため厳しい方 (X) に合わせる。
// fixed-templates.ts (composeFixedPostText) と publish.ts (deals/brand publish gate) が共通利用する single source of truth。
export const POST_TEXT_MAX_CHARS = 280;

// queryDuplicateAsins の Notion paging 上限。
// page_size=100 × MAX_QUERY_PAGES = 1000 件。到達時は warn ログ + 切り上げ (要拡張シグナル)。
export const MAX_QUERY_PAGES = 10;

// Brand watch 経路の設定 (Spec docs/specs/brand-watch.html §6.X 参照)。
// dry-run (scripts/verify-keepa-brand.ts) で確定した表記。漢字表記は Keepa の brand index に
// 載っておらず英語表記のみ hit する (例: 山﨑実業 → "Yamazaki" 50 hits、"山崎実業"/"山﨑実業" は 0)。
// scripts/verify-keepa-brand.ts で Keepa の brand index ヒット数を確認してから追加すること。
// 漢字表記はヒットしない傾向 (例: 「山﨑実業」→0、「Yamazaki」→50)。英語名を優先。
export const WATCH_BRANDS: readonly string[] = [
  'Yamazaki',     // 山﨑実業 (tower シリーズ等)
  'KAI',          // 貝印 (関孫六 等)
  'HARIO',        // HARIO (V60 等)
  'KINTO',        // KINTO (キッチン雑貨)
  'OXO',          // OXO (キッチンツール)
  'ZOJIRUSHI',    // 象印 (魔法瓶 等)
  'TIGER',        // タイガー魔法瓶
  'Pyrex',        // パイレックス (耐熱ガラス)
  'MUJI',         // 無印良品 (英語 brand 名で登録のもの)
];

// brand → NotionCategory map。WATCH_BRANDS に追加するブランドが non-kitchen 領域 (例: 貝印 の理容品 / 文房具系) に
// 拡張されるとき、本 map に entry を増やすだけで pipelines/brand.ts は変更不要。
// 未登録 brand への fallback は 'kitchen' (現運用は kitchen 中心のため穏当な default)。
export const BRAND_CATEGORY_MAP: Record<string, NotionCategory> = {
  Yamazaki: 'kitchen',
  KAI: 'kitchen',
  HARIO: 'kitchen',
  KINTO: 'kitchen',
  OXO: 'kitchen',
  ZOJIRUSHI: 'kitchen',
  TIGER: 'kitchen',
  Pyrex: 'kitchen',
  MUJI: 'kitchen',
};
export const BRAND_DEFAULT_CATEGORY: NotionCategory = 'kitchen';

// brand あたりの 1 run 採用上限。CATEGORY_QUOTA とは独立枠 (deals 経路を圧迫しない)。
// 3 brand × 2 件 = 6 件/run。MAX_POSTS_PER_RUN=30 に十分収まる。
export const BRAND_QUOTA = 2;

// brand 経路で 1 brand あたり checkAsin を呼ぶ件数の base limit。
// 上位 N 件 (deltaPercent90_AMAZON asc = 値下げ大きい順) を checkAsin、quota 未充足なら
// fallback で次の N 件 (= 合計 max 2 × N = 12 件) を追加 checkAsin。
// quota=2 × 3 (filter 落ち余裕) = 6 を base、fallback 2 段で最大 12 件まで拡張。
export const BRAND_CHECKASIN_LIMIT = 6;

// Keepa Product Finder (/query) で要求する values。perPage は max 50。
// page 0 のみ (page 1-9 は要望次第)。
export const BRAND_PAGE_SIZE = 50;
