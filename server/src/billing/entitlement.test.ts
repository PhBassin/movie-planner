import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../utils/logger.js';
import {
  entitlementFor,
  FREE_SELECTION_QUOTA,
  PREMIUM_SELECTION_QUOTA,
  rememberedChoicesCountAsActive,
  resolveBillingMode,
  validateBillingConfiguration,
} from './entitlement.js';

vi.mock('../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

describe('Entitlement (ADR 0011 D1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('resolveBillingMode', () => {
    it('defaults to disabled', () => {
      vi.stubEnv('BILLING_PROVIDER', '');
      expect(resolveBillingMode()).toBe('disabled');
    });

    it('reads fake', () => {
      vi.stubEnv('BILLING_PROVIDER', ' fake ');
      expect(resolveBillingMode()).toBe('fake');
    });

    it('throws for an unknown value instead of silently disabling billing', () => {
      vi.stubEnv('BILLING_PROVIDER', 'fakee');
      expect(() => resolveBillingMode()).toThrow('BILLING_PROVIDER must be one of');
    });
  });

  describe('validateBillingConfiguration', () => {
    it('accepts an unset mode', () => {
      vi.stubEnv('BILLING_PROVIDER', '');
      expect(() => validateBillingConfiguration()).not.toThrow();
    });

    it('refuses an unknown provider without logging the raw environment value', () => {
      vi.stubEnv('BILLING_PROVIDER', 'stripe');
      expect(() => validateBillingConfiguration()).toThrow('BILLING_PROVIDER must be one of');
      expect(logger.error).toHaveBeenCalledWith(expect.not.stringContaining('stripe'));
    });

    it('refuses the fake adapter in production', () => {
      vi.stubEnv('BILLING_PROVIDER', 'fake');
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => validateBillingConfiguration()).toThrow('refused in production');
    });

    it('accepts the fake adapter outside production', () => {
      vi.stubEnv('BILLING_PROVIDER', 'fake');
      vi.stubEnv('NODE_ENV', 'development');
      expect(() => validateBillingConfiguration()).not.toThrow();
    });
  });

  describe('entitlementFor', () => {
    it('gives every Member 50 with no offer while billing is disabled, whatever the Subscription', () => {
      expect(entitlementFor('disabled', false)).toEqual({ offer: null, selectionQuota: PREMIUM_SELECTION_QUOTA });
      expect(entitlementFor('disabled', true)).toEqual({ offer: null, selectionQuota: PREMIUM_SELECTION_QUOTA });
    });

    it('is free (3) without a paid-through Subscription', () => {
      expect(entitlementFor('fake', false)).toEqual({ offer: 'free', selectionQuota: FREE_SELECTION_QUOTA });
    });

    it('is premium (50) with a paid-through Subscription', () => {
      expect(entitlementFor('fake', true)).toEqual({ offer: 'premium', selectionQuota: PREMIUM_SELECTION_QUOTA });
    });
  });

  describe('rememberedChoicesCountAsActive', () => {
    it('is true only while billing is disabled (D6)', () => {
      expect(rememberedChoicesCountAsActive('disabled')).toBe(true);
      expect(rememberedChoicesCountAsActive('fake')).toBe(false);
    });

    it('resolves the mode from the environment by default', () => {
      vi.stubEnv('BILLING_PROVIDER', 'fake');
      expect(rememberedChoicesCountAsActive()).toBe(false);
    });
  });
});
