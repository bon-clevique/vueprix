import { TwitterApi } from 'twitter-api-v2';
import { logger } from '../logger.js';
import type { Poster, PostInput, PostOutput } from './types.js';

const redactedTweetError = (err: unknown): Error => {
  const status = (err as { code?: number; status?: number }).code
    ?? (err as { code?: number; status?: number }).status;
  return new Error(`X tweet failed${status ? ` (status ${status})` : ''}`);
};

// `/i/web/status/<id>` 形式は screen_name 取得 API を呼ばずに済み、X 側が正しいユーザーへ
// リダイレクトする。Notion bookmark 化した際の OG プレビューも正常に解決される。
const buildTweetUrl = (tweetId: string): string => `https://twitter.com/i/web/status/${tweetId}`;

const send = async (input: PostInput): Promise<PostOutput> => {
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
    const url = buildTweetUrl(res.data.id);
    logger.info('poster.x', 'X tweet posted', { asin: input.asin, tweetId: res.data.id, url });
    return { url };
  } catch (err) {
    throw redactedTweetError(err);
  }
};

export const xPoster: Poster = {
  name: 'x',
  post: send,
};
