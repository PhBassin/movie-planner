import express, { type NextFunction, type Response } from 'express';
import type { ApiResponse } from '../types/api.js';
import { requireAuth, requireMember, type AuthRequest } from '../middleware/auth.js';
import { protectedLimiter } from '../middleware/rate-limit.js';
import { SelectionService } from '../services/selection-service.js';
import { MovieService } from '../services/movie-service.js';
import { getWeekStart } from '../utils/date.js';
import { ValidationError } from '../utils/errors.js';

const router = express.Router();

router.get(
  '/',
  protectedLimiter,
  requireAuth,
  requireMember,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const selection = await new SelectionService(req.app.get('db')).list(req.user!.id);
      res.json({ success: true, data: selection } satisfies ApiResponse);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/me/selection/movies - Selection homepage: movies playing at the
// Member's selected theaters for the current week (or a specific date),
// carrying per-movie and per-theater newness for the New section.
router.get(
  '/movies',
  protectedLimiter,
  requireAuth,
  requireMember,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const weekStart = getWeekStart();
      const dateParam = req.query.date as string | undefined;

      if (dateParam) {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(dateParam)) {
          return next(new ValidationError('Invalid date format. Use YYYY-MM-DD'));
        }
      }

      const movieService = new MovieService(req.app.get('db'));
      const movies = dateParam
        ? await movieService.getSelectionMoviesForDate(req.user!.id, dateParam, weekStart)
        : await movieService.getSelectionMoviesForWeek(req.user!.id, weekStart);

      res.json({
        success: true,
        data: { movies, weekStart, ...(dateParam && { date: dateParam }) },
      } satisfies ApiResponse);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/:theaterId',
  protectedLimiter,
  requireAuth,
  requireMember,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const theater = await new SelectionService(req.app.get('db')).add(
        req.user!.id,
        req.params.theaterId as string,
      );
      res.status(201).json({ success: true, data: theater } satisfies ApiResponse);
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/:theaterId',
  protectedLimiter,
  requireAuth,
  requireMember,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await new SelectionService(req.app.get('db')).remove(
        req.user!.id,
        req.params.theaterId as string,
      );
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);

export default router;
