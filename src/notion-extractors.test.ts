import { describe, expect, it } from 'vitest';
import {
  extractDate,
  extractNumber,
  extractRichText,
  extractSelect,
  extractStatus,
  extractTitleText,
  extractUrl,
} from './notion-extractors.js';

// notion-extractors.ts は notion.ts / fixed-templates.ts の重複 helper を集約した正典 file。
// 旧 file 間で挙動が異なっていた箇所 (extractNumber default 0 vs null、extractUrl protocol check 等) は
// 堅牢版に統一済。本 test は boundary case で正典挙動を pin down する。

describe('extractRichText', () => {
  it('joins plain_text segments', () => {
    expect(
      extractRichText({ rich_text: [{ plain_text: 'a' }, { plain_text: 'b' }] }),
    ).toBe('ab');
  });
  it('returns empty string for null/undefined/non-object', () => {
    expect(extractRichText(null)).toBe('');
    expect(extractRichText(undefined)).toBe('');
    expect(extractRichText('string')).toBe('');
    expect(extractRichText({})).toBe('');
  });
  it('treats missing plain_text as empty', () => {
    expect(extractRichText({ rich_text: [{}, { plain_text: 'x' }] })).toBe('x');
  });
});

describe('extractTitleText', () => {
  it('joins title segments and trims leading/trailing whitespace', () => {
    expect(
      extractTitleText({ title: [{ plain_text: '  hello  ' }] }),
    ).toBe('hello');
  });
  it('returns empty string when missing', () => {
    expect(extractTitleText(null)).toBe('');
    expect(extractTitleText({})).toBe('');
    expect(extractTitleText({ title: [] })).toBe('');
  });
});

describe('extractSelect', () => {
  it('returns select.name', () => {
    expect(extractSelect({ select: { name: 'food' } })).toBe('food');
  });
  it('returns empty string when select is null/missing', () => {
    expect(extractSelect({ select: null })).toBe('');
    expect(extractSelect({})).toBe('');
    expect(extractSelect(null)).toBe('');
  });
});

describe('extractStatus', () => {
  it('returns status.name', () => {
    expect(extractStatus({ status: { name: 'approved' } })).toBe('approved');
  });
  it('returns empty string when status is null/missing', () => {
    expect(extractStatus({ status: null })).toBe('');
    expect(extractStatus({})).toBe('');
  });
});

describe('extractNumber', () => {
  it('returns finite numbers as-is', () => {
    expect(extractNumber({ number: 0 })).toBe(0);
    expect(extractNumber({ number: -42.5 })).toBe(-42.5);
    expect(extractNumber({ number: 1234567 })).toBe(1234567);
  });
  it('returns null for null/undefined/NaN/Infinity (silent default 0 を返さない、堅牢版)', () => {
    expect(extractNumber({ number: null })).toBeNull();
    expect(extractNumber({ number: undefined })).toBeNull();
    expect(extractNumber({ number: NaN })).toBeNull();
    expect(extractNumber({ number: Infinity })).toBeNull();
    expect(extractNumber({})).toBeNull();
    expect(extractNumber(null)).toBeNull();
  });
});

describe('extractUrl', () => {
  it('returns trimmed https/http URLs', () => {
    expect(extractUrl({ url: 'https://example.com/path' })).toBe('https://example.com/path');
    expect(extractUrl({ url: '  https://example.com  ' })).toBe('https://example.com');
    expect(extractUrl({ url: 'http://example.com' })).toBe('http://example.com');
  });
  it('returns null for null/empty/whitespace', () => {
    expect(extractUrl({ url: null })).toBeNull();
    expect(extractUrl({ url: '' })).toBeNull();
    expect(extractUrl({ url: '   ' })).toBeNull();
    expect(extractUrl({})).toBeNull();
    expect(extractUrl(null)).toBeNull();
  });
  it('returns null for non-http(s) schemes (defense against javascript:, free-form text, ftp 等)', () => {
    expect(extractUrl({ url: 'javascript:alert(1)' })).toBeNull();
    expect(extractUrl({ url: 'ftp://example.com' })).toBeNull();
    expect(extractUrl({ url: 'plain text not a url' })).toBeNull();
    expect(extractUrl({ url: 'mailto:foo@bar.com' })).toBeNull();
  });
});

describe('extractDate', () => {
  it('returns date.start ISO string', () => {
    expect(extractDate({ date: { start: '2026-05-14T00:00:00.000Z' } })).toBe(
      '2026-05-14T00:00:00.000Z',
    );
  });
  it('coerces empty string to null (publish.ts の if (payload.postedAt) guard を補強)', () => {
    expect(extractDate({ date: { start: '' } })).toBeNull();
    expect(extractDate({ date: { start: null } })).toBeNull();
    expect(extractDate({ date: null })).toBeNull();
    expect(extractDate({})).toBeNull();
  });
});
