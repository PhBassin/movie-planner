import type { Response } from 'express';
import type { MemberNotice } from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';

/**
 * Per-Member concurrent SSE connection cap (ADR 0005 sub-decision 9).
 * A deliberate `const`, not env-tuned: 5 is invisible to honest multi-device
 * use and bounds per-notice fan-out to a constant. Overrun evicts the
 * Member's oldest pipe — the tab they just opened always wins.
 */
export const MAX_CONNECTIONS_PER_MEMBER = 5;

const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Per-`memberId`-keyed SSE sink for Member notifications (ADR 0005
 * sub-decisions 3 and 9) — the Member-domain peer of the global
 * `ProgressTracker`, kept separate so Staff scraper telemetry and Member
 * outcomes never share a wire. Live-only: no backlog is kept or replayed;
 * durability lives in the `theater_submissions` rows.
 */
export class MemberNotificationTracker {
  private connections: Map<number, Response[]> = new Map();
  private heartbeatInterval?: NodeJS.Timeout;

  /**
   * Register a Member's connection. At the per-Member cap the oldest
   * connection is evicted (its response is ended) before the new one is
   * appended, so the freshest tab always stays connected.
   */
  addListener(memberId: number, res: Response): void {
    let memberConnections = this.connections.get(memberId);
    if (!memberConnections) {
      memberConnections = [];
      this.connections.set(memberId, memberConnections);
    }

    while (memberConnections.length >= MAX_CONNECTIONS_PER_MEMBER) {
      const evicted = memberConnections.shift();
      if (!evicted) break;
      try {
        evicted.end();
      } catch {
        // Already gone — nothing to reap.
      }
      logger.info(`📡 Evicted oldest member SSE connection (member=${memberId})`);
    }

    memberConnections.push(res);

    if (this.getListenerCount() === 1) {
      this.startHeartbeat();
    }
  }

  removeListener(memberId: number, res: Response): void {
    const memberConnections = this.connections.get(memberId);
    if (!memberConnections) return;

    const index = memberConnections.indexOf(res);
    if (index !== -1) {
      memberConnections.splice(index, 1);
    }
    if (memberConnections.length === 0) {
      this.connections.delete(memberId);
    }
    if (this.getListenerCount() === 0) {
      this.stopHeartbeat();
    }
  }

  /**
   * Fan a notice out to ALL of the Member's live connections (multi-device).
   * A write failure drops that connection only; delivery to the rest proceeds.
   */
  emit(notice: MemberNotice): void {
    const memberConnections = this.connections.get(notice.memberId);
    if (!memberConnections || memberConnections.length === 0) return;

    const payload = `data: ${JSON.stringify(notice)}\n\n`;
    for (const listener of [...memberConnections]) {
      try {
        listener.write(payload);
      } catch {
        this.removeListener(notice.memberId, listener);
      }
    }
  }

  getListenerCount(): number {
    let total = 0;
    for (const memberConnections of this.connections.values()) {
      total += memberConnections.length;
    }
    return total;
  }

  getListenerCountFor(memberId: number): number {
    return this.connections.get(memberId)?.length ?? 0;
  }

  /** Close every live connection and stop the heartbeat (tests, shutdown). */
  reset(): void {
    this.stopHeartbeat();
    for (const [memberId, memberConnections] of [...this.connections]) {
      for (const listener of memberConnections) {
        try {
          listener.end();
        } catch {
          // Ignore errors when closing
        }
      }
      this.connections.delete(memberId);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [memberId, memberConnections] of this.connections) {
        for (const listener of [...memberConnections]) {
          try {
            listener.write(': heartbeat\n\n');
          } catch {
            this.removeListener(memberId, listener);
          }
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatInterval.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }
}

// Singleton instance
export const memberNotificationTracker = new MemberNotificationTracker();
