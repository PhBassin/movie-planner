import express, { type NextFunction, type Response } from 'express';
import { requireAuth, requireMember, type AuthRequest } from '../middleware/auth.js';
import { protectedLimiter } from '../middleware/rate-limit.js';
import { attachMemberNotificationStream } from '../services/sse-bridge.js';
import { memberNotificationTracker } from '../services/member-notification-tracker.js';

/**
 * `GET /api/me/notifications` — the per-Member, auth-gated SSE stream for
 * Member-domain outcome notices (ADR 0005 sub-decisions 3 and 9), separate
 * from the unauthenticated Staff telemetry stream on `/api/scraper/progress`.
 *
 * Handshake-only auth: `requireAuth` + `requireMember` gate the connect; once
 * open, the stream stays open until the client closes it (revocation takes
 * effect at the next auth boundary). Live-only — no backlog frame is written
 * on connect; durability lives in the submission rows, not this wire.
 */
const router = express.Router();

router.get(
  '/',
  protectedLimiter,
  requireAuth,
  requireMember,
  (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const cleanup = attachMemberNotificationStream(
        req.user!.id,
        res,
        memberNotificationTracker,
      );

      req.on('close', cleanup);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
