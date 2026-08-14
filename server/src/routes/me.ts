import express, { Response, NextFunction } from 'express';
import type { ApiResponse } from '../types/api.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { getMemberProfile } from '../db/member-queries.js';
import { NotFoundError, ForbiddenError } from '../utils/errors.js';

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
                    created_at: profile.created_at,
                },
            },
        };
        res.json(response);
    } catch (error) {
        next(error);
    }
});

export default router;
