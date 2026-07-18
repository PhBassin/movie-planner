import { describe, it, expect } from 'vitest';
import {
  isAllocineUrl,
  validateName,
  validateUrl,
  validateAddress,
  validatePostalCode,
  validateCity,
} from './theaterValidators.js';

describe('isAllocineUrl', () => {
  it('returns true for allocine URLs', () => {
    expect(isAllocineUrl('https://www.allocine.fr/seance/')).toBe(true);
  });

  it('returns false for other hosts', () => {
    expect(isAllocineUrl('https://example.com/')).toBe(false);
    expect(isAllocineUrl('http://www.allocine.fr/')).toBe(false);
  });
});

describe('validateName', () => {
  it('rejects empty', () => {
    expect(validateName('')).toBe('Name is required');
    expect(validateName('   ')).toBe('Name is required');
  });

  it('rejects too long', () => {
    expect(validateName('a'.repeat(101))).toBe('Name must be at most 100 characters');
  });

  it('accepts valid', () => {
    expect(validateName('Cinéma A')).toBeUndefined();
  });
});

describe('validateUrl', () => {
  it('allows empty (optional)', () => {
    expect(validateUrl('')).toBeUndefined();
  });

  it('rejects non-allocine URL', () => {
    expect(validateUrl('https://example.com/')).toMatch(/Allocine/);
  });

  it('rejects too long URL', () => {
    const long = 'https://www.allocine.fr/' + 'a'.repeat(2100);
    expect(validateUrl(long)).toBe('URL must be at most 2048 characters');
  });

  it('accepts allocine URL', () => {
    expect(validateUrl('https://www.allocine.fr/seance/salle_gen_csalle=W7504.html')).toBeUndefined();
  });
});

describe('validateAddress', () => {
  it('allows empty', () => {
    expect(validateAddress('')).toBeUndefined();
  });

  it('rejects too long', () => {
    expect(validateAddress('a'.repeat(201))).toBe('Address must be at most 200 characters');
  });
});

describe('validatePostalCode', () => {
  it('allows empty', () => {
    expect(validatePostalCode('')).toBeUndefined();
  });

  it('rejects too long', () => {
    expect(validatePostalCode('a'.repeat(11))).toBe('Postal code must be at most 10 characters');
  });

  it('rejects non-alphanumeric', () => {
    expect(validatePostalCode('75001-')).toBe('Postal code must be alphanumeric');
  });

  it('accepts valid', () => {
    expect(validatePostalCode('75001')).toBeUndefined();
  });
});

describe('validateCity', () => {
  it('allows empty', () => {
    expect(validateCity('')).toBeUndefined();
  });

  it('rejects too long', () => {
    expect(validateCity('a'.repeat(101))).toBe('City must be at most 100 characters');
  });
});
