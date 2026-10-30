import { errorHandler } from '../middleware/error-handler.js';
process.env.JWT_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import selectionRouter from './selection.js';
import { AppError } from '../utils/errors.js';
import { MEMBER_ONLY_ENDPOINT_MESSAGE } from '../types/role.js';

const mockList = vi.fn();
const mockAdd = vi.fn();
const mockRemove = vi.fn();
const mockProjection = vi.fn();

const mockGetSelectionMoviesForWeek = vi.fn();
const mockGetSelectionMoviesForDate = vi.fn();
const mockSearchSelection = vi.fn();

vi.mock('../services/movie-service.js', () => ({
  MovieService: class {
    getSelectionMoviesForWeek = mockGetSelectionMoviesForWeek;
    getSelectionMoviesForDate = mockGetSelectionMoviesForDate;
    searchSelection = mockSearchSelection;
  },
}));

vi.mock('../services/selection-service.js', () => ({
  SelectionService: class {
    list = mockList;
    add = mockAdd;
    remove = mockRemove;
    projection = mockProjection;
  },
}));

vi.mock('../middleware/rate-limit.js', () => ({
  protectedLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request & { user?: { id: number; role_name: string } }, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 7,
      role_name: req.headers['x-test-role'] === 'admin' ? 'admin' : 'member',
    };
    next();
  },
  requireMember: (req: express.Request & { user?: { role_name: string } }, res: express.Response, next: express.NextFunction) => {
    if (req.user?.role_name !== 'member') {
      return res.status(403).json({ success: false, error: MEMBER_ONLY_ENDPOINT_MESSAGE });
    }
    next();
  },
}));

const app = express();
app.use(express.json());
app.set('db', {});
app.use('/api/me/selection', selectionRouter);
app.use(errorHandler);

describe('Selection routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjection.mockResolvedValue({ overQuota: false, theaterIds: ['C0001', 'C0002'] });
  });

  it('lists the authenticated Member Selection', async () => {
    mockList.mockResolvedValue([{ id: 'C0001', name: 'UGC Opéra', status: 'active' }]);

    const response = await request(app).get('/api/me/selection');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: [{ id: 'C0001', name: 'UGC Opéra', status: 'active' }],
    });
    expect(mockList).toHaveBeenCalledWith(7);
  });

  it('adds a theater without exposing any scrape operation', async () => {
    mockAdd.mockResolvedValue({ id: 'C0001', name: 'UGC Opéra', status: 'active' });

    const response = await request(app).post('/api/me/selection/C0001');

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({ id: 'C0001', name: 'UGC Opéra', status: 'active' });
    expect(mockAdd).toHaveBeenCalledWith(7, 'C0001');
  });

  it('removes a theater from the Selection', async () => {
    mockRemove.mockResolvedValue(true);

    const response = await request(app).delete('/api/me/selection/C0001');

    expect(response.status).toBe(204);
    expect(mockRemove).toHaveBeenCalledWith(7, 'C0001');
  });

  it('returns the service 409 unchanged at the HTTP boundary, with the fresh usage', async () => {
    const usage = { offer: 'free', activeCount: 3, rememberedCount: 0, selectionQuota: 3, choiceLimit: 50, overQuota: false };
    mockAdd.mockRejectedValue(new AppError('Free offer allows 3 active theaters; premium allows up to 50', 409, [{ reason: 'quota_reached', usage }]));

    const response = await request(app).post('/api/me/selection/C0001');

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('3');
    expect(response.body.details).toEqual([{ reason: 'quota_reached', usage }]);
  });

  it('keeps Staff outside the Member Selection routes', async () => {
    const response = await request(app)
      .get('/api/me/selection')
      .set('x-test-role', 'admin');

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
  describe('GET /movies — Selection homepage data', () => {
    it('returns the Member weekly Selection movies with the current week start', async () => {
      mockGetSelectionMoviesForWeek.mockResolvedValue([
        { id: 1, title: 'Film A', isNewThisWeek: true, theaters: [] },
      ]);

      const response = await request(app).get('/api/me/selection/movies');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.movies).toEqual([
        { id: 1, title: 'Film A', isNewThisWeek: true, theaters: [] },
      ]);
      expect(response.body.data.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(mockProjection).toHaveBeenCalledWith(7);
      expect(mockGetSelectionMoviesForWeek).toHaveBeenCalledWith(['C0001', 'C0002'], response.body.data.weekStart);
      expect(response.body.data.overQuota).toBeUndefined();
    });

    it('serves the date variant through the date-scoped service method', async () => {
      mockGetSelectionMoviesForDate.mockResolvedValue([]);

      const response = await request(app).get('/api/me/selection/movies?date=2026-03-12');

      expect(response.status).toBe(200);
      expect(response.body.data.date).toBe('2026-03-12');
      expect(mockGetSelectionMoviesForDate).toHaveBeenCalledWith(['C0001', 'C0002'], '2026-03-12', response.body.data.weekStart);
      expect(mockGetSelectionMoviesForWeek).not.toHaveBeenCalled();
    });

    it('projects no personal data while the Selection is over quota (ADR 0011 D3)', async () => {
      mockProjection.mockResolvedValue({ overQuota: true });

      const response = await request(app).get('/api/me/selection/movies?date=2026-03-12');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(expect.objectContaining({ movies: [], overQuota: true }));
      expect(mockGetSelectionMoviesForDate).not.toHaveBeenCalled();
      expect(mockGetSelectionMoviesForWeek).not.toHaveBeenCalled();
    });

    it('rejects a malformed date with a 400', async () => {
      const response = await request(app).get('/api/me/selection/movies?date=12-03-2026');

      expect(response.status).toBe(400);
      expect(mockGetSelectionMoviesForDate).not.toHaveBeenCalled();
      expect(mockGetSelectionMoviesForWeek).not.toHaveBeenCalled();
    });

    it('keeps Staff outside the Selection movies endpoint', async () => {
      const response = await request(app)
        .get('/api/me/selection/movies')
        .set('x-test-role', 'admin');

      expect(response.status).toBe(403);
      expect(mockGetSelectionMoviesForWeek).not.toHaveBeenCalled();
    });
  });

  describe('GET /movies/search', () => {
    it('returns search results scoped to the Member Selection', async () => {
      mockSearchSelection.mockResolvedValue([{ id: 1, title: 'Film A' }]);

      const response = await request(app).get('/api/me/selection/movies/search?q=Film');

      expect(response.status).toBe(200);
      expect(response.body.data.movies).toEqual([{ id: 1, title: 'Film A' }]);
      expect(mockSearchSelection).toHaveBeenCalledWith(['C0001', 'C0002'], 'Film', 10);
    });

    it('returns no search results while the Selection is over quota', async () => {
      mockProjection.mockResolvedValue({ overQuota: true });

      const response = await request(app).get('/api/me/selection/movies/search?q=Film');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ movies: [], query: 'Film', overQuota: true });
      expect(mockSearchSelection).not.toHaveBeenCalled();
    });
  });

});
