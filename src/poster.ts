import { AtpAgent } from '@atproto/api';
import { TwitterApi } from 'twitter-api-v2';
import { BSKY_MAX_CHARS, X_MAX_CHARS } from './config.js';
import { logger } from './logger.js';
import type { ProductInfo } from './paapi.js';

export interface PostInput {
  product: ProductInfo;
  reason: string;
  referencePrice: number;
  dropPercent: number;
}

const formatYen = (n: number): string => `¥${n.toLocaleString('ja-JP')}`;

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

export const buildPostText = (input: PostInput, max: number): string => {
  const { product, reason, referencePrice, dropPercent } = input;
  const url = product.affiliateUrl;
  const hashtags = '#Amazon値下がり #生活の質';
  const priceLine = `${formatYen(referencePrice)} → ${formatYen(product.currentPrice)} (${dropPercent}%オフ)`;
  const tail = `\n\n→ Amazonで見る\n${url}\n\n${hashtags}`;
  const fixedReason = `\n\n${reason}\n\n通常 ${priceLine}`;
  const overhead = fixedReason.length + tail.length + '【値下がり】'.length;
  const titleBudget = Math.max(10, max - overhead);
  const title = truncate(product.title, titleBudget);
  const text = `【値下がり】${title}${fixedReason}${tail}`;
  return text.length > max ? truncate(text, max) : text;
};

const isDryRun = (): boolean => (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';

export const postToX = async (input: PostInput): Promise<void> => {
  const text = buildPostText(input, X_MAX_CHARS);
  if (isDryRun()) {
    logger.info('poster', '[DRY RUN] X post', { asin: input.product.asin, text });
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
  const res = await client.v2.tweet(text);
  logger.info('poster', 'X tweet posted', { asin: input.product.asin, tweetId: res.data.id });
};

export const postToBluesky = async (input: PostInput): Promise<void> => {
  const text = buildPostText(input, BSKY_MAX_CHARS);
  if (isDryRun()) {
    logger.info('poster', '[DRY RUN] Bluesky post', { asin: input.product.asin, text });
    return;
  }
  const identifier = process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_PASSWORD;
  if (!identifier || !password) {
    throw new Error('Bluesky credentials are not set');
  }
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier, password });
  const res = await agent.post({ text, createdAt: new Date().toISOString() });
  logger.info('poster', 'Bluesky post sent', { asin: input.product.asin, uri: res.uri });
};

export const postEverywhere = async (input: PostInput): Promise<void> => {
  await Promise.allSettled([postToX(input), postToBluesky(input)]).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.error('poster', 'post failed', {
          asin: input.product.asin,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  });
};
