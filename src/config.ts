export const FIXED_ASINS: readonly string[] = [
  'B0C1JGD2T6',
  'B09QMHL2NN',
  'B0779N9GZF',
  'B07B5CD8NY',
  'B06VTRH7Z8',
  'B09JL4R6SX',
  'B01H09CWNG',
  'B0B5GP4S36',
];

// Amazon.co.jp = Keepa domain 5
// 2277721051: 食品・飲料, 2250739051: ドラッグストア
export const KEEPA_DOMAIN = 5;
export const KEEPA_CATEGORIES: readonly number[] = [2277721051, 2250739051];

export const DROP_THRESHOLD_PERCENT = 15;
export const HISTORY_DAYS = 90;

export const MAX_POSTS_PER_RUN = 3;
export const MIN_PRICE_YEN = 500;
export const COOLDOWN_HOURS = 24;

export const X_MAX_CHARS = 280;
export const BSKY_MAX_CHARS = 300;

export const POSTED_JSON_PATH = 'data/posted.json';

export const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
export const CLAUDE_MAX_TOKENS = 100;
