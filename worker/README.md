# vueprix-webhook-proxy

Cloudflare Worker that sits between the Notion automation and the
`vueprix` GitHub repository.

## Why this exists

The previous design had the Notion automation call
`https://api.github.com/repos/.../dispatches` directly with a GitHub
fine-grained PAT stored in the Notion automation's headers field. If
the Notion account was compromised, the PAT could be lifted out and
used to fire `repository_dispatch` events from anywhere.

This Worker moves the PAT out of Notion entirely. Notion only knows a
**shared secret** that authenticates webhook deliveries to this
Worker; the PAT lives in Cloudflare Worker secrets. A compromise of
Notion no longer leaks the PAT.

## Request contract

The Worker accepts **two** body formats:

### 1. Notion automation envelope JSON (production)

Notion automation の Webhook アクションが実際に送る payload。
2026-05-10 に wrangler tail で実機確認した形:

```
POST https://vueprix-webhook-proxy.<subdomain>.workers.dev/
Headers:
  X-Notion-Secret: <NOTION_SHARED_SECRET>
Body (JSON, Content-Type は Notion 側で application/json が自動付与):
  {
    "source": { "type": "automation", "automation_id": "...", "action_id": "...",
                "event_id": "...", "user_id": "...", "attempt": 1 },
    "data":   { "object": "page", "id": "35d3ad52-d5ca-81e9-ba32-c06cc505be49",
                "created_time": "...", "last_edited_time": "...",
                "created_by": { ... }, "last_edited_by": { ... } }
  }
```

Worker は body の先頭が `{` なら JSON parse を試み、`data.id` を target page UUID として抽出する。

### 2. Plain text UUID 単体 (curl smoke test, 後方互換)

```
POST https://vueprix-webhook-proxy.<subdomain>.workers.dev/
Headers:
  X-Notion-Secret: <NOTION_SHARED_SECRET>
Body (plain text — UUID 文字列単体, dashed / undashed 両対応):
  35c3ad52d5ca81b0acc1ee7a3808ae87
```

`Content-Type` header は不要 (Notion automation の custom header UI は
`Content-Type` 設定不可だが、JSON body の場合は Notion 本体が自動付与する)。
Worker は `req.text()` で読み出し → JSON っぽければ envelope parse → 不成立なら
plain text 全体を `trim()` してから end-anchored UUID regex で全文 match を厳格チェックする。

Responses:

| Status | Meaning |
|---|---|
| `202 Accepted` | `repository_dispatch` was fired successfully |
| `400 Bad Request` | empty body / 非 UUID / Notion envelope に `data.id` が無い・非 UUID / 旧 `{"page_id":"..."}` JSON |
| `401 Unauthorized` | missing or wrong `X-Notion-Secret` |
| `405 Method Not Allowed` | non-POST |
| `502 Bad Gateway` | GitHub API responded non-2xx |

## Local development

```bash
cd worker
npm install
npm run typecheck
npm test
```

`npm run dev` boots `wrangler dev` for local request shaping.

## Deployment (run-by-bon)

```bash
cd worker
npm install
npx wrangler login                            # first time only

# Set secrets (interactive prompt)
npx wrangler secret put GITHUB_PAT            # paste fine-grained PAT
npx wrangler secret put NOTION_SHARED_SECRET  # paste random string

npx wrangler deploy
# => https://vueprix-webhook-proxy.<your-subdomain>.workers.dev
```

After the first `wrangler deploy` succeeds, copy the printed URL into
`docs/notes/notion-approval-flow.md` (currently a placeholder) and
update the Notion automation:

1. **URL**: the Worker URL above
2. **Headers**: `X-Notion-Secret: <same value used in wrangler secret put>` **only** (do **not** add `Content-Type`)
3. **Body**: 空欄で OK。Notion automation の Webhook アクションは body 欄が空でも
   `{ "source": {...}, "data": { "object": "page", "id": "<page-uuid>", ... } }`
   形式の envelope JSON を自動送信する (2026-05-10 wrangler tail 実測)。
   Worker はこの `data.id` を target page UUID として抽出する。

The Worker re-asserts `event_type` from `DISPATCH_EVENT_TYPE` in
`wrangler.toml`, so Notion does not need to send it.

## Generating `NOTION_SHARED_SECRET`

```bash
openssl rand -hex 32   # 64-char hex string
```

Treat this like a password — it grants `repository_dispatch` access
once submitted to Notion. Rotate by re-running `wrangler secret put`
on the Worker side, then updating the Notion automation header.

## Public env vars (no rotation needed)

Defined in `wrangler.toml`:

- `GITHUB_OWNER = "bon-clevique"`
- `GITHUB_REPO = "vueprix"`
- `DISPATCH_EVENT_TYPE = "vueprix-publish"`

## Secrets (set with `wrangler secret put`, never committed)

- `GITHUB_PAT` — fine-grained PAT, `vueprix` repository only, Actions:Write + Metadata:Read
- `NOTION_SHARED_SECRET` — random shared secret matched against the request's `X-Notion-Secret` header

## Operational checks

After deploy, smoke-test from your laptop:

```bash
SECRET=<value used in wrangler secret put>
URL=https://vueprix-webhook-proxy.<subdomain>.workers.dev

# Expected: 401
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "$URL" \
  -d '12345678-90ab-cdef-1234-567890abcdef'

# Expected: 202 (fires a real repository_dispatch — use a throwaway page_id)
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "$URL" \
  -H "X-Notion-Secret: $SECRET" \
  -d '12345678-90ab-cdef-1234-567890abcdef'
```

The `202` smoke test will trigger the real `bot-publish.yml` workflow,
which will fail on `fetchPageById` since the page does not exist —
that is expected and confirms the chain works.
