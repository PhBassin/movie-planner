import { errorHandler } from '../middleware/error-handler.js';
process.env.JWT_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import submissionsRouter from './submissions.js';
import { AppError, ForbiddenError, ValidationError } from '../utils/errors.js';
import { MEMBER_ONLY_ENDPOINT_MESSAGE } from '../types/role.js';

const mockSubmit = vi.fn();

vi.mock('../services/submission-service.js', () => ({
  SubmissionService: class {
    submit = mockSubmit;
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
app.use('/api/me/submissions', submissionsRouter);
app.use(errorHandler);

const submissionRow = {
  id: 9,
  member_id: 7,
  url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html',
  theater_id: 'C0013',
  status: 'pending',
  report_id: 42,
  created_at: '2024-01-01T00:00:00Z',
  resolved_at: null,
};

describe('POST /api/me/submissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 201 with the pending submission when a new cinema is accepted', async () => {
    mockSubmit.mockResolvedValue({ outcome: 'submitted', submission: submissionRow });

    const response = await request(app)
      .post('/api/me/submissions')
      .send({ url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html' });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.submission).toEqual(submissionRow);
    expect(mockSubmit).toHaveBeenCalledWith(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html');
  });

  it('returns 200 with selectionAdded when the URL dedups to an existing cinema', async () => {
    mockSubmit.mockResolvedValue({
      outcome: 'selection_added',
      theater: { id: 'C0013', name: 'UGC Opéra', status: 'active' },
    });

    const response = await request(app)
      .post('/api/me/submissions')
      .send({ url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html' });

    expect(response.status).toBe(200);
    expect(response.body.data.selectionAdded).toBe(true);
    expect(response.body.data.theater.id).toBe('C0013');
  });

  it('returns 403 when the service blocks an unverified Member', async () => {
    mockSubmit.mockRejectedValue(new ForbiddenError('You must verify your email before submitting a cinema'));

    const response = await request(app)
      .post('/api/me/submissions')
      .send({ url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html' });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('verify your email');
  });

  it('returns 429 when the Member hits the submission throttle', async () => {
    mockSubmit.mockRejectedValue(new AppError('You have reached the limit of 3 new cinema submissions', 429));

    const response = await request(app)
      .post('/api/me/submissions')
      .send({ url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html' });

    expect(response.status).toBe(429);
    expect(response.body.error).toContain('limit');
  });

  it('returns 400 for an invalid URL', async () => {
    mockSubmit.mockRejectedValue(new ValidationError('Invalid Allocine URL. Must be https://www.allocine.fr/...'));

    const response = await request(app)
      .post('/api/me/submissions')
      .send({ url: 'https://bad.example' });

    expect(response.status).toBe(400);
  });

  it('keeps Staff outside the Member submission route', async () => {
    const response = await request(app)
      .post('/api/me/submissions')
      .set('x-test-role', 'admin')
      .send({ url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html' });

    expect(response.status).toBe(403);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
