# ADR-006: Keepa token 消費削減 (brand limit + deals adaptive pagination)

**Date**: 2026-05-18
**Status**: Accepted

## Context

Keepa Pro plan (1 token/min = 1,440 token/day) における token 過大消費の構造的問題。

### 観測値 (2026-05-17 23:29 UTC)

- 現状消費: ~1,038 token/run × 12 run/day (cron 2h) = **12,456 token/day**
- 上限: 1,440 token/day
- **超過率: 8.6 倍**
- Keepa Pro plan の利用条件 (日次上限制限 / request throttling) 抵触による:
  - `checkAsin` per-brand 全件発火 (50 ASIN/brand のうち評価スコア上位 50 全て → checkAsin 50 call/brand)
  - deals 経路の固定 3 page 巡回 (page=0,1,2 を毎回全取得)
  - token 残量判定 mechanism なし (残量 <10 でも call 続行 → 429 Too Many Requests の連発)

Spec 参照: https://www.notion.so/Keepa-3643ad52d5ca814faea0e7f554c054ea

### Consequence of inaction

- **GitHub Actions cron が 2-3 run で停止**: 429 error → retry exponential backoff → timeout → workflow abort
- **DRY_RUN=false 運用開始 (目安: 2026-05-25) が実施不能**: token 枯渇リスク > production publish リスク
- **Keepa Pro plan upgrade 検討**: 現在 €29/月。Premium plan (~€60+) への 2x upgrade が必要な状況は非効率

## Decision

Keepa token 消費を構造的に削減する 4 つの施策を同一 PR (Phase 4) で導入。

### 1. Brand 経路の limit + fallback 2 段設計

**評価スコア上位 N 件に制限 (BRAND_CHECKASIN_LIMIT=6)**

`evaluateBrandAsins` の algorithm 変更:
- 各 brand ごと、Keepa search 結果を評価スコア (currentPrice / referencePrice 等) で降順ソート
- **上位 6 件のみ checkAsin を call** (従来: 50 件全て)
  - 削減: 50 → 6 token/brand (-88%)
- 上位 6 件全て adoption 不成立の場合のみ **fallback **: 次点 (7-12 位) の 6 件を追加取得
- さらに 12 件全て不成立なら以降のその brand は skip (1 brand あたり max 12 token)

**関連 API 変更**:
- `evaluateBrandAsins(guard: KeepaTokenGuard, ...): Promise<BrandHit[]>` — guard 引数を追加
- `collectBrandHits(brands[], ..., guard): Promise<Hit[]>` — guard 引数を cascade
- 各 checkAsin 前に `guard.shouldCall()` で token 残量判定、false 時は silent skip + warn log

### 2. Deals 経路の adaptive pagination

**デフォルト 1 page、quota 充足後に early break**

`getDeals` signature 変更:
- 従来: `getDeals(categoryId, sortType?)` — 3 page を内部で全巡回、category 全 deal を配列で返す
- **変更後**: `getDeals(categoryId, page, sortType?)` — 単一 page のみ取得、caller が pagination を制御

`collectDeals(categoryId, guard, ...)` の algorithm:
- page=0 (default) から開始
- `selectByQuota` で category quota (初期配分 food:10 health:8 ... ) と照合、目標件数達成で break
- **quota 未充足かつ tokensLeft > threshold 且つ page < KEEPA_DEAL_PAGE_MAX (=3) の場合のみ次 page へ**
- max 3 page まで (上限を enforced)
- **削減効果**: category quota 充足で早期 break (例: quota=10 で page=0,1 で達成 → page=2 呼ばない)

**env rename**:
- `KEEPA_DEAL_PAGES` → `KEEPA_DEAL_PAGE_MAX` (「3 page 固定」から「max 3 page」への意図変更を名前で反映)

### 3. KeepaTokenGuard (新規)

**`src/keepa-token-guard.ts`**:

```typescript
export class KeepaTokenGuard {
  private tokensLeft: number | null = null;
  private readonly defaultThreshold: number;

  constructor(threshold: number = KEEPA_TOKEN_THRESHOLD) {
    this.defaultThreshold = threshold;
  }

  shouldCall(threshold?: number): boolean {
    if (this.tokensLeft === null) return true;  // initial call
    return this.tokensLeft > (threshold ?? this.defaultThreshold);
  }

  updateTokensLeft(n: number | null | undefined): void {
    if (Number.isFinite(n) && n >= 0) {
      this.tokensLeft = n;
    }
  }

  getTokensLeft(): number | null {
    return this.tokensLeft;
  }
}
```

