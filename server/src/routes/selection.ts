import express, { type NextFunction, type Response } from 'express';
import type { ApiResponse } from '../types/api.js';
import { requireAuth, requireMember, type AuthRequest } from '../middleware/auth.js';
import { protectedLimiter } from '../middleware/rate-limit.js';
import { SelectionService } from '../services/selection-service.js';

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
