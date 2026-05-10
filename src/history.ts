import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NotionCategory } from './category.js';
import { POST_HISTORY_PATH } from './config.js';
import { logger } from './logger.js';

export interface PostHistoryEntry {
  timestamp: string;
  runId: string;
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  source: 'deals' | 'fixed';
  category: NotionCategory;
  reason: string;
  dryRun: boolean;
  posters: Record<string, boolean>;
}

const resolvePath = (filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

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
