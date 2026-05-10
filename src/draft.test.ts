import { describe, expect, it, vi } from 'vitest';

// Mock @notionhq/client to avoid real network calls if main were ever invoked.
vi.mock('@notionhq/client', () => ({
  Client: class {
    pages = { create: vi.fn(), update: vi.fn(), retrieve: vi.fn() };
    dataSources = { query: vi.fn() };
  },
}));

describe('draft entrypoint', () => {
  it('exports main and does not auto-run when VITEST is set', async () => {
    // VITEST is set automatically by the runner. main() should be a callable export but not invoked.
    const mod = await import('./draft.js');
    expect(typeof mod.main).toBe('function');
    // No assertion on side effects: if main had run, it would attempt to read env / call APIs.
  });
});
