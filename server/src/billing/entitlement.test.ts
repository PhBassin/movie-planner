import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBQueryExecutor } from '../db/index.js';
import { hasPaidThroughSubscription } from '../db/subscription-queries.js';
import {
  FREE_SELECTION_QUOTA,
  getEntitlement,
  PREMIUM_SELECTION_QUOTA,
  resolveBillingMode,
  validateBillingConfiguration,
} from './entitlement.js';

vi.mock('../db/subscription-queries.js', () => ({
  hasPaidThroughSubscription: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

describe('Entitlement (ADR 0011 D1)', () => {
  const db = {} as DBQueryExecutor;

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

    it('falls back to disabled for an unknown value', () => {
      vi.stubEnv('BILLING_PROVIDER', 'stripe');
      expect(resolveBillingMode()).toBe('disabled');
    });
  });

  describe('validateBillingConfiguration', () => {
    it('accepts an unset mode', () => {
      vi.stubEnv('BILLING_PROVIDER', '');
      expect(() => validateBillingConfiguration()).not.toThrow();
    });

    it('refuses an unknown provider', () => {
      vi.stubEnv('BILLING_PROVIDER', 'stripe');
      expect(() => validateBillingConfiguration()).toThrow('BILLING_PROVIDER must be one of');
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

  describe('getEntitlement', () => {
    it('gives every Member 50 with no offer while billing is disabled, without reading Subscriptions', async () => {
      await expect(getEntitlement(db, 7, 'disabled')).resolves.toEqual({
        offer: null,
        selectionQuota: PREMIUM_SELECTION_QUOTA,
      });
      expect(hasPaidThroughSubscription).not.toHaveBeenCalled();
    });

    it('is free (3) without a paid-through Subscription', async () => {
      vi.mocked(hasPaidThroughSubscription).mockResolvedValue(false);

      await expect(getEntitlement(db, 7, 'fake')).resolves.toEqual({
        offer: 'free',
        selectionQuota: FREE_SELECTION_QUOTA,
      });
      expect(hasPaidThroughSubscription).toHaveBeenCalledWith(db, 7);
    });

    it('is premium (50) with a paid-through Subscription', async () => {
      vi.mocked(hasPaidThroughSubscription).mockResolvedValue(true);

      await expect(getEntitlement(db, 7, 'fake')).resolves.toEqual({
        offer: 'premium',
        selectionQuota: PREMIUM_SELECTION_QUOTA,
      });
    });

    it('resolves the mode from the environment by default', async () => {
      vi.stubEnv('BILLING_PROVIDER', 'fake');
      vi.mocked(hasPaidThroughSubscription).mockResolvedValue(false);

      await expect(getEntitlement(db, 7)).resolves.toEqual(expect.objectContaining({ offer: 'free' }));
    });
  });
});
