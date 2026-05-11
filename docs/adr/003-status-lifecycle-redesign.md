# ADR-003: Status ライフサイクル再設計 + expire ロジック撤廃

**Date**: 2026-05-11
**Status**: Accepted
**Supersedes (partially)**: [ADR-002 §1 承認フロー導入](./002-notion-approval-flow.md) の Status enum と 10h SLA 自動遷移部分

## Context

ADR-002 で導入した Notion 承認フローは `pending_review` → `approved` → `posted` の 3-stage pipeline に、10 時間 SLA 経過時に `expired` へ自動遷移するロジック (`expireOldDrafts` / `updateStatusToExpired`) を組み合わせていた。運用を重ねた結果、以下の課題が判明:

1. **「作業中」と「放置」が区別できない**: `pending_review` の row が文面作成中なのか、bon が手をつけていない放置状態なのかが Notion UI 上で見分けられない。複数ネタを並行で取捨選択する際に作業の優先度判断が困難
2. **`expired` 自動遷移の race condition**: bon が SLA 直前に `pending_review → approved` に変更した瞬間、別 cron の `expireOldDrafts` が Notion 側 indexing 遅延で `pending_review` を返し、上書きで承認が消える silent loss が起きうる。対策コード (`updateStatusToExpired` 内の retrieve→check→update の 2-step CAS) が必要で複雑化していた
3. **`rejected` の意味が曖昧**: 「サクラ度高」「マケプレ比率高」など意図的な不採用と、「気づいたら 10h 過ぎて expired」になったものが混在し、運用ガイドとしての価値が薄かった
4. **重複防止と再候補化の境界が不明確**: `queryDuplicateAsins` が `pending_review/approved/posted` のみを対象にしていたため、`rejected` ASIN が将来再度値下がりした場合の挙動が文書化されていなかった (実装上は再候補化されるが、これが意図的かどうか明示なし)
5. **PR #28 で Claude API を廃止して Notion AI 運用に移行**: 投稿文生成が外部 API から人手 (Notion AI) に変わったことで、「文面作成中」を明示する状態が必要になった

## Decision

### 1. Status 5 値の再設計

```
backlog → in_progress → approved → posted
                                 ↘
                                  rejected (sidetrack)
```

| 値 | 意味 |
|---|---|
| `backlog` | bot が cron で作成した直後の候補 (`投稿文` 空) |
| `in_progress` | bon が採用判断後、Notion AI で `投稿文` を作成中 (作業中の可視化) |
| `approved` | 文面 + レビュー完了。Notion automation が webhook を発火し publish へ |
| `posted` | publish 完了 (X / Bluesky 投稿成功、`投稿日時` セット済) |
| `rejected` | 投稿しないと判断したが、**運用ガイドラインとして残す価値がある** ネタ専用。理由のない不採用は Notion ページごと archive/delete (rejected に置かない) |

### 2. expire 自動遷移ロジック全廃

以下を全削除:
- `STATUS.EXPIRED` enum 値
- `STATUS.PENDING_REVIEW` enum 値 (`backlog` で代替)
- `expireOldDrafts` 関数
- `updateStatusToExpired` 関数
- `APPROVAL_SLA_HOURS` 定数
- `EXPIRE_WARN_THRESHOLD` 定数
- `src/draft.ts` の `expireOldDrafts` 呼び出しと `expired` log field

放置検知は **bon の週次手動レビュー** (`in_progress` フィルタで状況確認) で行う。

### 3. `queryDuplicateAsins` filter を 4 値に

```typescript
or: [
  { property: 'Status', status: { equals: STATUS.BACKLOG } },
  { property: 'Status', status: { equals: STATUS.IN_PROGRESS } },
  { property: 'Status', status: { equals: STATUS.APPROVED } },
  { property: 'Status', status: { equals: STATUS.POSTED } },
],
```

`rejected` は意図的に除外。価格が変わって同 ASIN が再度値下がりすれば新規 `backlog` として再候補化されることを許可する (運用意図、コメントに明記)。COOLDOWN_HOURS (24h) も `rejected` には適用されない — 再候補化された新規 backlog を bon が再評価する。

### 4. Status 内部値と表示 label の分離方針

コード上の Status 内部値は **snake_case** で統一 (`backlog` / `in_progress` / `approved` / `posted` / `rejected`)。URL encode / log 検索容易性のため。

Notion DB の status option の表示 label は自由 (例: `in_progress` 内部値に対して「in progress」(スペース) ラベルでも可)。

### 5. ADR-002 との関係

