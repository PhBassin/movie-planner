import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../db/index.js';

vi.mock('../db/member-queries.js');
vi.mock('../db/user-queries.js');
vi.mock('../repositories/refresh-token-repository.js', () => ({
  revokeAllUserTokens: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { MemberAdminService } from './member-admin-service.js';
import * as memberQueries from '../db/member-queries.js';
import * as userQueries from '../db/user-queries.js';
import { revokeAllUserTokens } from '../repositories/refresh-token-repository.js';
import { NotFoundError } from '../utils/errors.js';

const acting = { id: 1, username: 'admin' };

const memberRow = (overrides: Partial<memberQueries.MemberAdminRow> = {}): memberQueries.MemberAdminRow => ({
  id: 7,
  username: 'member@example.com',
  email: 'member@example.com',
  role_name: 'member',
  status: 'active',
  email_verified_at: '2026-01-02T00:00:00Z',
  appearance: 'dark',
  selection_count: 5,
  submission_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const lifecycle = (status: 'unverified' | 'active' | 'suspended') => ({
  id: 7,
  role_name: 'member',
  status,
  email_verified_at: status === 'unverified' ? null : '2026-01-02T00:00:00Z',
});

describe('MemberAdminService', () => {
  let service: MemberAdminService;
  let txClient: { query: unknown };

  beforeEach(() => {
    vi.clearAllMocks();
    txClient = { query: vi.fn() };
    const db = {
      query: vi.fn(),
      transaction: vi.fn(async (fn: (client: typeof txClient) => Promise<unknown>) => fn(txClient)),
    } as unknown as DB;
    service = new MemberAdminService(db);
  });

  describe('listMembers', () => {
    it('delegates pagination to the query and returns the rows', async () => {
      const rows = [memberRow()];
      vi.mocked(memberQueries.listMembers).mockResolvedValue(rows);

      const result = await service.listMembers({ limit: 25, offset: 50 }, acting);

      expect(result).toBe(rows);
      expect(memberQueries.listMembers).toHaveBeenCalledWith(expect.anything(), { limit: 25, offset: 50 });
    });
  });

  describe('getMember', () => {
    it('returns the admin detail view', async () => {
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(memberRow());

      await expect(service.getMember(7, acting)).resolves.toMatchObject({ id: 7, role_name: 'member' });
    });

    it('throws NotFoundError for missing or Staff ids', async () => {
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(undefined);

      await expect(service.getMember(99, acting)).rejects.toThrow(NotFoundError);
    });
  });

  describe('suspendMember', () => {
    it('flips active → suspended and revokes Sessions atomically', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle('active'));
      vi.mocked(memberQueries.setMemberStatus).mockResolvedValue(true);
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(memberRow({ status: 'suspended' }));

      const result = await service.suspendMember(7, acting);

      expect(result.status).toBe('suspended');
      expect(userQueries.getMemberLifecycle).toHaveBeenCalledWith(txClient, 7, { forUpdate: true });
      expect(memberQueries.setMemberStatus).toHaveBeenCalledWith(txClient, 7, 'suspended');
      expect(revokeAllUserTokens).toHaveBeenCalledWith(txClient, 7);
    });

    it('rejects an already suspended Member', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle('suspended'));

      await expect(service.suspendMember(7, acting)).rejects.toMatchObject({
        statusCode: 409,
        message: 'Member is already suspended',
      });
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('rejects an unverified Member (reinstatement must not bypass verification)', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle('unverified'));

      await expect(service.suspendMember(7, acting)).rejects.toMatchObject({
        statusCode: 409,
        message: 'Only active members can be suspended',
      });
      expect(memberQueries.setMemberStatus).not.toHaveBeenCalled();
    });

    it('rejects a Staff id like a missing one', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue({ ...lifecycle('active'), role_name: 'operator' });

      await expect(service.suspendMember(2, acting)).rejects.toThrow(NotFoundError);
      expect(memberQueries.setMemberStatus).not.toHaveBeenCalled();
    });
  });

  describe('reinstateMember', () => {
    it('restores suspended → active without touching Sessions', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle('suspended'));
      vi.mocked(memberQueries.setMemberStatus).mockResolvedValue(true);
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(memberRow());

      const result = await service.reinstateMember(7, acting);

      expect(result.status).toBe('active');
      expect(memberQueries.setMemberStatus).toHaveBeenCalledWith(txClient, 7, 'active');
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('rejects a Member who is not suspended', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(lifecycle('active'));

      await expect(service.reinstateMember(7, acting)).rejects.toMatchObject({
        statusCode: 409,
        message: 'Member is not suspended',
      });
    });
  });

  describe('deleteMember', () => {
    it('deletes the row through the shared users delete (cascades Member data)', async () => {
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(memberRow());
      vi.mocked(userQueries.deleteUser).mockResolvedValue(true);

      await expect(service.deleteMember(7, acting)).resolves.toBeUndefined();

      expect(userQueries.deleteUser).toHaveBeenCalledWith(expect.anything(), 7);
    });

    it('throws NotFoundError when no Member row matches', async () => {
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(undefined);

      await expect(service.deleteMember(99, acting)).rejects.toThrow(NotFoundError);
      expect(userQueries.deleteUser).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the row vanishes between read and delete', async () => {
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(memberRow());
      vi.mocked(userQueries.deleteUser).mockResolvedValue(false);

      await expect(service.deleteMember(7, acting)).rejects.toThrow(NotFoundError);
    });
  });
});
