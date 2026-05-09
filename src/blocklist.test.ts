import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadBlocklist, parseBlocklist } from './blocklist.js';

describe('parseBlocklist', () => {
  it('extracts ASIN from line with comment', () => {
    const result = parseBlocklist('B0C1JGD2T6  # 配送遅延クレーム多発');
    expect(result.has('B0C1JGD2T6')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('skips heading lines starting with #', () => {
    const md = `# Heading\n## Sub heading\nB0779N9GZF  # ok`;
    const result = parseBlocklist(md);
    expect(result.size).toBe(1);
    expect(result.has('B0779N9GZF')).toBe(true);
  });

  it('skips empty lines and whitespace', () => {
    const md = `\n\n   \nB01H09CWNG\n\n`;
    expect(parseBlocklist(md)).toEqual(new Set(['B01H09CWNG']));
  });

  it('handles multiple ASIN lines', () => {
    const md = `B0C1JGD2T6  # a\nB0779N9GZF\nB07B5CD8NY  # b`;
    expect(parseBlocklist(md)).toEqual(new Set(['B0C1JGD2T6', 'B0779N9GZF', 'B07B5CD8NY']));
  });

  it('does not match short or invalid pseudo-ASIN tokens', () => {
    expect(parseBlocklist('B0XX  # too short').size).toBe(0);
    expect(parseBlocklist('xxxxxxxxxx  # lowercase').size).toBe(0);
  });

  it('returns empty set for empty input', () => {
    expect(parseBlocklist('').size).toBe(0);
  });
});

describe('loadBlocklist', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vueprix-blocklist-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty set when file does not exist', async () => {
    const result = await loadBlocklist(path.join(tmpDir, 'missing.md'));
    expect(result.size).toBe(0);
  });

  it('reads ASINs from a real file', async () => {
    const file = path.join(tmpDir, 'blocklist.md');
    await fs.writeFile(file, '# header\nB0C1JGD2T6  # foo\nB0779N9GZF\n', 'utf-8');
    const result = await loadBlocklist(file);
    expect(result).toEqual(new Set(['B0C1JGD2T6', 'B0779N9GZF']));
  });
});
