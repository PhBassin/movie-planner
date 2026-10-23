import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../db/index.js';

vi.mock('../db/member-queries.js');
vi.mock('../db/user-queries.js');
vi.mock('../db/selection-queries.js');
vi.mock('../db/submission-queries.js');
vi.mock('../utils/password.js');
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { MemberAccountService, INCORRECT_PASSWORD_MESSAGE } from './member-account-service.js';
import * as memberQueries from '../db/member-queries.js';
import * as userQueries from '../db/user-queries.js';
import * as selectionQueries from '../db/selection-queries.js';
import * as submissionQueries from '../db/submission-queries.js';
import { comparePassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';

const credentialRow = (status: 'unverified' | 'active' | 'suspended' = 'active'): memberQueries.MemberCredentialRow => ({
  id: 7,
  username: 'jane@example.com',
  email: 'jane@example.com',
  password_hash: 'scrypt:hash',
  role_id: 3,
  role_name: 'member',
  is_system_role: true,
  status,
  email_verified_at: '2026-01-02T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
});

const lifecycle = (status: 'unverified' | 'active' | 'suspended', role_name = 'member') => ({
  id: 7,
  role_name,
  status,
  email_verified_at: null,
});

describe('MemberAccountService', () => {
  let service: MemberAccountService;
  let db: DB;
  let txClient: { query: unknown };

  beforeEach(() => {
    vi.clearAllMocks();
    txClient = { query: vi.fn() };
    db = {
      query: vi.fn(),
      transaction: vi.fn(async (fn: (client: typeof txClient) => Promise<unknown>) => fn(txClient)),
    } as unknown as DB;
    service = new MemberAccountService(db);
  });

  describe('exportData', () => {
    it('assembles account, Appearance, Selection and submission history — no credentials', async () => {
      vi.mocked(memberQueries.getMemberProfile).mockResolvedValue({
        id: 7,
        email: 'jane@example.com',
        username: 'jane@example.com',
        role_name: 'member',
        status: 'active',
        email_verified_at: '2026-01-02T00:00:00Z',
        appearance: 'dark',
        selection_count: 1,
        created_at: '2026-01-01T00:00:00Z',
      });
      const selection = [{ theater_id: 'C0013', name: 'UGC', city: 'Paris', url: null, status: 'active' as const }];
      const submissions = [{
        id: 3, url: 'https://example.com/salle', theater_id: 'C0099', status: 'succeeded' as const,
        created_at: '2026-01-03T00:00:00Z', resolved_at: '2026-01-03T00:05:00Z',
      }];
      vi.mocked(selectionQueries.getSelectionForExport).mockResolvedValue(selection);
      vi.mocked(submissionQueries.getSubmissionHistoryForExport).mockResolvedValue(submissions);

      const result = await service.exportData(7);

      expect(result).toEqual({
        exported_at: expect.any(String),
        account: {
          email: 'jane@example.com',
          status: 'active',
          email_verified_at: '2026-01-02T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
        appearance: 'dark',
        selection,
        submissions,
      });
      expect(JSON.stringify(result)).not.toMatch(/password|hash/i);
      // One read-only snapshot for the whole document.
      expect(txClient.query).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      expect(memberQueries.getMemberProfile).toHaveBeenCalledWith(txClient, 7);
      expect(selectionQueries.getSelectionForExport).toHaveBeenCalledWith(txClient, 7);
      expect(submissionQueries.getSubmissionHistoryForExport).toHaveBeenCalledWith(txClient, 7);
    });

    it('404s when the profile is missing or not a Member, before reading the rest', async () => {
      vi.mocked(memberQueries.getMemberProfile).mockResolvedValue(undefined);

      await expect(service.exportData(7)).rejects.toMatchObject({ statusCode: 404 });
      expect(selectionQueries.getSelectionForExport).not.toHaveBeenCalled();
      expect(submissionQueries.getSubmissionHistoryForExport).not.toHaveBeenCalled();
    });
  });

  describe('eraseSelf', () => {
    it.each([undefined, '', 42])('rejects a missing or non-string password (%s) before any read', async (password) => {
      await expect(service.eraseSelf(7, password)).rejects.toMatchObject({
        name: 'ValidationError',
        message: 'Password is required',
      });
      expect(memberQueries.getMemberById).not.toHaveBeenCalled();
      expect(memberQueries.deleteMemberRow).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with 403 and deletes nothing', async () => {
      vi.mocked(memberQueries.getMemberById).mockResolvedValue(credentialRow());
      vi.mocked(comparePassword).mockResolvedValue(false);

      await expect(service.eraseSelf(7, 'wrong')).rejects.toMatchObject({
        statusCode: 403,
        message: 'Password is incorrect',
      });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(memberQueries.deleteMemberRow).not.toHaveBeenCalled();
    });

    it('404s when the Member is gone', async () => {
      vi.mocked(memberQueries.getMemberById).mockResolvedValue(undefined);

      await expect(service.eraseSelf(7, 'pw')).rejects.toMatchObject({ statusCode: 404 });
      expect(comparePassword).not.toHaveBeenCalled();
    });

    it.each(['active', 'unverified'] as const)('erases an %s Member under the row lock with the right password', async (status) => {
      vi.mocked(memberQueries.getMemberById).mockResolvedValue(credentialRow(status));
      vi.mocked(comparePassword).mockResolvedValue(true);
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle(status));
      vi.mocked(memberQueries.deleteMemberRow).mockResolvedValue(true);

      await service.eraseSelf(7, 'Str0ng!Pass');

      expect(comparePassword).toHaveBeenCalledWith('Str0ng!Pass', 'scrypt:hash');
      expect(userQueries.getMemberLifecycle).toHaveBeenCalledWith(txClient, 7, { forUpdate: true });
      expect(memberQueries.getMemberById).toHaveBeenCalledWith(txClient, 7);
      expect(memberQueries.deleteMemberRow).toHaveBeenCalledWith(txClient, 7);
      // Erasure leaves no email behind, logs included.
      expect(logger.info).toHaveBeenCalledWith('Member erased own account', { memberId: 7 });
    });

    it('refuses when the Member was suspended concurrently (checked under the lock)', async () => {
      vi.mocked(memberQueries.getMemberById).mockResolvedValue(credentialRow('active'));
      vi.mocked(comparePassword).mockResolvedValue(true);
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle('suspended'));

      await expect(service.eraseSelf(7, 'pw')).rejects.toMatchObject({ statusCode: 403 });
      expect(memberQueries.deleteMemberRow).not.toHaveBeenCalled();
    });

    it('refuses when the password changed between the check and the lock', async () => {
      vi.mocked(memberQueries.getMemberById)
        .mockResolvedValueOnce(credentialRow())
        .mockResolvedValueOnce({ ...credentialRow(), password_hash: 'scrypt:new-hash' });
      vi.mocked(comparePassword).mockResolvedValue(true);
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle('active'));

      await expect(service.eraseSelf(7, 'old-pw')).rejects.toMatchObject({
        statusCode: 403,
        message: INCORRECT_PASSWORD_MESSAGE,
      });
      expect(memberQueries.deleteMemberRow).not.toHaveBeenCalled();
    });

    it('refuses when the row stopped being a Member under the lock', async () => {
      vi.mocked(memberQueries.getMemberById).mockResolvedValue(credentialRow());
      vi.mocked(comparePassword).mockResolvedValue(true);
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle('active', 'operator'));

      await expect(service.eraseSelf(7, 'pw')).rejects.toMatchObject({ statusCode: 404 });
      expect(memberQueries.deleteMemberRow).not.toHaveBeenCalled();
    });

    it('404s when the role-guarded DELETE removes nothing', async () => {
      vi.mocked(memberQueries.getMemberById).mockResolvedValue(credentialRow());
      vi.mocked(comparePassword).mockResolvedValue(true);
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle('active'));
      vi.mocked(memberQueries.deleteMemberRow).mockResolvedValue(false);

      await expect(service.eraseSelf(7, 'pw')).rejects.toMatchObject({ statusCode: 404 });
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
