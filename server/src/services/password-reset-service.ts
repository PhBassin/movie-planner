import type { DB } from '../db/index.js';
import { getMemberById } from '../db/member-queries.js';
import { updateUserPassword } from '../db/user-queries.js';
import { consumeAuthEmailToken } from '../repositories/auth-email-token-repository.js';
import { revokeAllUserTokens } from '../repositories/refresh-token-repository.js';
import { hashPassword } from '../utils/password.js';
import { validatePasswordStrength } from '../utils/security.js';
import { ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { getMailer, type Mailer } from './mailer.js';
import { dispatchAuthEmail, sendAuthLinkEmail, type AuthLinkEmailSpec } from './auth-email.js';

const RESET_PATH = '/reset-password?token=';

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

const passwordResetEmailSpec: AuthLinkEmailSpec = {
  purpose: 'password_reset',
  path: RESET_PATH,
  label: 'Password reset',
  eligible: (user) => user.role_name === 'member',
  ineligibleReason: 'not_member',
  buildEmail: buildPasswordResetEmail,
};

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
    await sendAuthLinkEmail(this.db, this.mailer, email, passwordResetEmailSpec);
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
  dispatchAuthEmail('Password reset email', email, () =>
    new PasswordResetService(db).sendPasswordResetEmail(email));
}
