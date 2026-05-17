import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PR-1 Phase 2 Step 2-7: X poster の error log 詳細出力を pin する test。
// twitter-api-v2 を mock 化、tweet() を rejected で返して構造化 error の各 field が
// logger.error に渡ることを assert する。redacted Error throw 自体は別の責務として
// (status しか露出しない) 維持を確認する。
const { tweetMock, twitterCtorSpy } = vi.hoisted(() => ({
  tweetMock: vi.fn(),
  twitterCtorSpy: vi.fn(),
}));

vi.mock('twitter-api-v2', () => ({
  TwitterApi: class MockTwitterApi {
    constructor(options?: unknown) {
      twitterCtorSpy(options);
    }
    v2 = { tweet: tweetMock };
  },
}));

// logger は console.log/error 経由で JSON 1 line を出す。spy で content を観測する。
let errorSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

const originalApiKey = process.env.X_API_KEY;
const originalApiSecret = process.env.X_API_SECRET;
const originalAccessToken = process.env.X_ACCESS_TOKEN;
const originalAccessSecret = process.env.X_ACCESS_TOKEN_SECRET;

beforeEach(() => {
  tweetMock.mockReset();
  twitterCtorSpy.mockReset();
  process.env.X_API_KEY = 'k';
  process.env.X_API_SECRET = 's';
  process.env.X_ACCESS_TOKEN = 't';
  process.env.X_ACCESS_TOKEN_SECRET = 'a';
  // console.error は logger.error の出力先。console.log は logger.info / warn 等。
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  infoSpy.mockRestore();
  if (originalApiKey === undefined) delete process.env.X_API_KEY;
  else process.env.X_API_KEY = originalApiKey;
  if (originalApiSecret === undefined) delete process.env.X_API_SECRET;
  else process.env.X_API_SECRET = originalApiSecret;
  if (originalAccessToken === undefined) delete process.env.X_ACCESS_TOKEN;
  else process.env.X_ACCESS_TOKEN = originalAccessToken;
  if (originalAccessSecret === undefined) delete process.env.X_ACCESS_TOKEN_SECRET;
  else process.env.X_ACCESS_TOKEN_SECRET = originalAccessSecret;
});

// logger.error が emit する JSON 1 line を parse して中身を取り出す helper。
const lastErrorLog = (): Record<string, unknown> | undefined => {
  const calls = errorSpy.mock.calls;
  if (calls.length === 0) return undefined;
  const line = calls[calls.length - 1]?.[0];
  if (typeof line !== 'string') return undefined;
  return JSON.parse(line) as Record<string, unknown>;
};

describe('xPoster error log (Step 2-7)', () => {
  it('logs structured error detail before throwing redacted error (status / code / type / detail)', async () => {
    // twitter-api-v2 が throw する典型形 (403 Forbidden に近い shape)
    const apiError = {
      code: 403,
      type: 'response',
      data: {
        detail: 'You are not permitted',
        title: 'Forbidden',
        errors: [{ code: 87, message: 'Client not permitted' }],
      },
    };
    tweetMock.mockRejectedValueOnce(apiError);

    const { xPoster } = await import('./x.js');
    // redacted Error は status のみ露出する (内部詳細は logger.error に別 line で出る)。
    await expect(xPoster.post({ asin: 'B0FKL', text: 'hello' })).rejects.toThrow(/X tweet failed.*status 403/);

    const log = lastErrorLog();
    expect(log).toBeDefined();
    expect(log?.source).toBe('poster.x');
    expect(log?.message).toBe('X tweet failed');
    expect(log?.status).toBe(403);
    expect(log?.code).toBe(87);
    expect(log?.type).toBe('response');
    expect(log?.detail).toBe('You are not permitted');
  });

  it('falls back to data.code when data.errors is absent', async () => {
    const apiError = {
      code: 429,
      type: 'response',
      data: {
        code: 88, // Twitter v1 Rate limit exceeded
        title: 'Too Many Requests',
      },
    };
    tweetMock.mockRejectedValueOnce(apiError);

    const { xPoster } = await import('./x.js');
    await expect(xPoster.post({ asin: 'B0FKL', text: 'hello' })).rejects.toThrow();

    const log = lastErrorLog();
    expect(log?.status).toBe(429);
    expect(log?.code).toBe(88);
    expect(log?.detail).toBe('Too Many Requests'); // detail なし → title fallback
  });

  it('falls back to errors[0].message when detail/title are absent', async () => {
    const apiError = {
      code: 500,
      data: {
        errors: [{ code: 131, message: 'Internal error' }],
      },
    };
    tweetMock.mockRejectedValueOnce(apiError);

    const { xPoster } = await import('./x.js');
    await expect(xPoster.post({ asin: 'B0FKL', text: 'hello' })).rejects.toThrow();

    const log = lastErrorLog();
    expect(log?.status).toBe(500);
    expect(log?.code).toBe(131);
    expect(log?.detail).toBe('Internal error');
    // type 不在は undefined としては JSON.stringify で field ごと省略される
    expect(log?.type).toBeUndefined();
  });

  it('logs minimal shape when error has no recognized fields', async () => {
    tweetMock.mockRejectedValueOnce(new Error('network down'));

    const { xPoster } = await import('./x.js');
    await expect(xPoster.post({ asin: 'B0FKL', text: 'hello' })).rejects.toThrow();

    const log = lastErrorLog();
    expect(log).toBeDefined();
    expect(log?.source).toBe('poster.x');
    expect(log?.message).toBe('X tweet failed');
    // 全 field undefined → JSON.stringify で省略される
    expect(log?.status).toBeUndefined();
    expect(log?.code).toBeUndefined();
    expect(log?.type).toBeUndefined();
    expect(log?.detail).toBeUndefined();
  });
});
