import { Request, Response, NextFunction } from 'express';
import type { ApiResponse } from '../types/api.js';
import { MEMBER_ONLY_ENDPOINT_MESSAGE, SUSPENDED_ACCOUNT_MESSAGE, type PermissionName } from '../types/role.js';
import { getMemberLifecycle } from '../db/user-queries.js';
import { getSecrets, verifyWithMultipleSecrets } from '../utils/jwt-secrets.js';

// Fail-fast: validate secrets at module load
getSecrets();

export interface AuthRequest extends Request {
    user?: {
        id: number;
        username: string;
        role_name: string;
        is_system_role: boolean;
        permissions: PermissionName[];
    };
}

function extractToken(req: AuthRequest): string | null {
    if (req.cookies?.access_token) {
        return req.cookies.access_token;
    }
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
    }
    return null;
}

/**
 * Check if the given user object represents a system administrator.
 *
 * A user is considered admin when:
 * - role_name === 'admin' (string comparison against the role name — prefers
 *   future migration to role ID for immutability)
 * - is_system_role === true (prevents privilege escalation by users who
 *   name their custom role 'admin')
 *
 * This is the single source of truth for admin bypass logic used by
 * requirePermission middleware and any route that performs inline
 * admin checks.
 */
export function isAdminUser(
  user: AuthRequest['user'] | null | undefined,
): boolean {
  return user?.role_name === 'admin' && user?.is_system_role === true;
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction): void | Response => {
    const token = extractToken(req);

    if (!token) {
        const response: ApiResponse = {
            success: false,
            error: 'Authentication required. No token provided.',
        };
        return res.status(401).json(response);
    }

    try {
        const decoded = verifyWithMultipleSecrets(token, getSecrets()) as {
            id: number;
            username: string;
            role_name: string;
            is_system_role: boolean;
            permissions: PermissionName[];
        };
        req.user = decoded;
        next();
    } catch (error) {
        const response: ApiResponse = {
            success: false,
            error: 'Invalid or expired token.',
        };
        return res.status(401).json(response);
    }
};

/**
 * Gate a Member-scoped route. Beyond the role claim, re-reads the lifecycle
 * row: the access JWT is stateless, so suspension (and Admin deletion) only
 * revoke refresh tokens — without this check a suspended Member would keep
 * acting until the access token expires. Both cases answer 401 so the client
 * attempts a refresh, which fails (tokens revoked), and drops the session.
 */
export const requireMember = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void | Response> => {
    if (req.user?.role_name !== 'member') {
        return res.status(403).json({
            success: false,
            error: MEMBER_ONLY_ENDPOINT_MESSAGE,
        });
    }

    try {
        const member = await getMemberLifecycle(req.app.get('db'), req.user.id);
        if (!member || member.role_name !== 'member') {
            return res.status(401).json({ success: false, error: 'Invalid or expired token.' } satisfies ApiResponse);
        }
        if (member.status === 'suspended') {
            return res.status(401).json({ success: false, error: SUSPENDED_ACCOUNT_MESSAGE } satisfies ApiResponse);
        }
    } catch (error) {
        return next(error);
    }

    next();
};
