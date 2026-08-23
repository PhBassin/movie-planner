import jwt from 'jsonwebtoken';
import { getUserByUsername, createUser, updateUserPassword } from '../db/user-queries.js';
import { getUserByEmail, createMember } from '../db/member-queries.js';
import { getPermissionNamesByRoleId } from '../db/role-queries.js';
import type { DB } from '../db/index.js';
import { validatePasswordStrength } from '../utils/security.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';
import { parseJwtExpiration } from '../utils/jwt-config.js';
import type { PermissionName } from '../types/role.js';
import { getCurrentSecret } from '../utils/jwt-secrets.js';
import { ValidationError, AuthError, NotFoundError, isUniqueViolation } from '../utils/errors.js';

// Pre-computed hash for 'dummy' (cost 10) to prevent timing attacks
const DUMMY_HASH = 'scrypt:16384:8:1:00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

// Longest address SMTP accepts (RFC 5321 path length) — caps parsing work.
const EMAIL_MAX_LENGTH = 254;

/**
 * Structural email check for the signup boundary: exactly one '@', non-empty
 * local part, and a domain holding a dot with non-empty labels. Implemented
 * as linear string scans (not a regex) so adversarial input cannot trigger
 * super-linear backtracking. Deliberately not full RFC 5322 — the mailbox
 * provider remains the arbiter of deliverability.
 */
function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return false;

  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex !== email.lastIndexOf('@')) return false;

  const domain = email.slice(atIndex + 1);
  const dotIndex = domain.indexOf('.');
  return dotIndex > 0 && dotIndex < domain.length - 1;
}

/**
 * Minimum user shape required to mint an access token. Both UserRow and
 * UserWithRoleRow extend this — callers pass whichever they already hold.
 */
export interface AccessTokenSubject {
  id: number;
  username: string;
  role_id: number;
  role_name: string;
  is_system_role: boolean;
}

/**
 * The public user view returned in login/refresh responses: the access-token
 * subject plus its resolved permissions. Built in one place (`toSessionUser`)
 * so every response that shows a user agrees on the shape.
 */
export interface SessionUser extends AccessTokenSubject {
  permissions: PermissionName[];
}

/**
 * The login/refresh response payload: a fresh access token and the public
 * user view. Emitted by `AuthService.login` and `SessionService.refresh`.
 */
export interface AuthResponse {
  token: string;
  user: SessionUser;
}

/** Build the canonical public user view from an access-token subject. */
export function toSessionUser(
  subject: AccessTokenSubject,
  permissions: PermissionName[],
): SessionUser {
  return {
    id: subject.id,
    username: subject.username,
    role_id: subject.role_id,
    role_name: subject.role_name,
    is_system_role: subject.is_system_role,
    permissions,
  };
}

export class AuthService {
  constructor(private db: DB) {}

  /**
   * Mint an HS256 access token for `user`. The canonical payload shape
   * ({ id, username, role_name, is_system_role, permissions }) lives here
   * — every code path that issues an access token MUST go through this
   * method so the claim set stays in lockstep.
   *
   * @param user - Subject of the token. `db` is passed explicitly so the
   *               refresh route can mint against the same DB handle it
   *               already loaded the user from, without re-deriving it
   *               from the service's constructor-injected DB.
   */
  async mintAccessToken(user: AccessTokenSubject, db: DB): Promise<string> {
    const permissions = (await getPermissionNamesByRoleId(db, user.role_id)) as PermissionName[];

    const secret = getCurrentSecret();

    const expiresIn = parseJwtExpiration(process.env.JWT_EXPIRES_IN || '1h');

    return jwt.sign(
      {
        id: user.id,
        username: user.username,
        role_name: user.role_name,
        is_system_role: user.is_system_role,
        permissions,
      },
      secret,
      { algorithm: 'HS256', expiresIn: expiresIn as any }
    );
  }

  /**
   * Authenticate by identifier + password. The identifier is a username for
   * Staff and an email for Members (see CONTEXT.md → Member); an identifier
   * containing '@' takes the email lookup path, everything else the username
   * path. Both paths return the same credential row shape.
   *
   * A `suspended` Member cannot log in (only suspension blocks login; an
   * unverified Member may still log in — see CONTEXT.md → Member lifecycle).
   * The suspension check runs only after the password has matched, so the
   * failure ordering cannot be used to enumerate accounts.
   */
  async login(identifier?: string, password?: string): Promise<AuthResponse> {
    if (!identifier || !password) {
      throw new ValidationError('Username and password are required');
    }

    const user = identifier.includes('@')
      ? await getUserByEmail(this.db, identifier)
      : await getUserByUsername(this.db, identifier);
    const hashToCompare = user ? user.password_hash : DUMMY_HASH;
    const isMatch = await comparePassword(password, hashToCompare);

    if (!user || !isMatch) {
      throw new AuthError('Invalid credentials');
    }

    if (user.role_name === 'member' && user.status === 'suspended') {
      throw new AuthError('Account suspended');
    }

    const token = await this.mintAccessToken(user, this.db);
    const permissions = (await getPermissionNamesByRoleId(
      this.db,
      user.role_id,
    )) as PermissionName[];

    return { token, user: toSessionUser(user, permissions) };
  }

  async register(username?: string, password?: string) {
    if (!username || !password) {
      throw new ValidationError('Username and password are required');
    }

    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      throw new ValidationError(passwordError);
    }

    const existingUser = await getUserByUsername(this.db, username);
    if (existingUser) {
      throw new ValidationError('Username already exists');
    }

    const passwordHash = await hashPassword(password);

    const user = await createUser(this.db, username, passwordHash);

    return {
      id: user.id,
      username: user.username,
      role_id: user.role_id,
      role_name: user.role_name,
    };
  }

  /**
   * Register a Member through the public signup route: email + password,
   * creating an `unverified` account (see CONTEXT.md → Member). No session is
   * created — the Member obtains one by logging in. Distinct from the
   * staff-only `register` above.
   */
  async registerMember(email?: string, password?: string) {
    if (!email || !password) {
      throw new ValidationError('Email and password are required');
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      throw new ValidationError('A valid email address is required');
    }

    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      throw new ValidationError(passwordError);
    }

    const existingUser = await getUserByEmail(this.db, normalizedEmail);
    if (existingUser) {
      throw new ValidationError('An account with this email already exists');
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await createMember(this.db, normalizedEmail, passwordHash);
    } catch (error: any) {
      // A concurrent signup with the same email loses the race to the unique
      // index — surface the same rejection as the check above, never a 500.
      if (isUniqueViolation(error)) {
        throw new ValidationError('An account with this email already exists');
      }
      throw error;
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role_id: user.role_id,
      role_name: user.role_name,
      status: user.status,
    };
  }

  async changePassword(currentUsername: string, currentPassword?: string, newPassword?: string) {
    if (!currentPassword || !newPassword) {
      throw new ValidationError('Current password and new password are required');
    }

    const passwordError = validatePasswordStrength(newPassword);
    if (passwordError) {
      throw new ValidationError(passwordError);
    }

    const user = await getUserByUsername(this.db, currentUsername);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const isMatch = await comparePassword(currentPassword, user.password_hash);
    if (!isMatch) {
      throw new AuthError('Current password is incorrect');
    }

    const newPasswordHash = await hashPassword(newPassword);

    await updateUserPassword(this.db, user.id, newPasswordHash);
    logger.info(`Password changed for user: ${user.username}`);
  }
}
