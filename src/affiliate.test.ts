import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildAffiliateUrl, requirePartnerTag } from './affiliate.js';

describe('buildAffiliateUrl', () => {
  it('builds Amazon.co.jp /dp/<ASIN>?tag=<TAG> URL', () => {
    expect(buildAffiliateUrl('B0C1JGD2T6', 'vueprix-22')).toBe(
      'https://www.amazon.co.jp/dp/B0C1JGD2T6?tag=vueprix-22',
    );
  });

  it('encodes ASIN and tag (defensive — both are normally URL-safe)', () => {
    expect(buildAffiliateUrl('A B', 'tag with space')).toBe(
      'https://www.amazon.co.jp/dp/A%20B?tag=tag%20with%20space',
    );
  });
});

describe('requirePartnerTag', () => {
  const original = process.env.PAAPI_PARTNER_TAG;

  beforeEach(() => {
    delete process.env.PAAPI_PARTNER_TAG;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PAAPI_PARTNER_TAG;
    } else {
      process.env.PAAPI_PARTNER_TAG = original;
    }
  });

  it('returns the env value when set', () => {
    process.env.PAAPI_PARTNER_TAG = 'vueprix-22';
    expect(requirePartnerTag()).toBe('vueprix-22');
  });

  it('throws when env is missing', () => {
    expect(() => requirePartnerTag()).toThrow(/PAAPI_PARTNER_TAG/);
  });

  it('throws on empty string', () => {
    process.env.PAAPI_PARTNER_TAG = '';
    expect(() => requirePartnerTag()).toThrow(/PAAPI_PARTNER_TAG/);
  });
});
