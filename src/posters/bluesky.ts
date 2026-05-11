import { AtpAgent } from '@atproto/api';
import { logger } from '../logger.js';
import type { Poster, PostInput, PostOutput } from './types.js';

const redactedBlueskyError = (phase: 'login' | 'post', err: unknown): Error => {
  const status = (err as { status?: number }).status;
  return new Error(`Bluesky ${phase} failed${status ? ` (status ${status})` : ''}`);
};

// vueprix bot 専用 account の handle を固定値で持つ。res.uri は
// `at://did:plc:xxx/app.bsky.feed.post/<rkey>` 形式なので、bsky.app の URL に変換するには
// rkey と handle が要る。DID → handle resolve を毎回叩くのを避けるため固定値にした。
// 将来 handle 変更時はここを更新する (bot account は 1 つしか無い前提)。
const BLUESKY_HANDLE = 'vueprix.bsky.social';

const buildBlueskyUrl = (atUri: string): string | undefined => {
  // 期待 form: at://did:plc:xxxx/app.bsky.feed.post/<rkey>
  const m = /\/app\.bsky\.feed\.post\/([^/]+)$/.exec(atUri);
  if (!m) return undefined;
  return `https://bsky.app/profile/${BLUESKY_HANDLE}/post/${m[1]}`;
};

const send = async (input: PostInput): Promise<PostOutput> => {
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
    const url = buildBlueskyUrl(res.uri);
    logger.info('poster.bluesky', 'Bluesky post sent', { asin: input.asin, uri: res.uri, url });
    return url ? { url } : {};
  } catch (err) {
    throw redactedBlueskyError('post', err);
  }
};

export const blueskyPoster: Poster = {
  name: 'bluesky',
  post: send,
};
