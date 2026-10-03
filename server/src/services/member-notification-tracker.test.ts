import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { MemberNotice } from '@movie-planner/scraper-protocol';
import { MAX_CONNECTIONS_PER_MEMBER, MemberNotificationTracker } from './member-notification-tracker.js';

function makeRes(): Response & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
  } as unknown as Response & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
}

function notice(memberId: number, outcome: MemberNotice['outcome'] = 'succeeded'): MemberNotice {
  return {
    type: 'submission_resolved',
    memberId,
    submissionId: 1,
    theaterId: 'C0013',
    theaterName: 'UGC Opéra',
    outcome,
    ...(outcome === 'failed' ? { reason: 'Source injoignable' } : {}),
  };
}

describe('MemberNotificationTracker', () => {
  let tracker: MemberNotificationTracker;

  beforeEach(() => {
    tracker = new MemberNotificationTracker();
  });

  it('tracks connections per member and overall', () => {
    const a1 = makeRes();
    const a2 = makeRes();
    const b1 = makeRes();

    tracker.addListener(1, a1);
    tracker.addListener(1, a2);
    tracker.addListener(2, b1);

    expect(tracker.getListenerCount()).toBe(3);
    expect(tracker.getListenerCountFor(1)).toBe(2);
    expect(tracker.getListenerCountFor(2)).toBe(1);
    expect(tracker.getListenerCountFor(3)).toBe(0);
  });

  it('removes a connection on disconnect and cleans up empty members', () => {
    const res = makeRes();
    tracker.addListener(7, res);
    expect(tracker.getListenerCount()).toBe(1);

    tracker.removeListener(7, res);

    expect(tracker.getListenerCount()).toBe(0);
    expect(tracker.getListenerCountFor(7)).toBe(0);
  });

  it('fans a notice out to all of the member\'s connections and to no one else', () => {
    const mine1 = makeRes();
    const mine2 = makeRes();
    const other = makeRes();
    tracker.addListener(1, mine1);
    tracker.addListener(1, mine2);
    tracker.addListener(2, other);

    tracker.emit(notice(1));

    expect(mine1.write).toHaveBeenCalledOnce();
    expect(mine2.write).toHaveBeenCalledOnce();
    expect(other.write).not.toHaveBeenCalled();
    expect(String(mine1.write.mock.calls[0][0])).toContain('"outcome":"succeeded"');
  });

  it('drops only the dead connection when a write fails', () => {
    const dead = makeRes();
    const alive = makeRes();
    dead.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    tracker.addListener(1, dead);
    tracker.addListener(1, alive);

    tracker.emit(notice(1));

    expect(tracker.getListenerCountFor(1)).toBe(1);
    expect(alive.write).toHaveBeenCalledOnce();
  });

  it('evicts the member\'s oldest connection beyond the cap of 5', () => {
    const connections = Array.from({ length: MAX_CONNECTIONS_PER_MEMBER }, () => makeRes());
    for (const connection of connections) {
      tracker.addListener(1, connection);
    }
    expect(tracker.getListenerCountFor(1)).toBe(MAX_CONNECTIONS_PER_MEMBER);

    const newest = makeRes();
    tracker.addListener(1, newest);

    expect(tracker.getListenerCountFor(1)).toBe(MAX_CONNECTIONS_PER_MEMBER);
    expect(connections[0].end).toHaveBeenCalledOnce();
    for (const connection of connections.slice(1)) {
      expect(connection.end).not.toHaveBeenCalled();
    }
    tracker.emit(notice(1));
    expect(newest.write).toHaveBeenCalledOnce();
  });

  it('routes by memberId — another member never receives someone else\'s notice', () => {
    const mine = makeRes();
    const theirs = makeRes();
    tracker.addListener(1, mine);
    tracker.addListener(2, theirs);

    tracker.emit(notice(1, 'failed'));

    expect(mine.write).toHaveBeenCalledOnce();
    expect(theirs.write).not.toHaveBeenCalled();
    expect(String(mine.write.mock.calls[0][0])).toContain('Source injoignable');
  });

  it('reset closes every connection and empties the sink', () => {
    const a = makeRes();
    const b = makeRes();
    tracker.addListener(1, a);
    tracker.addListener(2, b);

    tracker.reset();

    expect(tracker.getListenerCount()).toBe(0);
    expect(a.end).toHaveBeenCalled();
    expect(b.end).toHaveBeenCalled();
  });
});
