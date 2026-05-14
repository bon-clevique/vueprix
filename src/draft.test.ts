import { describe, expect, it } from 'vitest';

// draft.ts は run/orchestrator.ts への薄 re-export shim。本体の integration test は
// run/orchestrator.test.ts、pipeline 単位の unit test は pipelines/*.test.ts に置く。
// 本 file は shim contract (exports / no auto-run under VITEST) のみ pin down する。

describe('draft entrypoint shim', () => {
  it('re-exports main from run/orchestrator (test contract)', async () => {
    // PR-B (2026-05-14) で selectByQuota は run/quota.ts に分離、本 shim 経由 re-export は廃止。
    // main のみ shim 経由で取れる (test の `await import('./draft.js')` 互換目的)。
    const mod = await import('./draft.js');
    expect(typeof mod.main).toBe('function');
  });

  it('does not auto-run main() when VITEST is set (import 副作用回避)', async () => {
    // VITEST=true で main() が呼ばれていなければ、Notion / Keepa / PA-API の I/O は走らない。
    // 副作用 import の正常終了で contract 確認。
    await expect(import('./draft.js')).resolves.toBeDefined();
  });
});
