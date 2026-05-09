import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { classifyAnthropicError } from './claude.js';

// Anthropic.APIError 系のサブクラスは直接 new せず、prototype chain を使った合成で代用。
// 実 SDK の APIError コンストラクタは複雑な引数を要求するため、`Object.setPrototypeOf` で
// instanceof チェックだけ通る互換オブジェクトを作る。
const synth = (
  Cls: new (...args: never[]) => Error,
  fields: { status?: number; message?: string; requestID?: string; type?: string },
): Error => {
  const e = new Error(fields.message ?? '');
  Object.setPrototypeOf(e, Cls.prototype);
  if (fields.status !== undefined) (e as { status?: number }).status = fields.status;
  if (fields.requestID !== undefined) (e as { requestID?: string }).requestID = fields.requestID;
  if (fields.type !== undefined) (e as { type?: string }).type = fields.type;
  return e;
};

describe('classifyAnthropicError', () => {
  it('detects credit_balance from BadRequestError message substring', () => {
    const err = synth(Anthropic.BadRequestError, {
      status: 400,
      message: 'Your credit balance is too low to access the Anthropic API.',
      requestID: 'req_abc',
      type: 'invalid_request_error',
    });
    const r = classifyAnthropicError(err);
    expect(r.category).toBe('credit_balance');
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('invalid_request_error');
    expect(r.requestId).toBe('req_abc');
  });

  it('classifies BadRequestError without credit hint as bad_request', () => {
    const err = synth(Anthropic.BadRequestError, {
      status: 400,
      message: 'Invalid model name',
    });
    expect(classifyAnthropicError(err).category).toBe('bad_request');
  });

  it('classifies RateLimitError as rate_limit', () => {
    const err = synth(Anthropic.RateLimitError, { status: 429 });
    expect(classifyAnthropicError(err).category).toBe('rate_limit');
  });

  it('classifies AuthenticationError as auth', () => {
    const err = synth(Anthropic.AuthenticationError, { status: 401 });
    expect(classifyAnthropicError(err).category).toBe('auth');
  });

  it('classifies PermissionDeniedError as auth', () => {
    const err = synth(Anthropic.PermissionDeniedError, { status: 403 });
    expect(classifyAnthropicError(err).category).toBe('auth');
  });

  it('classifies InternalServerError as server', () => {
    const err = synth(Anthropic.InternalServerError, { status: 500 });
    expect(classifyAnthropicError(err).category).toBe('server');
  });

  it('classifies plain Error as unknown', () => {
    const err = new Error('network down');
    expect(classifyAnthropicError(err).category).toBe('unknown');
  });

  it('returns null fields for unknown error shapes', () => {
    const r = classifyAnthropicError({});
    expect(r.status).toBeNull();
    expect(r.requestId).toBeNull();
    expect(r.errorType).toBeNull();
    expect(r.category).toBe('unknown');
  });

  it('extracts requestID (camelCase, SDK field name) when present', () => {
    const err = synth(Anthropic.RateLimitError, { status: 429, requestID: 'req_xyz' });
    expect(classifyAnthropicError(err).requestId).toBe('req_xyz');
  });

  it('extracts errorType from err.type on APIError subclass', () => {
    const err = synth(Anthropic.RateLimitError, { status: 429, type: 'rate_limit_error' });
    expect(classifyAnthropicError(err).errorType).toBe('rate_limit_error');
  });

  it('classifies NotFoundError as bad_request (4xx not server)', () => {
    const err = synth(Anthropic.NotFoundError, { status: 404 });
    expect(classifyAnthropicError(err).category).toBe('bad_request');
  });

  it('classifies APIConnectionError as server (network issue)', () => {
    const err = synth(Anthropic.APIConnectionError, {});
    expect(classifyAnthropicError(err).category).toBe('server');
  });

  it('does not include err.message in returned fields (redaction)', () => {
    const err = synth(Anthropic.BadRequestError, {
      status: 400,
      message: 'sensitive internal detail',
    });
    const r = classifyAnthropicError(err);
    expect(JSON.stringify(r)).not.toContain('sensitive internal detail');
  });
});
