import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn() },
}));

import { logger } from '../utils/logger.js';
import {
  attachProgressStream,
  attachMemberNotificationStream,
  type MemberNotificationSink,
  type ProgressListenerSink,
} from './sse-bridge.js';

function makeSink(count = 1): ProgressListenerSink {
  return {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    getListenerCount: vi.fn().mockReturnValue(count),
  };
}

function makeMemberSink(count = 1): MemberNotificationSink {
  return {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    getListenerCount: vi.fn().mockReturnValue(count),
  };
}

function makeRes() {
  return { setHeader: vi.fn() } as unknown as Response;
}

describe('attachProgressStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets the SSE transport headers on the response', () => {
    attachProgressStream(makeRes(), makeSink());

    const res = makeRes();
    attachProgressStream(res, makeSink());
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
  });

  it('registers the response as a listener on the sink', () => {
    const res = makeRes();
    const sink = makeSink();

    attachProgressStream(res, sink);

    expect(sink.addListener).toHaveBeenCalledWith(res);
    expect(sink.addListener).toHaveBeenCalledTimes(1);
  });

  it('logs the connect line with the sink listener count', () => {
    attachProgressStream(makeRes(), makeSink(3));

    expect(logger.info).toHaveBeenCalledWith('📡 SSE client connected (3 total)');
  });

  it('returns a cleanup that removes the listener', () => {
    const res = makeRes();
    const sink = makeSink();
    const cleanup = attachProgressStream(res, sink);

    cleanup();

    expect(sink.removeListener).toHaveBeenCalledWith(res);
    expect(sink.removeListener).toHaveBeenCalledTimes(1);
  });

  it('logs the disconnect line with the post-removal count on cleanup', () => {
    const sink = makeSink(0);
    const cleanup = attachProgressStream(makeRes(), sink);

    cleanup();

    expect(logger.info).toHaveBeenCalledWith('📡 SSE client disconnected (0 remaining)');
  });

  it('invokes onClose on cleanup when provided', () => {
    const onClose = vi.fn();
    const cleanup = attachProgressStream(makeRes(), makeSink(), onClose);

    cleanup();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not require onClose (no throw on cleanup)', () => {
    const cleanup = attachProgressStream(makeRes(), makeSink());

    expect(() => cleanup()).not.toThrow();
  });
});

describe('attachMemberNotificationStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets the SSE transport headers on the response', () => {
    const res = makeRes();

    attachMemberNotificationStream(7, res, makeMemberSink());

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
  });

  it('registers the response on the sink keyed by memberId', () => {
    const res = makeRes();
    const sink = makeMemberSink();

    attachMemberNotificationStream(7, res, sink);

    expect(sink.addListener).toHaveBeenCalledWith(7, res);
  });

  it('writes no backlog frame — live-only on connect', () => {
    const res = makeRes();

    attachMemberNotificationStream(7, res, makeMemberSink());

    expect((res as unknown as { write?: unknown }).write).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith('📡 Member SSE client connected (member=7, 1 total)');
  });

  it('returns a cleanup that removes the listener and logs the member id', () => {
    const res = makeRes();
    const sink = makeMemberSink(0);
    const onClose = vi.fn();

    const cleanup = attachMemberNotificationStream(7, res, sink, onClose);
    cleanup();

    expect(sink.removeListener).toHaveBeenCalledWith(7, res);
    expect(logger.info).toHaveBeenCalledWith('📡 Member SSE client disconnected (member=7, 0 remaining)');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