- threshold=10 (KEEPA_TOKEN_THRESHOLD) で、1 call (~5-6 token 消費) の余裕を確保
- run 全体で 1 instance を共有し、orchestrator (`src/run/orchestrator.ts`) で deals → fixed → brand の sequential pipeline に注入
- token 残量 < 10 で次回 call をskip、warning log を出力 (silent fail ではなく log に記録)

### 4. checkAsinWithTokens (新規)

**`src/keepa.ts` に新 function を追加**:

```typescript
/**
 * checkAsin with token accounting.
 * 返り値に tokensLeft を含め、guard が state を自動更新できるようにする。
 */
export async function checkAsinWithTokens(
  asin: string,
  ...
): Promise<{ history: PriceHistory; tokensLeft?: number }> {
  const response = await checkAsinInternal(asin, ...);
  return {
    history: response.priceHistory,
    tokensLeft: response.tokensLeft
  };
}

/**
 * 従来 function の thin wrapper (後方互換)。
 */
export async function checkAsin(asin: string, ...): Promise<PriceHistory> {
  const { history } = await checkAsinWithTokens(asin, ...);
  return history;
}
```

- 既存 `checkAsin` caller (fixed 経路) は影響なし
- brand 経路のみ `checkAsinWithTokens` を使用し、response の `tokensLeft` で guard を update

### 5. Orchestrator 経由 guard 配線

**`src/run/orchestrator.ts`**:

```typescript
export async function orchestrate(...) {
  const guard = new KeepaTokenGuard();

  // deals → fixed → brand の sequential 実行
  const deals = await collectDeals(..., guard);  // guard update
  const fixed = await collectFixedAsins(...);     // guard 未注入 (Spec §10 OoS、comment 付き)
  const brand = await collectBrandHits(..., guard); // guard update
  ...
}
```

fixed 経路は意図的に guard を省略 (コメント明文化: 固定 ASIN は token 消費小、別 PR で対応)。

## Consequences

### 利得

| 項目 | 削減数値 |
|---|---|
| Brand checkAsin per-brand | 50 → max 12 (-76%) |
| Deals pagination (quota 充足時) | 3 page → 1 page (-67%) |
| Token-low skip による連鎖防止 | 429 error の exponential backoff が発生しない |
| Run 全体での expected token 消費 | ~1,038 → ~380–450/run (セッション達成度で変動) |

- **Safe margin 確保**: 次回 run 前に token 枯渇を防ぐ (threshold=10)
- **log 可視性向上**: token-low skip は warn log に記録され、run-log DB で後追い確認可能
- **cron 安定性向上**: 2-3 run の連続失敗が大幅に低下

### 不利益・リスク

| リスク | Level | 対策 |
|---|---|---|
| **採用件数の劣化** | HIGH-1 (HIGH) | 1 week (7–14 run) 観察で Keepa hit rate 低下を監視。low hit なら branching strategy 再評価 (Spec §9.1 DA 参照) |
| **fallback 2 段の実装複雑化** | MEDIUM | per-brand state machine 追加 (success → fallback 1 → fallback 2 の 3 state)。comment で明文化 |
| **fixed 経路の guard 未注入** | LOW | token 消費小 (per-asin 1 call) で当面非ブロッキング。別 PR (backlog) で対応 |

### 中立

- deals pagination の page 制御が caller に移管 → caller side の quota 管理が必須 (既存 selectByQuota 参照)
- threshold=10 は conservative 設定 (更なる aggressive 化は future work)

## Alternatives Considered

| Alternative | Reason rejected |
|---|---|
| **cron 頻度の緩和** (2h → 4h 化) | Token 消費は削減できるが、情報鮮度の 2 倍低下は product intent に反す。ADR-001 Scope 外 (Spec §7.2 DA 参照) |
| **Keepa Premium plan アップグレード** (€29 → €60+) | 費用対効果が悪い。本 ADR で structural optimization が可能な領域を先に着手。upgrade は 1 week 観察後に判断 (Spec §9.1) |
| **Brand 経路の日次運用化** (bot = skip、bn 手動) | 自動運用の価値を喪失。botify が本来意図 (ADR-001) |
| **Keepa 以外の price source 追加** (Amazon Creators API / 複数 DB) | ADR-001 Scope out。本 PR では触れない |

## Related

- **Spec**: https://www.notion.so/Keepa-3643ad52d5ca814faea0e7f554c054ea (§5 Risk Analysis HIGH-1 / §7.2 DA branching strategy / §9.1 1-week observation)
- **ADR-001**: Project Foundation (Keepa Pro plan 1,440 token/day の初期前提)
- **Backlog** (別 PR):
  - Fixed 経路の guard 注入 (guard なし running already, low priority)
  - Threshold tuning (current 10 → aggressive 化検討)
  - Brand fallback strategy の per-brand success rate tracking (visibility)
