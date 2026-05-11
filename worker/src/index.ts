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
// dashed (8-4-4-4-12) または undashed (32 hex) のいずれか。mixed-dash は拒否。
const NOTION_PAGE_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

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

    // 3. Body 受信 (plain text の page_id 文字列単体)
    //    Notion automation の Content-Type Header 設定不可制約に対応するため、JSON parse を行わず
    //    text として受信して trim 後に UUID validation で全文 match を厳格チェックする。
    //    Cloudflare Workers の req.text() は空 body でも空文字列を返し例外を投げないため try/catch は不要。
    const pageId = (await req.text()).trim();
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
      // GitHub error body は logging しない (PAT fragment 等の機微情報が含まれる可能性)。
      // status code のみ log し、必要なら GitHub の audit log を別途確認する。
      console.error('GitHub dispatch failed', { status: ghRes.status });
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
 * Constant-time string comparison.
 *
 * Pad shorter string so the loop always runs maxLen iterations.
 * Leaks neither length nor character position via response timing.
 *
 * Note: `charCodeAt` で out-of-bounds index は NaN を返す。NaN を XOR に
 * 渡すと 32-bit int 化で 0 扱いになるが、意図を明確化するため明示的に
 * Number.isNaN チェックで 0 へ fallback する (`?? 0` は null/undefined
 * 専用で NaN には triggered しないため使えない)。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  // length mismatch poisons diff so equal-length-but-different and
  // unequal-length both return false without an early-exit timing channel.
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ac = a.charCodeAt(i);
    const bc = b.charCodeAt(i);
    diff |= (Number.isNaN(ac) ? 0 : ac) ^ (Number.isNaN(bc) ? 0 : bc);
  }
  return diff === 0;
}
