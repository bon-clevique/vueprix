import { describe, expect, it } from 'vitest';
import { isRetryable } from './paapi.js';

describe('isRetryable', () => {
  it('retries on 429', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
  });

  it('retries on 5xx', () => {
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 599 })).toBe(true);
  });

  it('does not retry on 4xx (other than 429)', () => {
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  it('does not retry on 2xx/3xx', () => {
    expect(isRetryable({ status: 200 })).toBe(false);
    expect(isRetryable({ status: 301 })).toBe(false);
  });

  it('retries on known network error codes', () => {
    expect(isRetryable({ code: 'ENOTFOUND' })).toBe(true);
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryable({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isRetryable({ code: 'EAI_AGAIN' })).toBe(true);
    expect(isRetryable({ code: 'EPIPE' })).toBe(true);
  });

  it('does not retry on unknown error codes (e.g., ENOENT)', () => {
    expect(isRetryable({ code: 'ENOENT' })).toBe(false);
    expect(isRetryable({ code: 'EACCES' })).toBe(false);
    expect(isRetryable({ code: 'SomeAuthError' })).toBe(false);
  });

  it('does not retry on plain Error without status/code', () => {
    expect(isRetryable(new Error('plain'))).toBe(false);
    expect(isRetryable({})).toBe(false);
  });
});
