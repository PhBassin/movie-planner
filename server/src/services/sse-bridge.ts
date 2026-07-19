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
 * Attach an Express response as an SSE progress stream.
 *
 * Owns the transport detail — the SSE response headers and the add/remove
 * listener lifecycle against `sink` — and returns a disconnect cleanup the
 * caller wires to `req.on('close', ...)`. Extracted from `ScraperService` so
 * the dispatcher stays single-concept (C4 of epic #1232). The API does not
 * scrape: it fans `ProgressEvent`s from the Redis pub/sub bridge to SSE
 * clients through this seam (`CONTEXT.md`).
 */
export function attachProgressStream(
  res: Response,
  sink: ProgressListenerSink,
  onClose?: () => void,
): () => void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  sink.addListener(res);
  logger.info(`📡 SSE client connected (${sink.getListenerCount()} total)`);

  return () => {
    sink.removeListener(res);
    logger.info(`📡 SSE client disconnected (${sink.getListenerCount()} remaining)`);
    onClose?.();
  };
}
