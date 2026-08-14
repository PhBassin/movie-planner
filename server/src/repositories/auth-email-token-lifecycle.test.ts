import { describe, it, expect, vi } from 'vitest';
import type { DB } from '../db/index.js';
import {
  issueAuthEmailToken,
  consumeAuthEmailToken,
} from './auth-email-token-repository.js';
import { VerificationService } from '../services/verification-service.js';
import type { Mailer } from '../services/mailer.js';

/**
 * End-to-end token lifecycle through the real service + repository against an
 * in-memory SQL double: issue → (expire) → consume → verify. Complements the
 * mocked route tests — here the token plumbing itself (hashing, expiry,
 * single-use, supersession) is what is under test.
 */

/** Minimal in-memory SQL double for the auth_email_tokens statements. */
function makeTokenDb() {
  const store = new Map<string, { hash: string; expiresAt: Date }>();

  const db = {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.includes('DELETE FROM auth_email_tokens') && sql.includes('RETURNING')) {
        const [purpose, hash, now] = params as [string, string, Date];
        const row = store.get(purpose);
        if (!row || row.hash !== hash || row.expiresAt <= now) {
          return { rows: [], rowCount: 0 };
        }
        store.delete(purpose);
        return { rows: [{ id: 1, user_id: 7 }], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM auth_email_tokens')) {
        store.delete((params as [number, string])[1]);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO auth_email_tokens')) {
        const [, hash, expiresAt, purpose] = params as [number, string, Date, string];
        store.set(purpose, { hash, expiresAt });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE users')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as DB;

  return { db, store };
}

const noopMailer: Mailer = { send: async () => {} };

describe('Auth email token lifecycle (real service + repository)', () => {
  it('an issued token verifies the Member, and is strictly single-use', async () => {
    const { db } = makeTokenDb();

    const raw = await issueAuthEmailToken(db, 7, 'email_verification');
    const service = new VerificationService(db, noopMailer);

    expect(await service.verifyEmail(raw)).toBe(true);
    // Second consume: the row was deleted — same token resolves to rejection.
    expect(await service.verifyEmail(raw)).toBe(false);
  });

  it('a token past the 30-minute lifetime is rejected', async () => {
    const { db } = makeTokenDb();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-14T10:00:00Z'));
      const raw = await issueAuthEmailToken(db, 7, 'email_verification');

      // 31 minutes later — past the shared AUTH_TOKEN_TTL_MS.
      vi.setSystemTime(new Date('2026-08-14T10:31:00Z'));
      const service = new VerificationService(db, noopMailer);

      expect(await service.verifyEmail(raw)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a resend supersedes the outstanding token', async () => {
    const { db } = makeTokenDb();

    const first = await issueAuthEmailToken(db, 7, 'email_verification');
    const second = await issueAuthEmailToken(db, 7, 'email_verification');

    const service = new VerificationService(db, noopMailer);
    expect(await service.verifyEmail(first)).toBe(false); // superseded
    expect(await service.verifyEmail(second)).toBe(true); // fresh one works
  });
});
