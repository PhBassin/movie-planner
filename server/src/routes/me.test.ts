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

const TEST_JWT_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';

vi.mock('../db/internal/client.js', () => ({
    db: {
        query: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock('../db/member-queries.js', () => ({
    getMemberProfile: vi.fn(),
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
    AuthRequest: {} as any,
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
            selection_count: 0,
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
            selectionCount: 0,
            selectionLimit: 50,
            created_at: '2024-01-01T00:00:00Z',
        });
        expect(memberQueries.getMemberProfile).toHaveBeenCalledWith(db, 7);
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
            selection_count: 3,
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
            selection_count: 0,
            created_at: '2024-01-01T00:00:00Z',
        });

        const response = await request(app)
            .get('/api/me')
            .set('Authorization', `Bearer ${memberToken()}`);

        expect(response.body.data.user.password_hash).toBeUndefined();
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
