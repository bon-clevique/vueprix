import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { type Env, timingSafeEqual } from './index.js';

const VALID_PAGE_ID = '12345678-90ab-cdef-1234-567890abcdef';
const VALID_PAGE_ID_NODASH = '1234567890abcdef1234567890abcdef';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_PAT: 'fake-pat',
    NOTION_SHARED_SECRET: 'shared-secret-xyz',
    GITHUB_OWNER: 'bon-clevique',
    GITHUB_REPO: 'vueprix',
    DISPATCH_EVENT_TYPE: 'vueprix-publish',
    ...overrides,
  };
}

function buildReq(
  init: {
    method?: string;
    secret?: string | null;
    body?: unknown;
    rawBody?: string;
  } = {},
): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (init.secret !== null && init.secret !== undefined) {
    headers.set('X-Notion-Secret', init.secret);
  }
  return new Request('https://example.workers.dev/', {
    method: init.method ?? 'POST',
    headers,
    body:
      init.rawBody !== undefined
        ? init.rawBody
        : init.body !== undefined
          ? JSON.stringify(init.body)
          : undefined,
  });
}

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for differing strings of equal length', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for strings of different length', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('returns false for prefix match (a is prefix of b)', () => {
    expect(timingSafeEqual('shared-secret-xy', 'shared-secret-xyz')).toBe(
      false,
    );
  });

  it('returns false for prefix match (b is prefix of a)', () => {
    expect(timingSafeEqual('shared-secret-xyz', 'shared-secret-xy')).toBe(
      false,
    );
  });

  it('returns false even when shorter string matches completely', () => {
    expect(timingSafeEqual('abc', 'abcdefghij')).toBe(false);
  });
});

describe('webhook proxy fetch handler', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    // default: throw to surface unmocked outbound calls in non-happy-path tests
    fetchMock.mockImplementation(() => {
      throw new Error('unmocked fetch call');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects non-POST methods with 405', async () => {
    const res = await handler.fetch(buildReq({ method: 'GET' }), buildEnv());
    expect(res.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing X-Notion-Secret header with 401', async () => {
    const res = await handler.fetch(
      buildReq({ secret: null, body: { page_id: VALID_PAGE_ID } }),
      buildEnv(),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects mismatched X-Notion-Secret header with 401', async () => {
    const res = await handler.fetch(
      buildReq({ secret: 'wrong', body: { page_id: VALID_PAGE_ID } }),
      buildEnv(),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await handler.fetch(
      buildReq({ secret: 'shared-secret-xyz', rawBody: '{not json' }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid JSON');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects empty page_id with 400', async () => {
    const res = await handler.fetch(
      buildReq({ secret: 'shared-secret-xyz', body: { page_id: '' } }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-UUID page_id with 400', async () => {
    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: { page_id: 'not-a-uuid' },
      }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-string page_id with 400', async () => {
    const res = await handler.fetch(
      buildReq({ secret: 'shared-secret-xyz', body: { page_id: 42 } }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts dashed UUID, fires repository_dispatch, returns 202', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: { page_id: VALID_PAGE_ID },
      }),
      buildEnv(),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, page_id: VALID_PAGE_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.github.com/repos/bon-clevique/vueprix/dispatches',
    );
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe('POST');
    const headers = new Headers(reqInit.headers);
    expect(headers.get('Authorization')).toBe('Bearer fake-pat');
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
    expect(headers.get('User-Agent')).toBe('vueprix-webhook-proxy');
    expect(JSON.parse(reqInit.body as string)).toEqual({
      event_type: 'vueprix-publish',
      client_payload: { page_id: VALID_PAGE_ID },
    });
  });

  it('accepts dash-less UUID and forwards it verbatim', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: { page_id: VALID_PAGE_ID_NODASH },
      }),
      buildEnv(),
    );

    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reqInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(reqInit.body as string)).toEqual({
      event_type: 'vueprix-publish',
      client_payload: { page_id: VALID_PAGE_ID_NODASH },
    });
  });

  it('returns 502 when GitHub responds non-2xx', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      new Response('service unavailable', { status: 503 }),
    );

    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: { page_id: VALID_PAGE_ID },
      }),
      buildEnv(),
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toBe('GitHub dispatch failed: 503');
    expect(errSpy).toHaveBeenCalled();
  });
});
