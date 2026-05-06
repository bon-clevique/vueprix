import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { COOLDOWN_HOURS, DROP_THRESHOLD_PERCENT, POSTED_JSON_PATH } from './config.js';

export type PostedRecord = Record<string, string>;

export const isGoodDeal = (current: number, reference: number, threshold = DROP_THRESHOLD_PERCENT): boolean => {
  if (reference <= 0 || current <= 0) return false;
  const dropPercent = ((reference - current) / reference) * 100;
  return dropPercent >= threshold;
};

export const calcDropPercent = (current: number, reference: number): number => {
  if (reference <= 0) return 0;
  return Math.round(((reference - current) / reference) * 100);
};

export const isAlreadyPosted = (
  asin: string,
  posted: PostedRecord,
  now: Date = new Date(),
  cooldownHours = COOLDOWN_HOURS,
): boolean => {
  const last = posted[asin];
  if (!last) return false;
  const lastTime = Date.parse(last);
  if (Number.isNaN(lastTime)) return false;
  const elapsedHours = (now.getTime() - lastTime) / (1000 * 60 * 60);
  return elapsedHours < cooldownHours;
};

export const markAsPosted = (
  asin: string,
  posted: PostedRecord,
  now: Date = new Date(),
): PostedRecord => ({
  ...posted,
  [asin]: now.toISOString(),
});

export const prunePosted = (
  posted: PostedRecord,
  now: Date = new Date(),
  cooldownHours = COOLDOWN_HOURS,
): PostedRecord => {
  const cutoff = now.getTime() - cooldownHours * 60 * 60 * 1000;
  const result: PostedRecord = {};
  for (const [asin, ts] of Object.entries(posted)) {
    const t = Date.parse(ts);
    if (!Number.isNaN(t) && t >= cutoff) {
      result[asin] = ts;
    }
  }
  return result;
};

const resolvePostedPath = (filePath = POSTED_JSON_PATH): string =>
  path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

export const loadPosted = async (filePath = POSTED_JSON_PATH): Promise<PostedRecord> => {
  const abs = resolvePostedPath(filePath);
  try {
    const raw = await fs.readFile(abs, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PostedRecord;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
};

export const savePosted = async (
  posted: PostedRecord,
  filePath = POSTED_JSON_PATH,
): Promise<void> => {
  const abs = resolvePostedPath(filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp.${process.pid}.${randomBytes(16).toString('hex')}`;
  const data = `${JSON.stringify(posted, null, 2)}\n`;
  try {
    await fs.writeFile(tmp, data, { encoding: 'utf-8', flag: 'wx' });
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
};
