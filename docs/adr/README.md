# Architecture Decision Records

This directory records important architectural decisions for the project.

## Format

- Filename: `NNN-title-with-hyphens.md`
- Template: see `~/.claude/adr/template.md`

## Index

- [ADR-001: Project Foundation](001-project-foundation.md) — initial tech stack and scope decisions
- [ADR-002: Notion Approval Flow](002-notion-approval-flow.md) — 2-stage pipeline (draft → human approval → publish), gadget categories, posted.json removal — **partially superseded by ADR-003** (Status enum / SLA portion)
- [ADR-003: Status Lifecycle Redesign](003-status-lifecycle-redesign.md) — 4-stage pipeline (backlog → doing → approved → posted) + rejected sidetrack, expire logic removal
