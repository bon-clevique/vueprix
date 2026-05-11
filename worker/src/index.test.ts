import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { type Env, timingSafeEqual } from './index.js';

const VALID_PAGE_ID = '12345678-90ab-cdef-1234-567890abcdef';
const VALID_PAGE_ID_NODASH = '1234567890abcdef1234567890abcdef';

/**
 * Notion automation の実 webhook payload を模した envelope JSON。
 * 2026-05-10 に wrangler tail で実機確認した形を最小限に保持。
 */
function buildNotionEnvelope(pageId: string): string {
  return JSON.stringify({
    source: {
      type: 'automation',
      automation_id: 'aut-1',
      action_id: 'act-1',
      event_id: 'evt-1',
      user_id: 'usr-1',
      attempt: 1,
    },
    data: {
      object: 'page',
      id: pageId,
      created_time: '2026-05-10T00:00:00.000Z',
      last_edited_time: '2026-05-10T00:00:00.000Z',
      created_by: { object: 'user', id: 'usr-1' },
      last_edited_by: { object: 'user', id: 'usr-1' },
    },
  });
}

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
    body?: string;
  } = {},
): Request {
  // Notion automation は Content-Type Header を設定できないため、Worker は
  // Header 不在で body を受信する前提。test もそれを模す。
  const headers = new Headers();
  if (init.secret !== null && init.secret !== undefined) {
    headers.set('X-Notion-Secret', init.secret);
  }
  return new Request('https://example.workers.dev/', {
    method: init.method ?? 'POST',
    headers,
    body: init.body,
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
      buildReq({ secret: null, body: VALID_PAGE_ID }),
      buildEnv(),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects mismatched X-Notion-Secret header with 401', async () => {
    const res = await handler.fetch(
      buildReq({ secret: 'wrong', body: VALID_PAGE_ID }),
      buildEnv(),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects empty body with 400', async () => {
    const res = await handler.fetch(
      buildReq({ secret: 'shared-secret-xyz', body: '' }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-UUID body with 400', async () => {
    const res = await handler.fetch(
      buildReq({ secret: 'shared-secret-xyz', body: 'not-a-uuid' }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects legacy JSON body `{"page_id": "..."}` with 400 (data.id 不在)', async () => {
    // 旧フォーマット (`{"page_id":"..."}`) は data.id を持たないため拒否される。
    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: `{"page_id":"${VALID_PAGE_ID_NODASH}"}`,
      }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects UUID with extra suffix (regex end-anchor) with 400', async () => {
    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: `${VALID_PAGE_ID_NODASH}X`,
      }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects POST with no body (undefined) with 400', async () => {
    const res = await handler.fetch(
      buildReq({ secret: 'shared-secret-xyz' }), // body 省略
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects mixed-dash UUID (partial dashes) with 400', async () => {
    // dash が一部だけ抜けた UUID は厳格化により拒否
    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: '1234567890ab-cdef-1234-567890abcdef', // 先頭 dash なし、残り dash あり
      }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts dashed UUID via plain text body, fires repository_dispatch, returns 202', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await handler.fetch(
      buildReq({ secret: 'shared-secret-xyz', body: VALID_PAGE_ID }),
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

  it('accepts dash-less UUID via plain text body and forwards it verbatim', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: VALID_PAGE_ID_NODASH,
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

  it('accepts UUID with surrounding whitespace after trim', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: `  ${VALID_PAGE_ID_NODASH}  `,
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

  it('accepts UUID with trailing newline after trim', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: `${VALID_PAGE_ID}\n`,
      }),
      buildEnv(),
    );

    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reqInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(reqInit.body as string)).toEqual({
      event_type: 'vueprix-publish',
      client_payload: { page_id: VALID_PAGE_ID },
    });
  });

  // ---- Notion automation envelope JSON body ----

  it('accepts Notion envelope JSON with dashed data.id, fires repository_dispatch, returns 202', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: buildNotionEnvelope(VALID_PAGE_ID),
      }),
      buildEnv(),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, page_id: VALID_PAGE_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const reqInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(reqInit.body as string)).toEqual({
      event_type: 'vueprix-publish',
      client_payload: { page_id: VALID_PAGE_ID },
    });
  });

  it('accepts Notion envelope JSON with undashed data.id', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: buildNotionEnvelope(VALID_PAGE_ID_NODASH),
      }),
      buildEnv(),
    );

    expect(res.status).toBe(202);
    const reqInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(reqInit.body as string)).toEqual({
      event_type: 'vueprix-publish',
      client_payload: { page_id: VALID_PAGE_ID_NODASH },
    });
  });

  it('rejects Notion envelope with missing data field with 400', async () => {
    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: JSON.stringify({ source: { type: 'automation' } }),
      }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects Notion envelope with missing data.id field with 400', async () => {
    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: JSON.stringify({
          source: { type: 'automation' },
          data: { object: 'page' },
        }),
      }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects Notion envelope with non-UUID data.id string with 400', async () => {
    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: JSON.stringify({
          source: { type: 'automation' },
          data: { object: 'page', id: 'not-a-uuid' },
        }),
      }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects envelope with empty string data.id', async () => {
    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: JSON.stringify({
          source: {
            type: 'automation',
            automation_id: 'aut-1',
            action_id: 'act-1',
            event_id: 'evt-1',
            user_id: 'usr-1',
            attempt: 1,
          },
          data: { object: 'page', id: '' },
        }),
      }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects empty JSON object `{}` with 400', async () => {
    const res = await handler.fetch(
      buildReq({ secret: 'shared-secret-xyz', body: '{}' }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON starting with `{` (parse error → fallback also fails) with 400', async () => {
    // 先頭 `{` で JSON parse を試みるが malformed → fallback で plain text 全体を UUID 評価 → 不一致 400
    const res = await handler.fetch(
      buildReq({
        secret: 'shared-secret-xyz',
        body: '{not-json',
      }),
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid page_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 when GitHub responds non-2xx', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      new Response('service unavailable', { status: 503 }),
    );

    const res = await handler.fetch(
      buildReq({ secret: 'shared-secret-xyz', body: VALID_PAGE_ID }),
      buildEnv(),
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toBe('GitHub dispatch failed: 503');
    expect(errSpy).toHaveBeenCalled();
  });
});
