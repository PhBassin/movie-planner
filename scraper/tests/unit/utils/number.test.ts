import { describe, it, expect } from 'vitest';
import { parseStrictInt } from '../../../src/utils/number.js';

describe('parseStrictInt', () => {
  it('returns NaN for empty-ish inputs', () => {
    expect(parseStrictInt(undefined)).toBeNaN();
    expect(parseStrictInt(null)).toBeNaN();
    expect(parseStrictInt('')).toBeNaN();
  });

  it('returns integer numbers unchanged', () => {
    expect(parseStrictInt(0)).toBe(0);
    expect(parseStrictInt(42)).toBe(42);
    expect(parseStrictInt(-7)).toBe(-7);
  });

  it('returns NaN for non-integer numbers', () => {
    expect(parseStrictInt(1.5)).toBeNaN();
    expect(parseStrictInt(Number.NaN)).toBeNaN();
  });

  it('parses digit strings, trimming surrounding whitespace', () => {
    expect(parseStrictInt('42')).toBe(42);
    expect(parseStrictInt('  42  ')).toBe(42);
    expect(parseStrictInt('-7')).toBe(-7);
  });

  it('returns NaN for non-numeric strings', () => {
    expect(parseStrictInt('abc')).toBeNaN();
    expect(parseStrictInt('1.5')).toBeNaN();
    expect(parseStrictInt('12px')).toBeNaN();
  });

  it('returns NaN for integers outside the safe range', () => {
    expect(parseStrictInt('9007199254740993')).toBeNaN(); // Number.MAX_SAFE_INTEGER + 2
  });
});
