import { AtpAgent, RichText } from '@atproto/api';
import { logger } from '../logger.js';
import type { Poster, PostInput, PostOutput } from './types.js';

const redactedBlueskyError = (phase: 'login' | 'post' | 'getAuthorFeed', err: unknown): Error => {
  const status = (err as { status?: number }).status;
  return new Error(`Bluesky ${phase} failed${status ? ` (status ${status})` : ''}`);
};

// 認証 env: BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD を優先し、
// 既存 secret 互換のため BSKY_IDENTIFIER / BSKY_PASSWORD を fallback として読む。
// GitHub Actions では未設定 secret が空文字 ("") で env に展開されるため、`??` ではなく
// 空文字も「未設定」扱いにする truthy check で fallback させる必要がある。
const pickEnv = (...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.length > 0) return v;
  }
  return undefined;
};

const readBlueskyCredentials = (): { identifier: string; password: string } | null => {
  const identifier = pickEnv('BLUESKY_IDENTIFIER', 'BSKY_IDENTIFIER');
  const password = pickEnv('BLUESKY_APP_PASSWORD', 'BSKY_PASSWORD');
  if (!identifier || !password) return null;
  return { identifier, password };
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
  const creds = readBlueskyCredentials();
  if (!creds) {
    throw new Error('Bluesky credentials are not set');
  }
  const agent = await getOrLoginAgent(creds.identifier, creds.password);
  try {
    // facets を付けないと URL がプレーンテキスト扱いになり hyperlink として描画されない。
    // RichText.detectFacets は URL を UTF-8 byte offset で抽出して facets を組み立てる。
    // @mention は今の投稿テンプレに含まれないが、将来追加された時に handle→DID を
    // 解決できるよう、agent 付き版を使う (URL のみの text なら追加の network call は発生しない)。
    const rt = new RichText({ text: input.text });
    await rt.detectFacets(agent);
    const res = await agent.post({
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
    });
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

// interval gate 用: 自分の最新 top-level post の createdAt を取得する。
//   - reply (item.reply あり) は除外 — 連投判定対象は自前の主投稿のみ
//   - repost (item.reason あり) は除外 — 他人の投稿の再シェアは throttle 対象外
//   - actor は BLUESKY_DID を優先、なければ identifier (handle) で代替
// fail mode:
//   - 認証 env 未設定 / API throw → 呼び出し側で fail-safe 判定 (skip post) する責務
//   - 自分の post が見つからない (新規アカウント / API limit 越え等) → null を返す
//
// limit=20 は十分余裕を持たせている (top-level post が連続 20 件 reply のみで埋まることは現実的に皆無)。
export const getLatestSelfPostAt = async (): Promise<Date | null> => {
  const creds = readBlueskyCredentials();
  if (!creds) {
    throw new Error('Bluesky credentials are not set');
  }
  const agent = await getOrLoginAgent(creds.identifier, creds.password);
  // BLUESKY_DID 未設定時は handle で代替 (AT Protocol は actor に DID / handle 両方受け付ける)。
  // 空文字 (GH Secrets 未設定) も identifier fallback で吸収する。
  const actor = pickEnv('BLUESKY_DID') ?? creds.identifier;
  let res;
  try {
    res = await agent.app.bsky.feed.getAuthorFeed({
      actor,
      limit: 20,
      filter: 'posts_no_replies',
    });
  } catch (err) {
    throw redactedBlueskyError('getAuthorFeed', err);
  }
  for (const item of res.data.feed) {
    // repost (item.reason) と reply (item.reply) を除外 — 自前 top-level post のみが対象。
    if (item.reason) continue;
    if (item.reply) continue;
    const createdAt = (item.post.record as { createdAt?: string }).createdAt;
    if (createdAt) {
      const d = new Date(createdAt);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
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
