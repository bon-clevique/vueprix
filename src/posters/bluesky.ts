import { AtpAgent } from '@atproto/api';
import { BSKY_MAX_CHARS } from '../config.js';
import { logger } from '../logger.js';
import { buildPostText } from './format.js';
import type { Poster, PostInput } from './types.js';

const redactedBlueskyError = (phase: 'login' | 'post', err: unknown): Error => {
  const status = (err as { status?: number }).status;
  return new Error(`Bluesky ${phase} failed${status ? ` (status ${status})` : ''}`);
};

const send = async (input: PostInput): Promise<void> => {
  const text = buildPostText(input, BSKY_MAX_CHARS);
  const identifier = process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_PASSWORD;
  if (!identifier || !password) {
    throw new Error('Bluesky credentials are not set');
  }
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  try {
    await agent.login({ identifier, password });
  } catch (err) {
    throw redactedBlueskyError('login', err);
  }
  try {
    const res = await agent.post({ text, createdAt: new Date().toISOString() });
    logger.info('poster.bluesky', 'Bluesky post sent', { asin: input.product.asin, uri: res.uri });
  } catch (err) {
    throw redactedBlueskyError('post', err);
  }
};

export const blueskyPoster: Poster = {
  name: 'bluesky',
  maxChars: BSKY_MAX_CHARS,
  post: send,
};
