import express, { Response, NextFunction } from 'express';
import type { ApiResponse } from '../types/api.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { getMemberProfile, updateMemberAppearance } from '../db/member-queries.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors.js';
import { MAX_SELECTION_SIZE } from '../services/selection-service.js';

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
// invalid value can never reach `member_preferences`.
const APPEARANCES = ['light', 'dark'] as const;
type Appearance = (typeof APPEARANCES)[number];

function isAppearance(value: unknown): value is Appearance {
    return typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value);
}

router.put('/appearance', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        if (req.user!.role_name !== 'member') {
            throw new ForbiddenError('This endpoint is for member accounts');
        }

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
});

export default router;
