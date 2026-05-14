import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NotionCategory } from './category.js';
import { POST_HISTORY_PATH } from './config.js';
import { resolvePath } from './fs-utils.js';
import { logger } from './logger.js';

export interface PostHistoryEntry {
  timestamp: string;
  runId: string;
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  // 'deals' / 'fixed' は draft 時のソース由来。
  // 'publish' は Notion DB 経由で publish された場合 (元 source は Notion DB に保存されていないため遡及できない)。
  // 'fixed-direct' は固定ASIN を Notion AI 経路を介さず X/Bluesky に即時投稿した場合 (draft.ts publishFixedCandidates)。
  source: 'deals' | 'fixed' | 'publish' | 'fixed-direct';
  category: NotionCategory;
  posters: Record<string, boolean>;
}

const truncateTitle = (title: string): string =>
  [...title.replace(/[\r\n]+/g, ' ')].slice(0, 200).join('');

export const appendHistory = async (
  entry: PostHistoryEntry,
  filePath: string = POST_HISTORY_PATH,
): Promise<void> => {
  const abs = resolvePath(filePath);
  const sanitized: PostHistoryEntry = { ...entry, title: truncateTitle(entry.title) };
  const line = `${JSON.stringify(sanitized)}\n`;
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, line, 'utf-8');
  } catch (err) {
    logger.error('history', 'append failed', {
      asin: entry.asin,
      type: err instanceof Error ? err.constructor.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

// PR-A3: post-history.jsonl から timestamp > now - cooldownHours のエントリを抽出して ASIN Set を返す。
// 用途: draft.ts の二重投稿ガード補強。Notion queryDuplicateAsins (primary) と union して活性 ASIN を確定する。
//   - 想定 race: publishFixedCandidates の SNS 投稿成功 → Notion createPostedPage 失敗 で、
//     Notion 上に entry が無く次回 run で再投稿される。history.jsonl は SNS 成功直後に append される
//     ため、こちらを secondary ガードとして読むことで race window を縮める。
//   - GitHub Actions cron は auto-commit 経由で jsonl を repo 同期するが lag があるため、
//     primary は Notion 側の DB。jsonl は補強であり single source of truth ではない。
// File 不在は空 Set 返却 (初回起動 / DRY_RUN 時の fail-safe)。malformed JSON 行は warn ログ + skip。
export const readRecentAsins = async (
  now: Date,
  cooldownHours: number,
  filePath: string = POST_HISTORY_PATH,
): Promise<Set<string>> => {
  const abs = resolvePath(filePath);
  const cutoff = now.getTime() - cooldownHours * 60 * 60 * 1000;
  const asins = new Set<string>();
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf-8');
  } catch (err) {
    // ENOENT は初回起動 / DRY_RUN 等の正常ケース。それ以外 (EACCES 等) は warn のみで空返却 (run を止めない)。
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return asins;
    }
    logger.warn('history', 'readRecentAsins read failed', {
      path: abs,
      error: err instanceof Error ? err.message : String(err),
    });
    return asins;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Partial<PostHistoryEntry>;
      if (!entry.timestamp || !entry.asin) continue;
      const t = Date.parse(entry.timestamp);
      if (Number.isNaN(t)) continue;
      if (t >= cutoff) asins.add(entry.asin);
    } catch (err) {
      // PR-A LOW-3: 運用 debug 時に「どの行が壊れたか」を特定できるよう先頭 100 文字を残す。
      // post-history.jsonl は ASIN / title / price / posters 程度しか持たず PII / secret は
      // そもそも入らないので preview の漏洩リスクなし。
      logger.warn('history', 'readRecentAsins malformed line, skipping', {
        error: err instanceof Error ? err.message : String(err),
        linePreview: line.slice(0, 100),
      });
    }
  }
  return asins;
};
