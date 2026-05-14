import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PR-C B7: session 再利用化を pin する test。
// AtpAgent を vi.mock してログイン回数 / 投稿回数を観測する。
// vi.mock は hoist されるため、観測用 vi.fn() は vi.hoisted で持ち上げる必要がある。
const { loginMock, postMock, agentCtorSpy } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  postMock: vi.fn(),
  agentCtorSpy: vi.fn(),
}));

vi.mock('@atproto/api', () => ({
  AtpAgent: class MockAtpAgent {
    constructor(options?: unknown) {
      agentCtorSpy(options);
    }
    login = loginMock;
    post = postMock;
  },
}));

const originalIdentifier = process.env.BSKY_IDENTIFIER;
const originalPassword = process.env.BSKY_PASSWORD;

beforeEach(async () => {
  loginMock.mockReset();
  postMock.mockReset();
  agentCtorSpy.mockReset();
  loginMock.mockResolvedValue(undefined);
  postMock.mockResolvedValue({
    uri: 'at://did:plc:xxx/app.bsky.feed.post/abc123',
    cid: 'cid-xxx',
  });
  process.env.BSKY_IDENTIFIER = 'test-bot.bsky.social';
  process.env.BSKY_PASSWORD = 'app-password-xxx';
  // 各 it で agent state を初期化
  const mod = await import('./bluesky.js');
  mod.__resetAgentForTesting();
});

afterEach(() => {
  if (originalIdentifier === undefined) delete process.env.BSKY_IDENTIFIER;
  else process.env.BSKY_IDENTIFIER = originalIdentifier;
  if (originalPassword === undefined) delete process.env.BSKY_PASSWORD;
  else process.env.BSKY_PASSWORD = originalPassword;
});

describe('blueskyPoster session reuse (B7)', () => {
  it('reuses agent across consecutive posts (login is called only once for 3 posts)', async () => {
    const { blueskyPoster } = await import('./bluesky.js');
    await blueskyPoster.post({ asin: 'B0001', text: 'post 1' });
    await blueskyPoster.post({ asin: 'B0002', text: 'post 2' });
    await blueskyPoster.post({ asin: 'B0003', text: 'post 3' });
    expect(loginMock).toHaveBeenCalledTimes(1);  // login は 1 回のみ (session 再利用)
    expect(postMock).toHaveBeenCalledTimes(3);    // post は 3 回
    expect(agentCtorSpy).toHaveBeenCalledTimes(1); // AtpAgent も 1 回のみ生成
  });

  it('passes identifier and password from env to login on first post', async () => {
    const { blueskyPoster } = await import('./bluesky.js');
    await blueskyPoster.post({ asin: 'B0001', text: 'first' });
    expect(loginMock).toHaveBeenCalledWith({
      identifier: 'test-bot.bsky.social',
      password: 'app-password-xxx',
    });
  });

  it('re-logs in after a post failure (agent state reset on post error)', async () => {
    const { blueskyPoster } = await import('./bluesky.js');
    // 1 回目 post 成功 → 2 回目 post 失敗 → 3 回目で再 login して post 成功
    postMock
      .mockResolvedValueOnce({ uri: 'at://did:plc:xxx/app.bsky.feed.post/r1', cid: 'c1' })
      .mockRejectedValueOnce(new Error('post upstream 500'))
      .mockResolvedValueOnce({ uri: 'at://did:plc:xxx/app.bsky.feed.post/r3', cid: 'c3' });

    await blueskyPoster.post({ asin: 'B1', text: 't1' });          // 成功
    await expect(blueskyPoster.post({ asin: 'B2', text: 't2' })).rejects.toThrow(/Bluesky post failed/);
    await blueskyPoster.post({ asin: 'B3', text: 't3' });          // 再 login + post 成功

    // login 2 回 (初回 + post fail 後の再 login)、post 3 回 (成功/失敗/成功)
    expect(loginMock).toHaveBeenCalledTimes(2);
    expect(postMock).toHaveBeenCalledTimes(3);
  });

  it('throws redacted login error when login fails (regression)', async () => {
    loginMock.mockRejectedValueOnce(Object.assign(new Error('auth fail'), { status: 401 }));
    const { blueskyPoster } = await import('./bluesky.js');
    await expect(blueskyPoster.post({ asin: 'B0', text: 'x' })).rejects.toThrow(
      /Bluesky login failed \(status 401\)/,
    );
    // login fail 後は cache が立たないので、次の send は再度 login を試みる
    loginMock.mockResolvedValueOnce(undefined);
    await blueskyPoster.post({ asin: 'B1', text: 'y' });
    expect(loginMock).toHaveBeenCalledTimes(2);
  });

  it('throws when BSKY credentials are not set (regression、login mock 未到達)', async () => {
    delete process.env.BSKY_IDENTIFIER;
    delete process.env.BSKY_PASSWORD;
    const { blueskyPoster } = await import('./bluesky.js');
    await expect(blueskyPoster.post({ asin: 'B0', text: 'x' })).rejects.toThrow(/credentials are not set/);
    expect(loginMock).not.toHaveBeenCalled();
  });
});
