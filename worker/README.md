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

```
POST https://vueprix-webhook-proxy.<subdomain>.workers.dev/
Headers:
  Content-Type: application/json
  X-Notion-Secret: <NOTION_SHARED_SECRET>
Body:
  { "page_id": "<notion-uuid>" }
```

Responses:

| Status | Meaning |
|---|---|
| `202 Accepted` | `repository_dispatch` was fired successfully |
| `400 Bad Request` | malformed JSON / missing or invalid `page_id` |
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
2. **Headers**: `X-Notion-Secret: <same value used in wrangler secret put>`
3. **Body**: unchanged (`{ "event_type": "vueprix-publish", "client_payload": { "page_id": "{{Page ID}}" } }`)

`event_type` is now optional from Notion's side because the Worker
re-asserts it from `DISPATCH_EVENT_TYPE` in `wrangler.toml`, but
keeping it in the Notion body is harmless for debugging.

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
  -H 'Content-Type: application/json' \
  -d '{"page_id":"12345678-90ab-cdef-1234-567890abcdef"}'

# Expected: 202 (fires a real repository_dispatch — use a throwaway page_id)
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "X-Notion-Secret: $SECRET" \
  -d '{"page_id":"12345678-90ab-cdef-1234-567890abcdef"}'
```

The `202` smoke test will trigger the real `bot-publish.yml` workflow,
which will fail on `fetchPageById` since the page does not exist —
that is expected and confirms the chain works.
