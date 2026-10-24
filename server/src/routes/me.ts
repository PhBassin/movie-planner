import express, { Response, NextFunction } from 'express';
import type { ApiResponse } from '../types/api.js';
import { requireAuth, requireMember, type AuthRequest } from '../middleware/auth.js';
import { authLimiter, protectedLimiter } from '../middleware/rate-limit.js';
import { getMemberProfile, updateMemberAppearance } from '../db/member-queries.js';
import { isAppearance } from '../types/user.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors.js';
import { MAX_SELECTION_SIZE } from '../services/selection-service.js';
import { MemberAccountService } from '../services/member-account-service.js';
import { SessionService } from '../services/session-service.js';

/**
 * `/api/me` — the authenticated Member's own profile (email, lifecycle
 * status, verification state, appearance). The seam later Member tickets
 * hang Selection counts and Appearance writes on (see CONTEXT.md → Member).
 *
 * Member-only: the payload is Member-shaped, so Staff get a 403 rather than
 * a profile that misdescribes them. Distinct from `/api/auth/me`, which only
 * validates the session and echoes the token claims.
 */
const router = express.Router();

// GET /api/me - The authenticated Member's own profile
router.get('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        if (req.user!.role_name !== 'member') {
            throw new ForbiddenError('This endpoint is for member accounts');
        }

        const profile = await getMemberProfile(req.app.get('db'), req.user!.id);
        if (!profile) {
            throw new NotFoundError('User not found');
        }

        const response: ApiResponse = {
            success: true,
            data: {
                user: {
                    id: profile.id,
                    email: profile.email,
                    username: profile.username,
                    role_name: profile.role_name,
                    status: profile.status,
                    email_verified: profile.email_verified_at !== null,
                    appearance: profile.appearance,
                    selectionCount: profile.selection_count,
                    selectionLimit: MAX_SELECTION_SIZE,
                    created_at: profile.created_at,
                },
            },
        };
        res.json(response);
    } catch (error) {
        next(error);
    }
});

// PUT /api/me/appearance - Update the Member's own Appearance (light/dark).
// The only visual control a Member owns; validated before the write so an
// invalid value can never reach `member_preferences`. Rate-limited and
// member-gated like the other Member-scoped writes (`/api/me/selection`).
router.put(
    '/appearance',
    protectedLimiter,
    requireAuth,
    requireMember,
    async (req: AuthRequest, res: Response, next: NextFunction) => {
        try {
            const { appearance } = req.body ?? {};
            if (!isAppearance(appearance)) {
                throw new ValidationError("Invalid appearance value. Use 'light' or 'dark'");
            }

            await updateMemberAppearance(req.app.get('db'), req.user!.id, appearance);

            const response: ApiResponse = {
                success: true,
                data: { id: req.user!.id, appearance },
            };
            res.json(response);
        } catch (error) {
            next(error);
        }
    }
);

// GET /api/me/export - The Member's own data as one JSON document (RGPD
// Article 20, ADR 0004). Non-destructive: the Session is the only gate.
router.get(
    '/export',
    protectedLimiter,
    requireAuth,
    requireMember,
    async (req: AuthRequest, res: Response, next: NextFunction) => {
        try {
            const data = await new MemberAccountService(req.app.get('db')).exportData(req.user!.id);
            res.set('Cache-Control', 'no-store');
            res.json({ success: true, data } satisfies ApiResponse);
        } catch (error) {
            next(error);
        }
    }
);

// POST /api/me/delete - Member self-erasure (RGPD Article 17, ADR 0004):
// immediate and irreversible, gated by password re-entry. Rides the auth
// limiter like the other password-checking routes. Suspended Members never
// reach it (requireMember) — their erasure is Admin-mediated.
router.post(
    '/delete',
    authLimiter,
    requireAuth,
    requireMember,
    async (req: AuthRequest, res: Response, next: NextFunction) => {
        try {
            const password = (req.body as { password?: unknown } | undefined)?.password;
            await new SessionService(req.app.get('db'), res).eraseMemberAccount(req.user!.id, password);
        } catch (error) {
            next(error);
        }
    }
);

export default router;
