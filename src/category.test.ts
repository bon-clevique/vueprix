import { describe, it, expect } from 'vitest';
import { mapKeepaCategoryToNotion, CATEGORY_FIXED } from './category.js';

describe('mapKeepaCategoryToNotion', () => {
  it('maps 57239051 to food', () => {
    expect(mapKeepaCategoryToNotion(57239051)).toBe('food');
  });

  it('maps 160384011 to health', () => {
    expect(mapKeepaCategoryToNotion(160384011)).toBe('health');
  });

  it('falls back to fixed-list for unknown category id', () => {
    expect(mapKeepaCategoryToNotion(999999999)).toBe('fixed-list');
  });

  it('CATEGORY_FIXED equals fixed-list', () => {
    expect(CATEGORY_FIXED).toBe('fixed-list');
  });
});
