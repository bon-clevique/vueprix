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

// PR-C B7: session 再利用化。
// 旧実装は send() 毎に new AtpAgent + login → publishFixedCandidates で fixed 3 件 → login 3 回。
// Bluesky login API は IP 単位 rate-limit (公式 docs: createSession は厳しめ)。
// module-scope に AtpAgent を保持し、初回 send で login → 2 回目以降は同 agent を再利用。
//
// AtpAgent は内部で 401/ExpiredToken を検知して refreshSession を自動実行するため、
// 通常の token 期限切れは agent.post() 層まで到達しない。よって post() の失敗種別を分けて
// 401/403 (= session/auth 異常) のみ cache を捨てる。429 (rate-limit) や 5xx (一過性) では
// valid session を捨てず再利用する (createSession rate-limit の浪費を回避)。
let cachedAgent: AtpAgent | null = null;

const resetAgent = (): void => {
  cachedAgent = null;
};

const getOrLoginAgent = async (identifier: string, password: string): Promise<AtpAgent> => {
  if (cachedAgent) return cachedAgent;
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  try {
    await agent.login({ identifier, password });
  } catch (err) {
    throw redactedBlueskyError('login', err);
  }
  cachedAgent = agent;
  return agent;
};

const send = async (input: PostInput): Promise<PostOutput> => {
  const identifier = process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_PASSWORD;
  if (!identifier || !password) {
    throw new Error('Bluesky credentials are not set');
  }
  const agent = await getOrLoginAgent(identifier, password);
  try {
    const res = await agent.post({ text: input.text, createdAt: new Date().toISOString() });
    const url = buildBlueskyUrl(res.uri);
    logger.info('poster.bluesky', 'Bluesky post sent', { asin: input.asin, uri: res.uri, url });
    return url ? { url } : {};
  } catch (err) {
    // session/auth 異常 (401/403) のみ cache reset。それ以外 (rate-limit 429 / 5xx / network) は
    // session 自体は valid なので保持し、次回 send で再利用する。
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) resetAgent();
    throw redactedBlueskyError('post', err);
  }
};

export const blueskyPoster: Poster = {
  name: 'bluesky',
  post: send,
};

// test 用 internal export。production code からは呼ばない (cachedAgent を強制リセットする)。
// vitest の各 it 間で agent state が漏れないよう beforeEach で呼ぶ想定。
export const __resetAgentForTesting = (): void => {
  cachedAgent = null;
};
