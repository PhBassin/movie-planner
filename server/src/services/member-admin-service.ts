import type { DB } from '../db/index.js';
import type { MemberAdminRow } from '../db/member-queries.js';
import {
  listMembers as dbListMembers,
  getMemberAdminDetail,
  setMemberStatus,
} from '../db/member-queries.js';
import { getMemberLifecycle, deleteUser as dbDeleteUser } from '../db/user-queries.js';
import { revokeAllUserTokens } from '../repositories/refresh-token-repository.js';
import { logger } from '../utils/logger.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import type { ActingUser } from './user-service.js';

/**
 * The Staff surface over the Member base (issue #65, stories 30–34).
 *
 * Lifecycle rules (see CONTEXT.md → Member):
 * - `suspend` is the reactive abuse control: it flips `active → suspended`
 *   and revokes every Session in the same transaction (the same revocation
 *   mechanism as a password change — `revokeAllUserTokens`).
 * - `reinstate` is the exact inverse: `suspended → active`, Member-owned
 *   data untouched (it was never removed).
 * - `delete` is the Admin-mediated erasure path: the row goes away and
 *   Member-owned data cascades; Theaters the Member introduced are NOT
 *   Member-owned and stay in the single-source catalog (ADR 0004).
 *
 * Deliberately out of scope: any subscription semantics. #95 adds a paid
 * entitlement without a new lifecycle state; #102 extends suspension for
 * paid Members after the #96 owner decisions.
 */
export class MemberAdminService {
  constructor(private readonly db: DB) {}

  /** List Members (newest first). Audit-logged like every admin read. */
  async listMembers(options: { limit: number; offset: number }, acting: ActingUser): Promise<MemberAdminRow[]> {
    const members = await dbListMembers(this.db, options);
    logger.info('Admin listed members', {
      adminId: acting.id,
      adminUsername: acting.username,
      count: members.length,
      limit: options.limit,
      offset: options.offset,
    });
    return members;
  }

  /** Fetch one Member. Staff ids and missing ids are indistinguishable (404). */
  async getMember(memberId: number, acting: ActingUser): Promise<MemberAdminRow> {
    const member = await this.requireMember(memberId);
    logger.info('Admin retrieved member details', {
      adminId: acting.id,
      adminUsername: acting.username,
      memberId,
      memberEmail: member.email,
    });
    return member;
  }

  /**
   * Suspend a Member: block login and revoke all Sessions at once.
   *
   * The status flip and the Session revocation share one transaction over a
   * locked lifecycle row, so a suspended Member can never keep a live
   * refresh token (the password-change mechanism, reused — see
   * `PasswordResetService.confirmPasswordReset`).
   *
   * Only `active` Members can be suspended: reinstatement restores `active`
   * (CONTEXT.md: `suspended ↔ active` reversible), and suspending an
   * `unverified` Member would let reinstatement bypass email verification.
   */
  async suspendMember(memberId: number, acting: ActingUser): Promise<MemberAdminRow> {
    await this.db.transaction(async (tx) => {
      const member = await getMemberLifecycle(tx, memberId, { forUpdate: true });
      if (!member || member.role_name !== 'member') {
        throw new NotFoundError('Member not found');
      }
      if (member.status === 'suspended') {
        throw new AppError('Member is already suspended', 409);
      }
      if (member.status !== 'active') {
        throw new AppError('Only active members can be suspended', 409);
      }
      await setMemberStatus(tx, memberId, 'suspended');
      await revokeAllUserTokens(tx, memberId);
    });

    logger.info('Admin suspended member', {
      adminId: acting.id,
      adminUsername: acting.username,
      memberId,
    });

    return this.requireMember(memberId);
  }

  /**
   * Reinstate a suspended Member: back to `active` with Selection,
   * Appearance and submission history intact (nothing was removed).
   * Refresh tokens revoked at suspension time stay revoked — the Member
   * simply logs in again.
   */
  async reinstateMember(memberId: number, acting: ActingUser): Promise<MemberAdminRow> {
    await this.db.transaction(async (tx) => {
      const member = await getMemberLifecycle(tx, memberId, { forUpdate: true });
      if (!member || member.role_name !== 'member') {
        throw new NotFoundError('Member not found');
      }
      if (member.status !== 'suspended') {
        throw new AppError('Member is not suspended', 409);
      }
      await setMemberStatus(tx, memberId, 'active');
    });

    logger.info('Admin reinstated member', {
      adminId: acting.id,
      adminUsername: acting.username,
      memberId,
    });

    return this.requireMember(memberId);
  }

  /**
   * Delete a Member (the Admin-mediated erasure path, ADR 0004). The
   * `users` row goes away; refresh tokens, email tokens, Selection,
   * Appearance and TheaterSubmissions cascade at the database level.
   * Theaters the Member introduced are NOT Member-owned and remain in the
   * catalog.
   *
   * The UserService guards are satisfied by construction here: the
   * member-scoped lookup 404s before any write for Staff targets (so no
   * last-admin or self-delete case can reach the delete), and a suspended
   * Member is exactly the case self-service erasure delegates to Admin.
   */
  async deleteMember(memberId: number, acting: ActingUser): Promise<void> {
    const member = await this.requireMember(memberId);

    const deleted = await dbDeleteUser(this.db, memberId);
    if (!deleted) {
      throw new NotFoundError('Member not found');
    }

    logger.info('Admin deleted member', {
      adminId: acting.id,
      adminUsername: acting.username,
      deletedMemberId: memberId,
      deletedMemberEmail: member.email,
      deletedSelectionCount: member.selection_count,
      deletedSubmissionCount: member.submission_count,
    });
  }

  /** Fetch a Member or throw the shared 404 used for missing and Staff ids. */
  private async requireMember(memberId: number): Promise<MemberAdminRow> {
    const member = await getMemberAdminDetail(this.db, memberId);
    if (!member) {
      throw new NotFoundError('Member not found');
    }
    return member;
  }
}
