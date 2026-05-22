# vueprix

## Product Intent

Amazon の値下がり情報を「食・健康・生活の質」テーマに特化して X (@vueprix) と Bluesky (vueprix.bsky.social) に自動投稿する価格アラート bot。Amazon アソシエイト経由のコミッション収益が目標。PA-API は 2026-05-15 廃止につき Keepa 単一 source で運用 (ADR-005)。

## Current Focus

初期セットアップ (`DRY_RUN=true` で GitHub Actions 自走確認まで)
_Update weekly._

## Active ADRs

- [ADR-001: Project Foundation](docs/adr/001-project-foundation.md) — TypeScript + Node.js + GitHub Actions cron、Keepa/Claude/X/Bluesky 統合
- [ADR-005: PA-API 廃止 + platform 別 status](docs/adr/005-paapi-removal-and-platform-status.md) — Keepa 単一 source 化 / per-platform checkbox / silent loss 解消
- [ADR-006: Keepa token 消費削減](docs/adr/006-keepa-token-reduction.md) — brand limit + deals adaptive pagination + KeepaTokenGuard (threshold=10)

## Code Conventions

- Language: TypeScript (Node.js 22)
- Test framework: vitest (unit test only — 外部 API は DRY_RUN による E2E 確認)
- See `~/.claude/rules/` for global conventions、`.claude/rules/typescript/` for language rules
- 親プロジェクト規約: `~/dev/clevique/CLAUDE.md` (PR / Notion API / TS 品質ゲート)

## CI / Test / Deploy

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
npm start           # tsx src/index.ts (DRY_RUN=true でローカル確認)
```

GitHub Actions: `.github/workflows/ci.yml` (PR/push) と `.github/workflows/bot.yml` (cron 2h)。

## Known Constraints

- Keepa Pro プラン (€29/月、1 トークン/分 = 1,440/日) を前提。token 消費は brand 上位 N (=6/brand、fallback 2 段で max 12) + deals adaptive pagination (default 1 page、quota 充足時 break) に最適化。token 残量 < 10 で次回 run へ控える防御層あり (`src/keepa-token-guard.ts`、ADR-006)
- fixed 経路 (FIXED_ASINS) は本 PR で意図的に guard 未注入 (token 消費小、別 PR で対応予定)
- X API 無料プラン: 月 1,500 ツイート上限
- `posted.json` は GitHub Actions 内で auto-commit して状態保持
- Notion DB「vueprix 投稿文」に `x_posted` / `bluesky_posted` (checkbox) プロパティが必要 (bon 手動追加済、ADR-005)
- env: `AMAZON_PARTNER_TAG` (旧 `PAAPI_PARTNER_TAG`、GitHub Secrets + .env 更新必須)
- 親プロジェクト clevique の PR / Squash Merge / `--base main` 規約に従う
- **Publish flow (PR: post-interval)**: `bot-publish.yml` は **cron */5** で起動し drain mode で Notion approved の oldest 1 件のみ投稿する。`src/publish.ts` 内で Bluesky の最新自前 top-level post から **5〜15 分 (ランダム)** 経過しているか `app.bsky.feed.getAuthorFeed` で確認し、不足なら exit 0 で skip (Status=approved 据え置き → 次回 cron で retry)。getAuthorFeed 失敗時は **fail-safe で skip**。同一文面の連投 diversification は本 PR スコープ外 — 別 PR で対応する
- env (Bluesky): `BLUESKY_IDENTIFIER` / `BLUESKY_APP_PASSWORD` / `BLUESKY_DID`。旧 `BSKY_IDENTIFIER` / `BSKY_PASSWORD` は fallback で読まれるため、secrets rename は段階的に実施可 (空文字 = 未設定扱い)
- Notion automation の `repository_dispatch` (event_type=vueprix-publish) は本 PR で workflow から廃止。bon 側で automation を停止する運用変更が必要
