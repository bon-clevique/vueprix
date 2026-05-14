import 'dotenv/config';
import { logger } from './logger.js';
import { main } from './run/orchestrator.js';

// vueprix entrypoint。実装本体は run/orchestrator.ts に分離 (PR-A4)。
// package.json scripts は `tsx src/draft.ts` を参照 — 本 file は薄い shim として保持する。
// PR-B (2026-05-14) で selectByQuota は run/quota.ts に分離、shim 経由 re-export は廃止。
// Candidate 型は types.ts が SoT、互換のため draft.ts 経由でも取れるよう re-export 維持。
export { main } from './run/orchestrator.js';
export type { Candidate } from './types.js';

// vitest 実行中は main() を自動起動しない (test がモジュールを import する際の副作用回避)。
if (!process.env.VITEST) {
  main().catch((err) => {
    // main() 内部で catch + finally まで完結するため、本来ここに来ない。
    // 万一 appendRunLog 自体が throw した場合 (best-effort 設計だが念のため) の最終 fallback。
    // source は orchestrator と揃える (ログ集計の一貫性、本 file 以外で 'draft' は使わない)。
    logger.error('orchestrator', 'unexpected outer error in entrypoint shim', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
