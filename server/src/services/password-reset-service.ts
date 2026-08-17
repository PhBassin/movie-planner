import crypto from 'crypto';
import type { DB } from '../db/index.js';
import { getMemberById, getUserByEmail } from '../db/member-queries.js';
import { updateUserPassword } from '../db/user-queries.js';
import {
  consumeAuthEmailToken,
  issueAuthEmailToken,
} from '../repositories/auth-email-token-repository.js';
import { revokeAllUserTokens } from '../repositories/refresh-token-repository.js';
import { hashPassword } from '../utils/password.js';
import { validatePasswordStrength } from '../utils/security.js';
import { ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { getPublicWebOrigin } from './verification-service.js';
import { getMailer, type Mailer } from './mailer.js';

const RESET_PATH = '/reset-password?token=';

function hashEmailForLog(email: string): string {
  return crypto.createHash('sha256').update(email, 'utf8').digest('hex').slice(0, 16);
}

function buildPasswordResetEmail(resetUrl: string): { subject: string; text: string; html: string } {
  return {
    subject: 'Reset your password',
    text: [
      'A password reset was requested for your Movie Planner account.',
      '',
      'Reset your password using the link below (the link expires in 30 minutes):',
      '',
      resetUrl,
      '',
      'If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: [
      '<p>A password reset was requested for your Movie Planner account.</p>',
      '<p>Reset your password using the link below (the link expires in 30 minutes):</p>',
      `<p><a href="${resetUrl}">Reset my password</a></p>`,
      '<p>If you did not request this, you can ignore this email.</p>',
    ].join(''),
  };
}

function buildPasswordChangedEmail(): { subject: string; text: string; html: string } {
  const changedAt = new Date().toISOString();
  const message = `Your Movie Planner password was changed at ${changedAt}. If this was not you, request another password reset or contact support.`;
  return {
    subject: 'Your Movie Planner password was changed',
    text: message,
    html: `<p>${message}</p>`,
  };
}

/**
 * Member-only password recovery. The request side is intentionally safe to
 * dispatch asynchronously; the confirmation side is the only place that
 * mutates credentials and revokes Sessions.
 */
export class PasswordResetService {
  constructor(
    private readonly db: DB,
    private readonly mailer: Mailer = getMailer(),
  ) {}

  /** Issue and send a reset link, or silently no-op for non-Member emails. */
  async sendPasswordResetEmail(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const emailHash = hashEmailForLog(normalizedEmail);
    const user = await getUserByEmail(this.db, normalizedEmail);
    if (!user || user.role_name !== 'member') {
      logger.info('Password reset request ignored', {
        emailHash,
        reason: user ? 'not_member' : 'unknown_email',
      });
      return;
    }

    const rawToken = await issueAuthEmailToken(this.db, user.id, 'password_reset');
    const resetUrl = `${getPublicWebOrigin()}${RESET_PATH}${rawToken}`;
    const { subject, text, html } = buildPasswordResetEmail(resetUrl);

    try {
      await this.mailer.send({ to: user.email, subject, text, html });
      logger.info('Password reset email sent', {
        userId: user.id,
        emailHash,
      });
    } catch (error) {
      logger.error('Password reset email send failed', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Consume a reset token, update the password, revoke all Sessions, and send
   * a token-less confirmation. Returns false for an invalid or non-Member
   * token so the route can expose one generic rejection.
   */
  async confirmPasswordReset(rawToken: string, newPassword: string): Promise<boolean> {
    const passwordError = validatePasswordStrength(newPassword);
    if (passwordError) {
      throw new ValidationError(passwordError);
    }

    let memberEmail: string | null = null;
    let memberId: number | null = null;
    const reset = await this.db.transaction(async (client) => {
      const userId = await consumeAuthEmailToken(client, rawToken, 'password_reset');
      if (userId === null) {
        return false;
      }

      const member = await getMemberById(client, userId);
      if (!member) {
        return false;
      }

      const newPasswordHash = await hashPassword(newPassword);
      await updateUserPassword(client, userId, newPasswordHash);
      await revokeAllUserTokens(client, userId);
      memberEmail = member.email;
      memberId = userId;
      return true;
    });

    if (!reset || memberEmail === null) {
      return false;
    }

    try {
      const { subject, text, html } = buildPasswordChangedEmail();
      await this.mailer.send({ to: memberEmail, subject, text, html });
    } catch (error) {
      logger.error('Password reset confirmation email failed', {
        userId: memberId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info(`Password reset completed for user ${memberId}`);
    return true;
  }
}

/** Fire-and-forget reset dispatch used by the enumeration-safe request route. */
export function dispatchPasswordResetEmail(db: DB, email: string): void {
  void Promise.resolve()
    .then(() => new PasswordResetService(db).sendPasswordResetEmail(email))
    .catch((error: unknown) => {
      logger.error('Password reset email dispatch failed', {
        email,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
