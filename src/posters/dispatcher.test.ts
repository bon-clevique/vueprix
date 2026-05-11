import { describe, expect, it } from 'vitest';
import { anySucceeded, dispatch, type PostResult } from './dispatcher.js';
import type { Poster, PostInput } from './types.js';

const baseInput: PostInput = {
  asin: 'B000',
  text: 'hello',
};

const okPoster = (name: string, url?: string): Poster => ({
  name,
  post: async () => (url ? { url } : {}),
});

const failPoster = (name: string, msg: string): Poster => ({
  name,
  post: async () => {
    throw new Error(msg);
  },
});

describe('dispatch', () => {
  it('returns ok=true for each succeeded poster', async () => {
    const result = await dispatch([okPoster('a'), okPoster('b')], baseInput);
    expect(result).toEqual({ a: { ok: true }, b: { ok: true } });
  });

  it('captures url returned by poster', async () => {
    const result = await dispatch(
      [okPoster('x', 'https://twitter.com/i/web/status/1'), okPoster('bluesky', 'https://bsky.app/profile/h/post/r')],
      baseInput,
    );
    expect(result).toEqual({
      x: { ok: true, url: 'https://twitter.com/i/web/status/1' },
      bluesky: { ok: true, url: 'https://bsky.app/profile/h/post/r' },
    });
  });

  it('returns ok=false for failed poster but does not abort siblings', async () => {
    const result = await dispatch(
      [okPoster('ok'), failPoster('bad', 'boom')],
      baseInput,
    );
    expect(result).toEqual({ ok: { ok: true }, bad: { ok: false } });
  });

  it('returns empty result for empty poster list', async () => {
    const result = await dispatch([], baseInput);
    expect(result).toEqual({});
  });
});

describe('anySucceeded', () => {
  it('returns true when at least one poster succeeded', () => {
    const r: PostResult = { x: { ok: false }, bluesky: { ok: true } };
    expect(anySucceeded(r)).toBe(true);
  });

  it('returns false when all failed', () => {
    const r: PostResult = { x: { ok: false }, bluesky: { ok: false } };
    expect(anySucceeded(r)).toBe(false);
  });

  it('returns false on empty result (no posters succeeded)', () => {
    expect(anySucceeded({})).toBe(false);
  });
});
