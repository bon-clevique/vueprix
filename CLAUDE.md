# vueprix

## Product Intent

Amazon の値下がり情報を「食・健康・生活の質」テーマに特化して X (@vueprix) と Bluesky (vueprix.bsky.social) に自動投稿する価格アラート bot。Amazon アソシエイト経由のコミッション収益と PA-API 利用条件維持が目標。

## Current Focus

初期セットアップ (`DRY_RUN=true` で GitHub Actions 自走確認まで)
_Update weekly._

## Active ADRs

- [ADR-001: Project Foundation](docs/adr/001-project-foundation.md) — TypeScript + Node.js + GitHub Actions cron、Keepa/PA-API/Claude/X/Bluesky 統合

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

- DRY_RUN=true で初期運用、1-2 週間後に false 切替 (別 PR)
- Keepa Pro プラン (€29/月、1 トークン/分 = 1,440/日) を前提
- X API 無料プラン: 月 1,500 ツイート上限
- `posted.json` は GitHub Actions 内で auto-commit して状態保持
- 親プロジェクト clevique の PR / Squash Merge / `--base main` 規約に従う
