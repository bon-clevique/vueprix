# vueprix

## Product Intent

Amazon の値下がり情報を「食・健康・生活の質」テーマに特化して X (@vueprix) と Bluesky (vueprix.bsky.social) に自動投稿する価格アラート bot。Amazon アソシエイト経由のコミッション収益が目標。PA-API は 2026-05-15 廃止につき Keepa 単一 source で運用 (ADR-005)。

## Current Focus

初期セットアップ (`DRY_RUN=true` で GitHub Actions 自走確認まで)
_Update weekly._

## Active ADRs

- [ADR-001: Project Foundation](docs/adr/001-project-foundation.md) — TypeScript + Node.js + GitHub Actions cron、Keepa/Claude/X/Bluesky 統合
- [ADR-005: PA-API 廃止 + platform 別 status](docs/adr/005-paapi-removal-and-platform-status.md) — Keepa 単一 source 化 / per-platform checkbox / silent loss 解消

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

- Keepa Pro プラン (€29/月、1 トークン/分 = 1,440/日) を前提
- X API 無料プラン: 月 1,500 ツイート上限
- `posted.json` は GitHub Actions 内で auto-commit して状態保持
- Notion DB「vueprix 投稿文」に `x_posted` / `bluesky_posted` (checkbox) プロパティが必要 (bon 手動追加済、ADR-005)
- env: `AMAZON_PARTNER_TAG` (旧 `PAAPI_PARTNER_TAG`、GitHub Secrets + .env 更新必須)
- 親プロジェクト clevique の PR / Squash Merge / `--base main` 規約に従う
