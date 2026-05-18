import { describe, it, expect, beforeEach } from 'vitest';
import { KeepaTokenGuard } from './keepa-token-guard.js';

describe('KeepaTokenGuard', () => {
  let guard: KeepaTokenGuard;
  beforeEach(() => {
    guard = new KeepaTokenGuard();
  });

  it('returns true on initial state (tokensLeft=null)', () => {
    expect(guard.shouldCall()).toBe(true);
  });

  it('returns true when tokensLeft >= threshold', () => {
    guard.updateTokensLeft(50);
    expect(guard.shouldCall(10)).toBe(true);
  });

  it('returns false when tokensLeft < threshold', () => {
    guard.updateTokensLeft(5);
    expect(guard.shouldCall(10)).toBe(false);
  });

  it('returns false when tokensLeft equals threshold (strict greater-than)', () => {
    // Plan §2 Step 1.3 (d): update(10) → strict less-than `< 10` で false。
    // 等しい境界は安全側に倒して skip (= 実装は tokensLeft > threshold で true)。
    guard.updateTokensLeft(10);
    expect(guard.shouldCall(10)).toBe(false);
  });

  it('updateTokensLeft is no-op for undefined/null', () => {
    guard.updateTokensLeft(50);
    guard.updateTokensLeft(undefined);
    expect(guard.shouldCall(10)).toBe(true); // 50 のまま
    guard.updateTokensLeft(null);
    expect(guard.shouldCall(10)).toBe(true);
  });
});
