import express, { Request, Response, NextFunction } from 'express';
import type { ApiResponse } from '../types/api.js';
import { authLimiter, registerLimiter, verificationLimiter } from '../middleware/rate-limit.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import { SessionService } from '../services/session-service.js';
import { AuthService } from '../services/auth-service.js';
import { VerificationService, dispatchVerificationEmail } from '../services/verification-service.js';
import { ValidationError } from '../utils/errors.js';

const router = express.Router();

// POST /api/auth/login - Login user
router.post('/login', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const session = new SessionService(req.app.get('db'), res);
        await session.login(req.body.username, req.body.password);
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/signup - Public Member self-registration (email + password).
// Creates an unverified Member; no session is issued — the Member logs in.
// A verification email is dispatched fire-and-forget (best-effort; failures
// never fail the signup). Distinct from the staff-only /register below
// (see CONTEXT.md → Member).
router.post('/signup', registerLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const auth = new AuthService(req.app.get('db'));
        const user = await auth.registerMember(req.body.email, req.body.password);
        res.status(201).json({
            success: true,
            data: { message: 'Account created successfully', user },
        } satisfies ApiResponse);
        // Fire-and-forget after the response: the Member can resend from the
        // UI if the mail never arrives, and a mailer hiccup must not surface
        // as a failed registration.
        dispatchVerificationEmail(req.app.get('db'), req.body.email);
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/verify-email - Link target of the verification email.
// Consumes the token (single-use) and flips the Member unverified → active.
// Public: the link is opened unauthenticated from the Member's mailbox.
router.post('/verify-email', verificationLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = req.body?.token;
        if (typeof token !== 'string' || token.length === 0) {
            throw new ValidationError('A verification token is required');
        }

        const verified = await new VerificationService(req.app.get('db')).verifyEmail(token);
        if (!verified) {
            throw new ValidationError('This verification link is invalid or has expired');
        }

        res.json({
            success: true,
            data: { message: 'Email address verified' },
        } satisfies ApiResponse);
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/resend-verification - Issue a fresh verification token.
// Public and enumeration-safe: always 200 with the same body, and the send
// is dispatched fire-and-forget so the response latency cannot reveal
// whether the email matched a Member (ADR 0006, sub-decision 6 — the
// no-match and match-and-send paths must be timing-indistinguishable).
// Rate-limited on its own verification bucket so resends cannot be starved
// by signup volume.
router.post('/resend-verification', verificationLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const email = req.body?.email;
        if (typeof email === 'string' && email.length > 0) {
            dispatchVerificationEmail(req.app.get('db'), email);
        }

        res.json({
            success: true,
            data: {
                message: 'If an unverified account exists for this email, a verification link is on its way.',
            },
        } satisfies ApiResponse);
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/register - Register a new user (requires users:create permission)
router.post('/register', registerLimiter, requireAuth, requirePermission('users:create'), async (req: Request, res: Response, next: NextFunction) => {
    try {
        const session = new SessionService(req.app.get('db'), res);
        const user = await session.register(req.body.username, req.body.password);
        const response: ApiResponse = {
            success: true,
            data: { message: 'User registered successfully', user },
        };
        res.status(201).json(response);
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/change-password - Change user password (protected)
router.post('/change-password', authLimiter, requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const session = new SessionService(req.app.get('db'), res);
        await session.changePassword(
            req.user!.id,
            req.user!.username,
            req.body.currentPassword,
            req.body.newPassword,
        );
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/refresh - Refresh access token using refresh token cookie
router.post('/refresh', authLimiter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const session = new SessionService(req.app.get('db'), res);
        await session.refresh(req.cookies?.refresh_token);
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/logout - Logout and revoke refresh token
router.post('/logout', async (req: Request, res: Response) => {
    const session = new SessionService(req.app.get('db'), res);
    await session.logout(req.cookies?.refresh_token);
});

// GET /api/auth/me - Validate current session (cookie-based)
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
    res.json({
        success: true,
        data: {
            user: {
                id: req.user!.id,
                username: req.user!.username,
            },
        },
    });
});

export default router;
