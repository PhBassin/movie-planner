import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './errors.js';

describe('isUniqueViolation', () => {
  it('matches a pg error carrying the 23505 SQLSTATE code', () => {
    const error = Object.assign(new Error('violates unique constraint'), { code: '23505' });
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('matches a message-only duplicate-key error (code lost by re-wrapping)', () => {
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint'))).toBe(true);
  });

  it('rejects unrelated errors, non-errors, and falsy values', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation('duplicate key')).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('rejects a non-string message without throwing', () => {
    expect(isUniqueViolation({ code: '42P01', message: 42 })).toBe(false);
  });
});
