import express, { type NextFunction, type Response } from 'express';
import type { ApiResponse } from '../types/api.js';
import { requireAuth, requireMember, type AuthRequest } from '../middleware/auth.js';
import { protectedLimiter } from '../middleware/rate-limit.js';
import { SubmissionService } from '../services/submission-service.js';

/**
 * `POST /api/me/submissions` — a verified Member submits a new cinema by its
 * source URL (see CONTEXT.md → TheaterSubmission). The three synchronous
 * outcomes (issue #62) resolve in this response:
 *   - dedup → 200 `selection_added` (degraded to a Selection add, no scrape)
 *   - genuinely new → 201 `submitted` (provisioning Theater + add_theater job)
 *   - throttle → 429 / unverified → 403, both as AppErrors from the service.
 * The async resolution (succeeded/failed) lives on issue #63.
 */
const router = express.Router();

router.post(
  '/',
  protectedLimiter,
  requireAuth,
  requireMember,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const url = (req.body as { url?: unknown } | undefined)?.url;
      const result = await new SubmissionService(req.app.get('db')).submit(req.user!.id, url as string);

      if (result.outcome === 'selection_added') {
        res.json({
          success: true,
          data: { selectionAdded: true, theater: result.theater },
        } satisfies ApiResponse);
        return;
      }

      res.status(201).json({
        success: true,
        data: { submission: result.submission },
      } satisfies ApiResponse);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
