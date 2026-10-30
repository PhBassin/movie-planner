import type { DB } from '../db/index.js';
import { getMemberById, getMemberProfile, deleteMemberRow } from '../db/member-queries.js';
import { getMemberLifecycle } from '../db/user-queries.js';
import { getSelectionForExport, type SelectionExportRow } from '../db/selection-queries.js';
import { rememberedChoicesCountAsActive } from '../billing/entitlement.js';
import { getSubmissionHistoryForExport, type SubmissionExportRow } from '../db/submission-queries.js';
import type { Appearance, MemberStatus } from '../types/user.js';
import { comparePassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * The Member data export document (CONTEXT.md → Member data export): the
 * Member's own personal data, never the password hash nor internal plumbing.
 */
export interface MemberDataExport {
  exported_at: string;
  account: {
    email: string;
    status: MemberStatus;
    email_verified_at: string | null;
    created_at: string;
  };
  appearance: Appearance;
  selection: SelectionExportRow[];
  submissions: SubmissionExportRow[];
}

export const INCORRECT_PASSWORD_MESSAGE = 'Password is incorrect';

/**
 * The Member's own RGPD rights over their account (issue #66, ADR 0004):
 * erasure (Article 17) and data export (Article 20). Both act on the
 * authenticated Member only — the caller passes the Session's user id.
 *
 * The Admin-mediated counterpart (and the only path for suspended Members)
 * is `MemberAdminService.deleteMember`.
 */
export class MemberAccountService {
  constructor(private readonly db: DB) {}

  /**
   * Assemble the export document. Read-only, so the Session is the only gate.
   * The three reads share one REPEATABLE READ snapshot, so a concurrent edit
   * (or erasure) cannot mix states into the document.
   */
  async exportData(memberId: number): Promise<MemberDataExport> {
    const { profile, selection, submissions } = await this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const profile = await getMemberProfile(tx, memberId);
      if (!profile || profile.role_name !== 'member') {
        throw new NotFoundError('Member not found');
      }
      const selection = await getSelectionForExport(tx, memberId, {
        rememberedCountsAsActive: rememberedChoicesCountAsActive(),
      });
      const submissions = await getSubmissionHistoryForExport(tx, memberId);
      return { profile, selection, submissions };
    });

    logger.info('Member exported own data', { memberId });

    return {
      exported_at: new Date().toISOString(),
      account: {
        email: profile.email,
        status: profile.status,
        email_verified_at: profile.email_verified_at,
        created_at: profile.created_at,
      },
      appearance: profile.appearance,
      selection,
      submissions,
    };
  }

  /**
   * Self-erasure: immediate, hard, terminal (ADR 0004 sub-decision 1),
   * gated by password re-entry (sub-decision 5). The `users` row goes away
   * and Sessions, Selection, Appearance and TheaterSubmissions cascade;
   * Theaters the Member introduced stay in the catalog.
   *
   * The password is checked before the transaction (scrypt is slow; no lock
   * is held while hashing). The suspension check is repeated under the row
   * lock so a concurrent Admin suspension always wins: a suspended Member
   * cannot erase their submission history (sub-decision 7). The password
   * hash is re-read under that lock too: a password change or reset that
   * commits after the check (the remedy for a hijacked Session) voids it.
   *
   * The log carries the id only — erasure leaves no email behind.
   */
  async eraseSelf(memberId: number, password: unknown): Promise<void> {
    if (typeof password !== 'string' || password.length === 0) {
      throw new ValidationError('Password is required');
    }

    const member = await getMemberById(this.db, memberId);
    if (!member) {
      throw new NotFoundError('Member not found');
    }
    if (!(await comparePassword(password, member.password_hash))) {
      throw new ForbiddenError(INCORRECT_PASSWORD_MESSAGE);
    }

    await this.db.transaction(async (tx) => {
      const lifecycle = await getMemberLifecycle(tx, memberId, { forUpdate: true });
      if (!lifecycle || lifecycle.role_name !== 'member') {
        throw new NotFoundError('Member not found');
      }
      if (lifecycle.status === 'suspended') {
        throw new ForbiddenError('This account is suspended');
      }
      const locked = await getMemberById(tx, memberId);
      if (!locked || locked.password_hash !== member.password_hash) {
        throw new ForbiddenError(INCORRECT_PASSWORD_MESSAGE);
      }
      if (!(await deleteMemberRow(tx, memberId))) {
        throw new NotFoundError('Member not found');
      }
    });

    logger.info('Member erased own account', { memberId });
  }
}
