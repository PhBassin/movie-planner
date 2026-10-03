import type { Response } from 'express';
import { logger } from '../utils/logger.js';

/**
 * Minimal listener surface the SSE bridge needs from a progress source.
 * Implemented by {@link ProgressTracker} (`services/progress-tracker.ts`);
 * stubbable in tests without a fake Express `res` or the tracker singleton.
 */
export interface ProgressListenerSink {
  addListener(res: Response): void;
  removeListener(res: Response): void;
  getListenerCount(): number;
}

/**
 * Per-Member counterpart of {@link ProgressListenerSink} (ADR 0005
 * sub-decision 3): registration and fan-out are keyed by `memberId`.
 * Implemented by the member notification tracker
 * (`services/member-notification-tracker.ts`).
 */
export interface MemberNotificationSink {
  addListener(memberId: number, res: Response): void;
  removeListener(memberId: number, res: Response): void;
  getListenerCount(): number;
}

function writeSseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
}

/**
 * Attach an Express response as an SSE progress stream.
 *
 * Owns the transport detail — the SSE response headers and the add/remove
 * listener lifecycle against `sink` — and returns a disconnect cleanup the
 * caller wires to `req.on('close', ...)`. Extracted from `ScraperService` so
 * the dispatcher stays single-concept (C4 of epic #1232). The API does not
 * scrape: it fans `ProgressEvent`s from the Postgres notification bus to SSE
 * clients through this seam (`CONTEXT.md`).
 */
export function attachProgressStream(
  res: Response,
  sink: ProgressListenerSink,
  onClose?: () => void,
): () => void {
  writeSseHeaders(res);

  sink.addListener(res);
  logger.info(`📡 SSE client connected (${sink.getListenerCount()} total)`);

  return () => {
    sink.removeListener(res);
    logger.info(`📡 SSE client disconnected (${sink.getListenerCount()} remaining)`);
    onClose?.();
  };
}

/**
 * Attach an authenticated Member's Express response as an SSE notifications
 * stream (ADR 0005 sub-decisions 3 and 9). Handshake-only auth: the caller
 * gates the request through `requireAuth` + `requireMember`; once open, the
 * stream lives until the client closes it. Live-only — no backlog frame is
 * written on connect.
 */
export function attachMemberNotificationStream(
  memberId: number,
  res: Response,
  sink: MemberNotificationSink,
  onClose?: () => void,
): () => void {
  writeSseHeaders(res);

  sink.addListener(memberId, res);
  logger.info(`📡 Member SSE client connected (member=${memberId}, ${sink.getListenerCount()} total)`);

  return () => {
    sink.removeListener(memberId, res);
    logger.info(`📡 Member SSE client disconnected (member=${memberId}, ${sink.getListenerCount()} remaining)`);
    onClose?.();
  };
}
