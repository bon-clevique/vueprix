import { promises as fs } from 'node:fs';
import { resolvePath } from './fs-utils.js';
import { logger } from './logger.js';

// data/blocklist.md から「投稿しない ASIN」を読む。
// 形式: `<ASIN>  # コメント` の行を 1 件としてカウント。
// `#` で始まる行 (見出し / コメント単独行) と空行は無視。
//
// ASIN 検出は ^[A-Z0-9]{10}\b の regex (Amazon ASIN は通常 10 文字英数字、B で始まることが多い)。
// 行頭にスペースが入った場合も許容。
const ASIN_LINE = /^\s*([A-Z0-9]{10})\b/;

export const BLOCKLIST_PATH = 'data/blocklist.md';

export const parseBlocklist = (content: string): Set<string> => {
  const result = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    // `#` で始まる行 (markdown 見出し、コメント単独) は skip
    if (/^\s*#/.test(line)) continue;
    const match = ASIN_LINE.exec(line);
    if (match && match[1]) {
      result.add(match[1]);
    }
  }
  return result;
};

export const loadBlocklist = async (
  filePath: string = BLOCKLIST_PATH,
): Promise<Set<string>> => {
  const abs = resolvePath(filePath);
  try {
    const raw = await fs.readFile(abs, 'utf-8');
    const list = parseBlocklist(raw);
    logger.info('blocklist', 'loaded', { count: list.size });
    return list;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info('blocklist', 'no blocklist.md, treating as empty');
      return new Set();
    }
    logger.error('blocklist', 'failed to load (continuing with empty list)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
};
