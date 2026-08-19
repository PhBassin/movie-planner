import type { DB } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { isPendingVerification } from '../db/member-queries.js';
import { consumeAuthEmailToken } from '../repositories/auth-email-token-repository.js';
import { getMailer, type Mailer } from './mailer.js';
import { dispatchAuthEmail, sendAuthLinkEmail, type AuthLinkEmailSpec } from './auth-email.js';

/**
 * Email verification — the Member lifecycle transition `unverified → active`
 * (CONTEXT.md → Member). The mailer is the transport seam (SMTP in
 * production, in-memory in tests); tokens come from the auth-email-token
 * repository (hashed, single-use, superseding, 30-minute lifetime).
 *
 * The request paths (signup, resend) are enumeration-safe: they never reveal
 * whether an email belongs to a Member, and every failure in the best-effort
 * send path is logged and swallowed so account creation never 500s on a
 * mailer hiccup. The send/dispatch shape itself lives in the shared
 * auth-email pipeline (`./auth-email.js`).
 */

const VERIFY_PATH = '/verify?token=';

/** Build the email copy for a verification link. Kept plain and text-first. */
function buildVerificationEmail(verifyUrl: string): { subject: string; text: string; html: string } {
  return {
    subject: 'Confirm your email address',
    text: [
      'Welcome to Movie Planner!',
      '',
      'Confirm your email address to activate your account (the link expires in 30 minutes):',
      '',
      verifyUrl,
      '',
      'If you did not create an account, you can ignore this email.',
    ].join('\n'),
    html: [
      '<p>Welcome to Movie Planner!</p>',
      '<p>Confirm your email address to activate your account (the link expires in 30 minutes):</p>',
      `<p><a href="${verifyUrl}">Confirm my email address</a></p>`,
      '<p>If you did not create an account, you can ignore this email.</p>',
    ].join(''),
  };
}

const verificationLinkSpec: AuthLinkEmailSpec = {
  purpose: 'email_verification',
  path: VERIFY_PATH,
  label: 'Verification',
  // Only a Member still awaiting verification gets a (re)sent link.
  eligible: isPendingVerification,
  ineligibleReason: 'not_pending_verification',
  buildEmail: buildVerificationEmail,
};

export class VerificationService {
  constructor(
    private db: DB,
    private mailer: Mailer = getMailer(),
  ) {}

  /**
   * Issue a fresh verification token for `email` and send the link. No-op
   * when the email does not belong to a pending-verification Member — the
   * caller's response must not depend on which case fired (enumeration
   * safety).
   */
  async sendVerificationEmail(email: string): Promise<void> {
    await sendAuthLinkEmail(this.db, this.mailer, email, verificationLinkSpec);
  }

  /**
   * Consume a verification token. On a valid, unexpired token the Member is
   * marked verified (`email_verified_at`) and transitions to `active`
   * (a suspended Member stays suspended). Returns false for an unknown or
   * expired token.
   */
  async verifyEmail(rawToken: string): Promise<boolean> {
    if (!rawToken) {
      return false;
    }

    const userId = await consumeAuthEmailToken(this.db, rawToken, 'email_verification');
    if (userId === null) {
      return false;
    }

    await this.db.query(
      `UPDATE users
       SET email_verified_at = NOW(),
           status = CASE WHEN status = 'unverified' THEN 'active' ELSE status END
       WHERE id = $1`,
      [userId],
    );
    logger.info(`Email verified for user ${userId}`);
    return true;
  }
}

/**
 * Fire-and-forget dispatch of a verification email. Both public entry points
 * (signup, resend) use it so that neither response ever waits on — or fails
 * on — the send path. For resend this is also the ADR 0006 (sub-decision 6)
 * timing-oracle closure: the no-match path (one lookup) and the
 * match-and-send path (lookup + token write + SMTP) produce the same
 * response latency because the send happens after the response.
 */
export function dispatchVerificationEmail(db: DB, email: string): void {
  dispatchAuthEmail('Verification email', email, () =>
    new VerificationService(db).sendVerificationEmail(email));
}
