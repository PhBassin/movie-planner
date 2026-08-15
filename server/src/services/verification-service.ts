import type { DB } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { getUserByEmail } from '../db/member-queries.js';
import { getAllowedOrigins } from '../utils/cors-config.js';
import {
  issueAuthEmailToken,
  consumeAuthEmailToken,
} from '../repositories/auth-email-token-repository.js';
import { getMailer, type Mailer } from './mailer.js';

/**
 * Email verification — the Member lifecycle transition `unverified → active`
 * (CONTEXT.md → Member). The mailer is the transport seam (SMTP in
 * production, in-memory in tests); tokens come from the auth-email-token
 * repository (hashed, single-use, superseding, 30-minute lifetime).
 *
 * The request paths (signup, resend) are enumeration-safe: they never reveal
 * whether an email belongs to a Member, and every failure in the best-effort
 * send path is logged and swallowed so account creation never 500s on a
 * mailer hiccup.
 */

const VERIFY_PATH = '/verify?token=';

/**
 * The public origin used to build absolute verification links in emails.
 * Defaults to the first ALLOWED_ORIGINS entry (the canonical web origin),
 * parsed by the same helper the CORS middleware uses.
 */
export function getPublicWebOrigin(): string {
  if (process.env.PUBLIC_WEB_ORIGIN) {
    return process.env.PUBLIC_WEB_ORIGIN.replace(/\/$/, '');
  }
  return getAllowedOrigins()[0].replace(/\/$/, '');
}

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

export class VerificationService {
  constructor(
    private db: DB,
    private mailer: Mailer = getMailer(),
  ) {}

  /**
   * Issue a fresh verification token for `email` and send the link. No-op
   * when the email does not belong to a Member or the Member is already
   * verified — the caller's response must not depend on which case fired
   * (enumeration safety).
   */
  async sendVerificationEmail(email: string): Promise<void> {
    const user = await getUserByEmail(this.db, email.trim().toLowerCase());
    if (!user || user.role_name !== 'member' || user.email_verified_at !== null) {
      return;
    }

    const rawToken = await issueAuthEmailToken(this.db, user.id, 'email_verification');
    const verifyUrl = `${getPublicWebOrigin()}${VERIFY_PATH}${rawToken}`;
    const { subject, text, html } = buildVerificationEmail(verifyUrl);

    try {
      await this.mailer.send({ to: user.email, subject, text, html });
    } catch (error) {
      logger.error('Verification email send failed', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
 * response latency because the send happens after the response. Rejections
 * on this path are infrastructure failures (token store, mailer); they are
 * logged with context, never surfaced to the caller.
 */
export function dispatchVerificationEmail(db: DB, email: string): void {
  void new VerificationService(db)
    .sendVerificationEmail(email)
    .catch((error: unknown) => {
      logger.error('Verification email dispatch failed', {
        email,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
