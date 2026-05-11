import { TwitterApi } from 'twitter-api-v2';
import { logger } from '../logger.js';
import type { Poster, PostInput } from './types.js';

const redactedTweetError = (err: unknown): Error => {
  const status = (err as { code?: number; status?: number }).code
    ?? (err as { code?: number; status?: number }).status;
  return new Error(`X tweet failed${status ? ` (status ${status})` : ''}`);
};

const send = async (input: PostInput): Promise<void> => {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error('X credentials are not fully set');
  }
  const client = new TwitterApi({ appKey: apiKey, appSecret: apiSecret, accessToken, accessSecret });
  try {
    const res = await client.v2.tweet(input.text);
    logger.info('poster.x', 'X tweet posted', { asin: input.asin, tweetId: res.data.id });
  } catch (err) {
    throw redactedTweetError(err);
  }
};

export const xPoster: Poster = {
  name: 'x',
  post: send,
};
