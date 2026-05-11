import { AtpAgent } from '@atproto/api';
import { logger } from '../logger.js';
import type { Poster, PostInput } from './types.js';

const redactedBlueskyError = (phase: 'login' | 'post', err: unknown): Error => {
  const status = (err as { status?: number }).status;
  return new Error(`Bluesky ${phase} failed${status ? ` (status ${status})` : ''}`);
};

const send = async (input: PostInput): Promise<void> => {
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
    const res = await agent.post({ text: input.text, createdAt: new Date().toISOString() });
    logger.info('poster.bluesky', 'Bluesky post sent', { asin: input.asin, uri: res.uri });
  } catch (err) {
    throw redactedBlueskyError('post', err);
  }
};

export const blueskyPoster: Poster = {
  name: 'bluesky',
  post: send,
};
