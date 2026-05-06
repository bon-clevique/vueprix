import { TwitterApi } from 'twitter-api-v2';
import { X_MAX_CHARS } from '../config.js';
import { logger } from '../logger.js';
import { buildPostText, isDryRun } from './format.js';
import type { Poster, PostInput } from './types.js';

const redactedTweetError = (err: unknown): Error => {
  const status = (err as { code?: number; status?: number }).code
    ?? (err as { code?: number; status?: number }).status;
  return new Error(`X tweet failed${status ? ` (status ${status})` : ''}`);
};

const send = async (input: PostInput): Promise<void> => {
  const text = buildPostText(input, X_MAX_CHARS);
  if (isDryRun()) {
    logger.info('poster.x', '[DRY RUN] X post', { asin: input.product.asin, text });
    return;
  }
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error('X credentials are not fully set');
  }
  const client = new TwitterApi({ appKey: apiKey, appSecret: apiSecret, accessToken, accessSecret });
  try {
    const res = await client.v2.tweet(text);
    logger.info('poster.x', 'X tweet posted', { asin: input.product.asin, tweetId: res.data.id });
  } catch (err) {
    throw redactedTweetError(err);
  }
};

export const xPoster: Poster = {
  name: 'x',
  maxChars: X_MAX_CHARS,
  post: send,
};
