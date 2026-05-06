import { describe, expect, it } from 'vitest';
import { anySucceeded, dispatch, type PostResult } from './dispatcher.js';
import type { Poster, PostInput } from './types.js';

const baseInput: PostInput = {
  product: {
    asin: 'B000',
    title: 't',
    imageUrl: '',
    currentPrice: 100,
    affiliateUrl: 'https://example.com',
  },
  reason: 'r',
  referencePrice: 200,
  dropPercent: 50,
};

const okPoster = (name: string): Poster => ({
  name,
  maxChars: 280,
  post: async () => undefined,
});

const failPoster = (name: string, msg: string): Poster => ({
  name,
  maxChars: 280,
  post: async () => {
    throw new Error(msg);
  },
});

describe('dispatch', () => {
  it('returns true for each succeeded poster', async () => {
    const result = await dispatch([okPoster('a'), okPoster('b')], baseInput);
    expect(result).toEqual({ a: true, b: true });
  });

  it('returns false for failed poster but does not abort siblings', async () => {
    const result = await dispatch(
      [okPoster('ok'), failPoster('bad', 'boom')],
      baseInput,
    );
    expect(result).toEqual({ ok: true, bad: false });
  });

  it('returns empty result for empty poster list', async () => {
    const result = await dispatch([], baseInput);
    expect(result).toEqual({});
  });
});

describe('anySucceeded', () => {
  it('returns true when at least one poster succeeded', () => {
    const r: PostResult = { x: false, bluesky: true };
    expect(anySucceeded(r)).toBe(true);
  });

  it('returns false when all failed', () => {
    const r: PostResult = { x: false, bluesky: false };
    expect(anySucceeded(r)).toBe(false);
  });

  it('returns false on empty result (no posters succeeded)', () => {
    expect(anySucceeded({})).toBe(false);
  });
});
