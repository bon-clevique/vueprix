# Architecture Decision Records

This directory records important architectural decisions for the project.

## Format

- Filename: `NNN-title-with-hyphens.md`
- Template: see `~/.claude/adr/template.md`

## Index

- [ADR-001: Project Foundation](001-project-foundation.md) — initial tech stack and scope decisions
- [ADR-002: Notion Approval Flow](002-notion-approval-flow.md) — 2-stage pipeline (draft → human approval → publish), gadget categories, posted.json removal — **partially superseded by ADR-003** (Status enum / SLA portion)
- [ADR-003: Status Lifecycle Redesign](003-status-lifecycle-redesign.md) — 4-stage pipeline (backlog → doing → approved → posted) + rejected sidetrack, expire logic removal
- [ADR-004: Run log Notion DB と Notion API retry/timeout](004-run-log-and-notion-retry.md) — cron 可視性向上 (run-log DB) + @notionhq/client retry/timeout 設定
- [ADR-005: PA-API 廃止 + Notion platform 別 status 連携](005-paapi-removal-and-platform-status.md) — Keepa 単一 source 化 / per-platform checkbox (x_posted / bluesky_posted) / silent loss 解消
- [ADR-006: Keepa token 消費削減](006-keepa-token-reduction.md) — brand limit (N=6 + fallback 2 段) / deals adaptive pagination / KeepaTokenGuard (threshold=10) による token 枯渇防止
