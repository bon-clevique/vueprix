import { logger } from '../logger.js';
import type { Poster, PostInput } from './types.js';

export interface PosterOutcome {
  ok: boolean;
  url?: string;
}

export type PostResult = Record<string, PosterOutcome>;

export const dispatch = async (posters: Poster[], input: PostInput): Promise<PostResult> => {
  const settled = await Promise.allSettled(posters.map((p) => p.post(input)));
  const result: PostResult = {};
  posters.forEach((p, i) => {
    const r = settled[i];
    if (r && r.status === 'fulfilled') {
      const out = r.value ?? {};
      result[p.name] = out.url ? { ok: true, url: out.url } : { ok: true };
    } else {
      result[p.name] = { ok: false };
      const reason = r && r.status === 'rejected' ? r.reason : new Error('unknown failure');
      logger.error('poster.dispatcher', `${p.name} post failed`, {
        asin: input.asin,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });
  return result;
};

export const anySucceeded = (result: PostResult): boolean =>
  Object.values(result).some((r) => r.ok);
