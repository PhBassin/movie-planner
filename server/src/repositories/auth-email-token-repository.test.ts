import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../db/index.js';
import {
  issueAuthEmailToken,
  consumeAuthEmailToken,
  cleanupExpiredAuthEmailTokens,
} from './auth-email-token-repository.js';
import { AUTH_TOKEN_TTL_MS } from '../services/auth-tokens.js';

describe('Auth Email Token Repository', () => {
  let mockDb: DB;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
    } as unknown as DB;
  });

  describe('issueAuthEmailToken', () => {
    it('stores only the SHA-256 hash of the raw token, never the raw value', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

      const raw = await issueAuthEmailToken(mockDb, 7, 'email_verification');

      const insertCall = vi
        .mocked(mockDb.query)
        .mock.calls.find(([sql]) => String(sql).includes('INSERT INTO auth_email_tokens'));
      expect(insertCall).toBeDefined();
      const params = insertCall![1] as unknown[];
      expect(params[0]).toBe(7);
      // The stored hash is 64 hex chars and must not equal the raw token.
      expect(params[1]).toMatch(/^[0-9a-f]{64}$/);
      expect(params[1]).not.toBe(raw);
      expect(raw.length).toBeGreaterThanOrEqual(32);
    });

    it('supersedes any prior outstanding token for the same (user, purpose)', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

      await issueAuthEmailToken(mockDb, 7, 'email_verification');

      const deleteCall = vi
        .mocked(mockDb.query)
        .mock.calls.find(([sql]) => String(sql).includes('DELETE FROM auth_email_tokens'));
      expect(deleteCall).toBeDefined();
      expect(String(deleteCall![0])).toContain('purpose');
      expect(deleteCall![1]).toEqual([7, 'email_verification']);
    });

    it('does not touch tokens of another purpose', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

      await issueAuthEmailToken(mockDb, 7, 'password_reset');

      const deleteCall = vi
        .mocked(mockDb.query)
        .mock.calls.find(([sql]) => String(sql).includes('DELETE FROM auth_email_tokens'));
      expect(deleteCall![1]).toEqual([7, 'password_reset']);
    });

    it('sets the expiry to now + AUTH_TOKEN_TTL_MS (30 minutes)', async () => {
      vi.useFakeTimers();
      try {
        const now = new Date('2026-08-14T10:00:00Z');
        vi.setSystemTime(now);
        vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

        await issueAuthEmailToken(mockDb, 7, 'email_verification');

        const insertCall = vi
          .mocked(mockDb.query)
          .mock.calls.find(([sql]) => String(sql).includes('INSERT INTO auth_email_tokens'));
        const expiresAt = (insertCall![1] as unknown[])[2] as Date;
        expect(expiresAt.getTime() - now.getTime()).toBe(AUTH_TOKEN_TTL_MS);
        expect(AUTH_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('consumeAuthEmailToken', () => {
    it('returns the user id and deletes the row for a valid, unexpired token', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({
        rows: [{ id: 42, user_id: 7 }],
        rowCount: 1,
      } as any);

      const userId = await consumeAuthEmailToken(mockDb, 'raw-token', 'email_verification');

      expect(userId).toBe(7);
      const [sql, params] = vi.mocked(mockDb.query).mock.calls[0];
      // Single-statement consume: delete returning, so a second submission
      // with the same token finds nothing (strictly single-use).
      expect(String(sql)).toContain('DELETE FROM auth_email_tokens');
      expect(String(sql)).toContain('RETURNING');
      expect((params as unknown[])[0]).toBe('email_verification');
      expect((params as unknown[])[1]).toMatch(/^[0-9a-f]{64}$/);
      expect((params as unknown[])[2]).toBeInstanceOf(Date);
    });

    it('returns null for an unknown token', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

      const userId = await consumeAuthEmailToken(mockDb, 'nope', 'email_verification');

      expect(userId).toBeNull();
    });

    it('returns null for an expired token (and removes the row)', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

      const userId = await consumeAuthEmailToken(mockDb, 'raw-token', 'email_verification');

      expect(userId).toBeNull();
      // The DELETE includes the expiry predicate so expired rows are swept
      // by the same statement that would consume them.
      expect(String(vi.mocked(mockDb.query).mock.calls[0][0])).toContain('expires_at');
    });

    it('never matches a token hash across purposes', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

      await consumeAuthEmailToken(mockDb, 'raw-token', 'password_reset');

      expect(String(vi.mocked(mockDb.query).mock.calls[0][0])).toContain('purpose = $1');
      expect(vi.mocked(mockDb.query).mock.calls[0][1]).toEqual([
        'password_reset',
        expect.any(String),
        expect.any(Date),
      ]);
    });
  });

  describe('cleanupExpiredAuthEmailTokens', () => {
    it('sweeps expired rows and returns the count', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({
        rows: [{ count: '3' }],
        rowCount: 1,
      } as any);

      const count = await cleanupExpiredAuthEmailTokens(mockDb);

      expect(count).toBe(3);
      expect(String(vi.mocked(mockDb.query).mock.calls[0][0])).toContain('expires_at <= NOW()');
    });
  });
});
