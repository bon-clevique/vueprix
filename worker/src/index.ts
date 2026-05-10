/**
 * vueprix-webhook-proxy
 *
 * Receives a webhook from a Notion automation when a row's Status is changed
 * to `approved`, authenticates the request with a shared secret (defence in
 * depth against PAT theft from the Notion side), then triggers a GitHub
 * `repository_dispatch` event so the `bot-publish.yml` workflow runs.
 *
 * The GitHub PAT itself lives only in Cloudflare Worker secrets and is never
 * exposed to Notion, eliminating the historical risk of PAT compromise via a
 * Notion account takeover.
 */

export interface Env {
  GITHUB_PAT: string;
  NOTION_SHARED_SECRET: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  DISPATCH_EVENT_TYPE: string;
}

// Notion page IDs are UUIDs and may arrive with or without dashes.
const NOTION_PAGE_ID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const handler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    // 1. Only POST is meaningful for repository_dispatch trigger.
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // 2. Shared-secret authentication. The Notion automation sets this header.
    //    Use a constant-time compare to avoid leaking length / position via
    //    response timing.
    const providedSecret = req.headers.get('X-Notion-Secret');
    if (
      !providedSecret ||
      !timingSafeEqual(providedSecret, env.NOTION_SHARED_SECRET)
    ) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 3. Parse body and validate the page_id.
    let body: { page_id?: unknown };
    try {
      body = (await req.json()) as { page_id?: unknown };
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    const pageId = typeof body.page_id === 'string' ? body.page_id : '';
    if (!NOTION_PAGE_ID_RE.test(pageId)) {
      return new Response('Invalid page_id', { status: 400 });
    }

    // 4. Fire repository_dispatch towards GitHub. The Worker holds the PAT so
    //    Notion never sees it.
    const ghRes = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_PAT}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'vueprix-webhook-proxy',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_type: env.DISPATCH_EVENT_TYPE,
          client_payload: { page_id: pageId },
        }),
      },
    );

    // 5. Forward an aggregated status. We deliberately do not echo the full
    //    GitHub error body to Notion to avoid leaking PAT-scope info to log
    //    aggregators that may capture Notion automation responses.
    if (!ghRes.ok) {
      const text = await ghRes.text();
      console.error('GitHub dispatch failed', {
        status: ghRes.status,
        text,
      });
      return new Response(`GitHub dispatch failed: ${ghRes.status}`, {
        status: 502,
      });
    }

    return new Response(JSON.stringify({ ok: true, page_id: pageId }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

export default handler;

/**
 * Constant-time string comparison. Length-mismatch returns early but only
 * leaks "length differs" rather than which byte differs.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
