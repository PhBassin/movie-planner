import { errorHandler } from '../middleware/error-handler.js';
// IMPORTANT: Set JWT_SECRET BEFORE any imports
// The auth middleware reads process.env.JWT_SECRET at module load time
process.env.JWT_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import meRouter from './me.js';
import { db } from '../db/internal/client.js';
import * as memberQueries from '../db/member-queries.js';
import type { AuthRequest } from '../middleware/auth.js';
import { authLimiter, protectedLimiter } from '../middleware/rate-limit.js';
import { ForbiddenError, ValidationError } from '../utils/errors.js';

const TEST_JWT_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';

vi.mock('../db/internal/client.js', () => ({
    db: {
        query: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock('../db/member-queries.js', () => ({
    getMemberProfile: vi.fn(),
    updateMemberAppearance: vi.fn(),
}));

// Mock the auth middleware with proper JWT verification using test secret
vi.mock('../middleware/auth.js', () => ({
    requireAuth: vi.fn((req: AuthRequest, res, next) => {
        const authHeader = req.headers.authorization as string | undefined;
        const cookieToken = req.cookies?.access_token as string | undefined;
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const token = cookieToken || bearerToken;

        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required. No token provided.',
            });
        }

        try {
            const decoded = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as { id: number; username: string };
            req.user = decoded;
            next();
        } catch (error) {
            return res.status(401).json({
                success: false,
                error: 'Invalid or expired token.',
            });
        }
    }),
    requireMember: vi.fn((req: AuthRequest, res, next) => {
        if (req.user?.role_name !== 'member') {
            return res.status(403).json({ success: false, error: 'This endpoint is for member accounts' });
        }
        next();
    }),
    AuthRequest: {} as any,
}));

vi.mock('../middleware/rate-limit.js', () => ({
    protectedLimiter: vi.fn((_req, _res, next) => next()),
    authLimiter: vi.fn((_req, _res, next) => next()),
}));

const mockUsage = vi.fn();
vi.mock('../services/selection-service.js', () => ({
    SelectionService: class {
        usage = mockUsage;
    },
}));

const mockExportData = vi.fn();
const mockEraseSelf = vi.fn();
vi.mock('../services/member-account-service.js', () => ({
    MemberAccountService: class {
        exportData = mockExportData;
        eraseSelf = mockEraseSelf;
    },
}));

const app = express();
app.use(express.json());
app.use(cookieParser());
app.set('db', db); // Register mock db for dependency injection
app.use('/api/me', meRouter);
app.use(errorHandler);

function memberToken(id = 7, username = 'jane@example.com', role_name = 'member'): string {
    return jwt.sign({ id, username, role_name }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

describe('GET /api/me', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUsage.mockResolvedValue({
            offer: 'free', activeCount: 2, rememberedCount: 1, selectionQuota: 3, choiceLimit: 50, overQuota: false,
        });
    });

    it('should return the authenticated Member profile', async () => {
        vi.mocked(memberQueries.getMemberProfile).mockResolvedValue({
            id: 7,
            email: 'jane@example.com',
            username: 'jane@example.com',
            role_name: 'member',
            status: 'unverified',
            email_verified_at: null,
            appearance: 'light',
            created_at: '2024-01-01T00:00:00Z',
        });

        const response = await request(app)
            .get('/api/me')
            .set('Authorization', `Bearer ${memberToken()}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.user).toEqual({
            id: 7,
            email: 'jane@example.com',
            username: 'jane@example.com',
            role_name: 'member',
            status: 'unverified',
            email_verified: false,
            appearance: 'light',
            offer: 'free',
            selectionCount: 2,
            selectionLimit: 3,
            rememberedCount: 1,
            choiceLimit: 50,
            selectionOverQuota: false,
            created_at: '2024-01-01T00:00:00Z',
        });
        expect(memberQueries.getMemberProfile).toHaveBeenCalledWith(db, 7);
        expect(mockUsage).toHaveBeenCalledWith(7);
    });

    it('should report email_verified=true when email_verified_at is set', async () => {
        vi.mocked(memberQueries.getMemberProfile).mockResolvedValue({
            id: 7,
            email: 'jane@example.com',
            username: 'jane@example.com',
            role_name: 'member',
            status: 'active',
            email_verified_at: '2024-01-02T00:00:00Z',
            appearance: 'dark',
            created_at: '2024-01-01T00:00:00Z',
        });

        const response = await request(app)
            .get('/api/me')
            .set('Authorization', `Bearer ${memberToken()}`);

        expect(response.status).toBe(200);
        expect(response.body.data.user.email_verified).toBe(true);
        expect(response.body.data.user.status).toBe('active');
        expect(response.body.data.user.appearance).toBe('dark');
    });

    it('should not expose the password hash', async () => {
        vi.mocked(memberQueries.getMemberProfile).mockResolvedValue({
            id: 7,
            email: 'jane@example.com',
            username: 'jane@example.com',
            role_name: 'member',
            status: 'unverified',
            email_verified_at: null,
            appearance: 'light',
            created_at: '2024-01-01T00:00:00Z',
        });

        const response = await request(app)
            .get('/api/me')
            .set('Authorization', `Bearer ${memberToken()}`);

        expect(response.body.data.user.password_hash).toBeUndefined();
    });

    it('should derive the offer and quota per request, independent of status and role', async () => {
        vi.mocked(memberQueries.getMemberProfile).mockResolvedValue({
            id: 7,
            email: 'jane@example.com',
            username: 'jane@example.com',
            role_name: 'member',
            status: 'active',
            email_verified_at: null,
            appearance: 'light',
            created_at: '2024-01-01T00:00:00Z',
        });
        mockUsage.mockResolvedValue({
            offer: 'premium', activeCount: 12, rememberedCount: 0, selectionQuota: 50, choiceLimit: 50, overQuota: false,
        });

        const response = await request(app)
            .get('/api/me')
            .set('Authorization', `Bearer ${memberToken()}`);

        expect(response.body.data.user).toEqual(expect.objectContaining({
            role_name: 'member',
            status: 'active',
            offer: 'premium',
            selectionCount: 12,
            selectionLimit: 50,
            selectionOverQuota: false,
        }));
    });

    it('should return 401 without a token', async () => {
        const response = await request(app).get('/api/me');

        expect(response.status).toBe(401);
        expect(response.body.success).toBe(false);
    });

    it('should return 403 for a Staff account (the profile is Member-shaped)', async () => {
        const response = await request(app)
            .get('/api/me')
            .set('Authorization', `Bearer ${memberToken(1, 'admin', 'admin')}`);

        expect(response.status).toBe(403);
        expect(response.body.success).toBe(false);
        expect(memberQueries.getMemberProfile).not.toHaveBeenCalled();
    });

    it('should return 404 when the user no longer exists', async () => {
        vi.mocked(memberQueries.getMemberProfile).mockResolvedValue(undefined);

        const response = await request(app)
            .get('/api/me')
            .set('Authorization', `Bearer ${memberToken(999)}`);

        expect(response.status).toBe(404);
        expect(response.body.success).toBe(false);
    });
});

describe('PUT /api/me/appearance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each(['light', 'dark'] as const)('should persist appearance=%s', async (appearance) => {
        vi.mocked(memberQueries.updateMemberAppearance).mockResolvedValue(undefined);

        const response = await request(app)
            .put('/api/me/appearance')
            .set('Authorization', `Bearer ${memberToken()}`)
            .send({ appearance });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data).toEqual({ id: 7, appearance });
        expect(memberQueries.updateMemberAppearance).toHaveBeenCalledWith(db, 7, appearance);
    });

    it('should reject a missing appearance without writing', async () => {
        const response = await request(app)
            .put('/api/me/appearance')
            .set('Authorization', `Bearer ${memberToken()}`)
            .send({});

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(memberQueries.updateMemberAppearance).not.toHaveBeenCalled();
    });

    it.each([['system'], ['DARK'], [123], [null], [true]])(
        'should reject the invalid appearance value %p without writing',
        async (value) => {
            const response = await request(app)
                .put('/api/me/appearance')
                .set('Authorization', `Bearer ${memberToken()}`)
                .send({ appearance: value });

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(memberQueries.updateMemberAppearance).not.toHaveBeenCalled();
        }
    );

    it('should return 401 without a token', async () => {
        const response = await request(app)
            .put('/api/me/appearance')
            .send({ appearance: 'dark' });

        expect(response.status).toBe(401);
        expect(response.body.success).toBe(false);
        expect(memberQueries.updateMemberAppearance).not.toHaveBeenCalled();
    });

    it('should return 403 for a Staff account (Appearance is Member-owned)', async () => {
        const response = await request(app)
            .put('/api/me/appearance')
            .set('Authorization', `Bearer ${memberToken(1, 'admin', 'admin')}`)
            .send({ appearance: 'dark' });

        expect(response.status).toBe(403);
        expect(response.body.success).toBe(false);
        expect(memberQueries.updateMemberAppearance).not.toHaveBeenCalled();
    });

    it('should go through the protected rate limiter (a Member-scoped write)', async () => {
        vi.mocked(memberQueries.updateMemberAppearance).mockResolvedValue(undefined);

        await request(app)
            .put('/api/me/appearance')
            .set('Authorization', `Bearer ${memberToken()}`)
            .send({ appearance: 'dark' });

        expect(protectedLimiter).toHaveBeenCalled();
    });
});

describe('GET /api/me/export', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the Member data export document, uncached', async () => {
        const document = {
            exported_at: '2026-10-23T00:00:00.000Z',
            account: { email: 'jane@example.com', status: 'active', email_verified_at: null, created_at: '2026-01-01T00:00:00Z' },
            appearance: 'light',
            selection: [],
            submissions: [],
        };
        mockExportData.mockResolvedValue(document);

        const response = await request(app)
            .get('/api/me/export')
            .set('Authorization', `Bearer ${memberToken()}`);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true, data: document });
        expect(response.headers['cache-control']).toBe('no-store');
        // Member-scoped: the Session's own id, never a client-supplied one.
        expect(mockExportData).toHaveBeenCalledWith(7);
        expect(protectedLimiter).toHaveBeenCalled();
    });

    it('rejects Staff with 403', async () => {
        const response = await request(app)
            .get('/api/me/export')
            .set('Authorization', `Bearer ${memberToken(1, 'admin', 'admin')}`);

        expect(response.status).toBe(403);
        expect(mockExportData).not.toHaveBeenCalled();
    });

    it('requires a Session', async () => {
        const response = await request(app).get('/api/me/export');
        expect(response.status).toBe(401);
    });
});

describe('POST /api/me/delete', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('erases the Member with their password and clears the whole cookie surface', async () => {
        mockEraseSelf.mockResolvedValue(undefined);

        const response = await request(app)
            .post('/api/me/delete')
            .set('Authorization', `Bearer ${memberToken()}`)
            .send({ password: 'Str0ng!Pass', id: 99 });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true, data: { message: 'Account deleted' } });
        // The Session's id — a body-supplied id is ignored.
        expect(mockEraseSelf).toHaveBeenCalledWith(7, 'Str0ng!Pass');
        const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
        for (const name of ['access_token', 'refresh_token', 'csrf_token']) {
            expect(cookies.some((c) => c.startsWith(`${name}=;`))).toBe(true);
        }
        expect(authLimiter).toHaveBeenCalled();
    });

    it('rejects a wrong password with 403 and keeps the cookies', async () => {
        mockEraseSelf.mockRejectedValue(new ForbiddenError('Password is incorrect'));

        const response = await request(app)
            .post('/api/me/delete')
            .set('Authorization', `Bearer ${memberToken()}`)
            .send({ password: 'wrong' });

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Password is incorrect');
        expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('rejects a missing password with 400', async () => {
        mockEraseSelf.mockRejectedValue(new ValidationError('Password is required'));

        const response = await request(app)
            .post('/api/me/delete')
            .set('Authorization', `Bearer ${memberToken()}`)
            .send({});

        expect(response.status).toBe(400);
        expect(mockEraseSelf).toHaveBeenCalledWith(7, undefined);
    });

    it('rejects Staff with 403 without erasing anything', async () => {
        const response = await request(app)
            .post('/api/me/delete')
            .set('Authorization', `Bearer ${memberToken(1, 'admin', 'admin')}`)
            .send({ password: 'x' });

        expect(response.status).toBe(403);
        expect(mockEraseSelf).not.toHaveBeenCalled();
    });
});