ADR-002 §1「承認フロー導入」の Status 値 (`pending_review` / `expired`) と 10h SLA 自動遷移は本 ADR で **superseded**。ADR-002 本文は歴史記録として残置 (header に Superseded 注記 + 該当節に本 ADR への参照を追加)。

ADR-002 §2 (ガジェット 3 カテゴリ追加) と §3 (posted.json 廃止) は引き続き有効。

## Alternatives considered

### A. `pending_review` のまま `in_progress` だけ追加 (4 値→5 値の最小変更)
**却下**: `pending_review` という名前は「レビュー待ち」の含意があり、新フローでは bon が能動的に取り組む `backlog` の方が実態に合う。同時に rename することで Notion DB option の整理 (旧 pending_review 削除) のタイミングが 1 度で済む

### B. expire 自動遷移は残し、SLA を 7 日に伸ばす
**却下**: race condition の complexity が残る。SLA 値の調整より「自動掃除そのものを廃止して人手判断に統一」の方が運用シンプル

### C. `rejected` を「dead end」のままにし、再候補化を許可しない
**却下**: 価格は時系列で変動するため、過去に不採用にした ASIN が将来「同条件でも採用に値する」状況になり得る。`rejected` を guideline 蓄積として活用し、再評価機会を残す方が運用上有益

### D. ADR-002 を in-place で書き換える
**却下**: ADR の audit trail を壊す。本 ADR-003 を新設し ADR-002 を Superseded マーク + 該当節に注記する方式を採用 (review feedback)

## Trade-offs

### 採用したことで失うもの
- **自動掃除の利便性**: `pending_review` が放置されても自動 expire しないため、bon が週次レビューを怠ると `backlog` / `in_progress` が無限に積まれる可能性
- **`expired` という観察可能な状態**: 「SLA 超過で投稿されなかった」という事実は記録されなくなる (運用ガイド価値は薄かったため許容)

### 採用したことで得るもの
- **コード単純化**: `expireOldDrafts` + `updateStatusToExpired` + race condition guard で約 90 行が消える
- **状態の意味的明確化**: `backlog` (放置 OK) / `in_progress` (作業中) / `rejected` (意図的不採用) が分離され、Notion UI 上での運用判断が容易に
- **`rejected` の guideline 価値向上**: 「価値ある不採用理由」だけが集積し、将来の判定材料 (blocklist 追加 / カテゴリ調整 / Notion AI プロンプト改善等) になる
- **再候補化の明示**: 同 ASIN が将来再度値下がりした際の挙動が文書化された

## Risks & mitigation

| Risk | Mitigation |
|---|---|
| `backlog` / `in_progress` 放置 | 週次レビュー (bon が `in_progress` フィルタで状況確認 → 手動 archive)。`docs/notes/notion-approval-flow.md` Status ライフサイクル節に明記 |
| `rejected` の規律が崩れる (理由なし不採用が rejected に混入) | コードで強制不可、運用ポリシーに依存。docs に「理由なしは archive/delete」と明記、定期的に bon が rejected を見返して理由が記載されているか check |
| 旧 `pending_review` / `expired` row の処分 | bon が手動で Notion DB を一括移行 (本 PR Out of Scope、運用 task)。Notion DB option も MCP 経由で再構成済 (本 PR 内で実施) |
| Notion DB option label と内部値の不一致 | notion.ts のコメントで内部値を snake_case に統一する旨を明記。Notion 側 option 編集時は内部値を変えず label のみ調整する規律 |

## Consequences

- `src/notion.ts`: `STATUS` enum と関連コードを書き換え、`expireOldDrafts` / `updateStatusToExpired` 関数削除
- `src/draft.ts`: `expireOldDrafts` 呼び出しと `expired` log field 削除
- `src/config.ts`: `APPROVAL_SLA_HOURS` / `EXPIRE_WARN_THRESHOLD` 削除
- テスト: `expireOldDrafts` describe 全削除、Status 値の assertion 更新、`in_progress` の throw テスト追加
- docs: `notion-approval-flow.md` / `notion-ai-post-generation.md` を新フローに更新
- ADR-002 header に Superseded 注記 + §1 に本 ADR への参照を追加
- Notion DB schema: Status option を `backlog` / `in_progress` / `approved` / `posted` / `rejected` に再構成 (MCP 経由で本 PR 内で実施予定 — 旧 option `expired` / `pending_review` / `post candidate` / `blocked` は削除、`backlog` (旧 option) を `backlog` (新内部値) としてリネーム維持)

## References

- 運用手順: `docs/notes/notion-approval-flow.md`
- Notion AI 文面生成: `docs/notes/notion-ai-post-generation.md`
- 元の承認フロー: [ADR-002](./002-notion-approval-flow.md)
