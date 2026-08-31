import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../db/index.js';
import { SubmissionResolutionService } from './submission-resolver.js';
import {
  getPendingSubmissionByReport,
  getResolvablePendingSubmissions,
  resolveSubmission,
} from '../db/submission-queries.js';
import { getScrapeReport } from '../db/report-queries.js';
import { getTheaterById } from '../db/theater-queries.js';
import {
  getSelectionCount,
  insertSelection,
  isTheaterSelected,
  lockMemberForSelection,
} from '../db/selection-queries.js';
import { getBusProducer } from './bus-producer.js';
import { logger } from '../utils/logger.js';

vi.mock('../db/submission-queries.js', () => ({
  getPendingSubmissionByReport: vi.fn(),
  getResolvablePendingSubmissions: vi.fn(),
  resolveSubmission: vi.fn(),
}));

vi.mock('../db/report-queries.js', () => ({
  getScrapeReport: vi.fn(),
}));

vi.mock('../db/theater-queries.js', () => ({
  getTheaterById: vi.fn(),
}));

vi.mock('../db/selection-queries.js', () => ({
  lockMemberForSelection: vi.fn(),
  isTheaterSelected: vi.fn(),
  getSelectionCount: vi.fn(),
  insertSelection: vi.fn(),
}));

vi.mock('./bus-producer.js', () => ({
  getBusProducer: vi.fn(),
}));

vi.mock('./selection-service.js', () => ({
  MAX_SELECTION_SIZE: 2,
}));

vi.mock('../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const pendingSubmission = {
  id: 9,
  member_id: 7,
  url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html',
  theater_id: 'C0013',
  status: 'pending' as const,
  report_id: 42,
  created_at: '2024-01-01T00:00:00Z',
  resolved_at: null,
};

const activeTheater = { id: 'C0013', name: 'UGC Opéra', status: 'active' as const };
const member = { id: 7, role_name: 'member', status: 'active', email_verified_at: '2024-01-01T00:00:00Z' };

describe('SubmissionResolutionService', () => {
  const tx = {} as DB;
  const db = {
    transaction: vi.fn(async (callback: (client: DB) => Promise<unknown>) => callback(tx)),
  } as unknown as DB;
  const publishMemberNotice = vi.fn().mockResolvedValue(undefined);
  let service: SubmissionResolutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SubmissionResolutionService(db, { publishMemberNotice });
    vi.mocked(getBusProducer).mockReturnValue({ publishMemberNotice } as never);
    vi.mocked(getTheaterById).mockResolvedValue(activeTheater);
    vi.mocked(lockMemberForSelection).mockResolvedValue(member);
    vi.mocked(isTheaterSelected).mockResolvedValue(false);
    vi.mocked(getSelectionCount).mockResolvedValue(0);
    vi.mocked(insertSelection).mockResolvedValue(undefined);
    vi.mocked(resolveSubmission).mockImplementation(async (_db, id, status) => ({
      ...pendingSubmission,
      id,
      status,
      resolved_at: '2024-01-02T00:00:00Z',
    }));
  });

  describe('resolveReport (live path)', () => {
    it('does nothing when no pending submission joins the report', async () => {
      vi.mocked(getPendingSubmissionByReport).mockResolvedValue(undefined);

      await expect(service.resolveReport(42)).resolves.toBeNull();
      expect(getScrapeReport).not.toHaveBeenCalled();
      expect(publishMemberNotice).not.toHaveBeenCalled();
    });

    it('does nothing while the report is still running', async () => {
      vi.mocked(getPendingSubmissionByReport).mockResolvedValue(pendingSubmission);
      vi.mocked(getScrapeReport).mockResolvedValue({ id: 42, status: 'running', trigger_type: 'manual', started_at: '', });

      await expect(service.resolveReport(42)).resolves.toBeNull();
      expect(resolveSubmission).not.toHaveBeenCalled();
      expect(publishMemberNotice).not.toHaveBeenCalled();
    });

    it('on success: status write → selection auto-add → notice, in order, one transaction', async () => {
      vi.mocked(getPendingSubmissionByReport).mockResolvedValue(pendingSubmission);
      vi.mocked(getScrapeReport).mockResolvedValue({ id: 42, status: 'success', trigger_type: 'manual', started_at: '' });
      vi.mocked(resolveSubmission).mockResolvedValue({ ...pendingSubmission, status: 'succeeded' });

      const result = await service.resolveReport(42);

      expect(result?.outcome).toBe('succeeded');
      expect(db.transaction).toHaveBeenCalledOnce();
      expect(resolveSubmission).toHaveBeenCalledWith(tx, 9, 'succeeded');
      expect(lockMemberForSelection).toHaveBeenCalledWith(tx, 7);
      expect(isTheaterSelected).toHaveBeenCalledWith(tx, 7, 'C0013');
      expect(getSelectionCount).toHaveBeenCalledWith(tx, 7);
      expect(insertSelection).toHaveBeenCalledWith(tx, 7, 'C0013');

      // The durable facts (status, selection) must commit before the ephemeral push.
      const statusOrder = resolveSubmission.mock.invocationCallOrder[0];
      const insertOrder = insertSelection.mock.invocationCallOrder[0];
      const publishOrder = publishMemberNotice.mock.invocationCallOrder[0];
      expect(statusOrder).toBeLessThan(insertOrder);
      expect(insertOrder).toBeLessThan(publishOrder);

      expect(publishMemberNotice).toHaveBeenCalledOnce();
      expect(publishMemberNotice).toHaveBeenCalledWith({
        type: 'submission_resolved',
        memberId: 7,
        submissionId: 9,
        theaterId: 'C0013',
        theaterName: 'UGC Opéra',
        outcome: 'succeeded',
      });
      const notice = publishMemberNotice.mock.calls[0][0];
      expect(notice.reason).toBeUndefined();
    });

    it('skips the idempotent re-add when the theater is already selected', async () => {
      vi.mocked(getPendingSubmissionByReport).mockResolvedValue(pendingSubmission);
      vi.mocked(getScrapeReport).mockResolvedValue({ id: 42, status: 'success', trigger_type: 'manual', started_at: '' });
      vi.mocked(isTheaterSelected).mockResolvedValue(true);

      const result = await service.resolveReport(42);

      expect(result?.outcome).toBe('succeeded');
      expect(getSelectionCount).not.toHaveBeenCalled();
      expect(insertSelection).not.toHaveBeenCalled();
    });

    it('on failure: writes failed, never touches the Selection, notice carries the sanitized reason only', async () => {
      vi.mocked(getPendingSubmissionByReport).mockResolvedValue(pendingSubmission);
      vi.mocked(getScrapeReport).mockResolvedValue({
        id: 42,
        status: 'failed',
        trigger_type: 'manual',
        started_at: '',
        errors: [{ theater_name: 'System', error: 'HTTP 503 from upstream' }],
      });

      const result = await service.resolveReport(42);

      expect(result?.outcome).toBe('failed');
      expect(resolveSubmission).toHaveBeenCalledWith(tx, 9, 'failed');
      expect(lockMemberForSelection).not.toHaveBeenCalled();
      expect(insertSelection).not.toHaveBeenCalled();

      const notice = publishMemberNotice.mock.calls[0][0] as Record<string, unknown>;
      expect(notice.outcome).toBe('failed');
      expect(notice.reason).toBe('Source injoignable');
      const wire = JSON.stringify(notice);
      expect(wire).not.toContain('503');
      expect(wire).not.toContain('HTTP');
      expect(wire).not.toContain('upstream');
    });

    it('a success whose theater never went active resolves as failed', async () => {
      vi.mocked(getPendingSubmissionByReport).mockResolvedValue(pendingSubmission);
      vi.mocked(getScrapeReport).mockResolvedValue({ id: 42, status: 'success', trigger_type: 'manual', started_at: '' });
      vi.mocked(getTheaterById).mockResolvedValue({ id: 'C0013', name: 'C0013', status: 'provisioning' as const });

      const result = await service.resolveReport(42);

      expect(result?.outcome).toBe('failed');
      expect(resolveSubmission).toHaveBeenCalledWith(tx, 9, 'failed');
      expect(insertSelection).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });

    it('a full Selection yields succeeded_selection_full: no auto-add, row still succeeded', async () => {
      vi.mocked(getPendingSubmissionByReport).mockResolvedValue(pendingSubmission);
      vi.mocked(getScrapeReport).mockResolvedValue({ id: 42, status: 'success', trigger_type: 'manual', started_at: '' });
      vi.mocked(getSelectionCount).mockResolvedValue(2);

      const result = await service.resolveReport(42);

      expect(result?.outcome).toBe('succeeded_selection_full');
      expect(resolveSubmission).toHaveBeenCalledWith(tx, 9, 'succeeded');
      expect(insertSelection).not.toHaveBeenCalled();
      expect(publishMemberNotice).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'succeeded_selection_full', theaterName: 'UGC Opéra' }),
      );
    });
  });

  describe('idempotence', () => {
    it('a lost pending-guard race publishes nothing and inserts nothing', async () => {
      vi.mocked(getPendingSubmissionByReport).mockResolvedValue(pendingSubmission);
      vi.mocked(getScrapeReport).mockResolvedValue({ id: 42, status: 'success', trigger_type: 'manual', started_at: '' });
      vi.mocked(resolveSubmission).mockResolvedValue(undefined);

      await expect(service.resolveReport(42)).resolves.toBeNull();

      expect(lockMemberForSelection).not.toHaveBeenCalled();
      expect(insertSelection).not.toHaveBeenCalled();
      expect(publishMemberNotice).not.toHaveBeenCalled();
    });
  });

  describe('reconcilePendingSubmissions', () => {
    it('runs the same routine for pending submissions with a terminal report', async () => {
      vi.mocked(getResolvablePendingSubmissions).mockResolvedValue([
        { ...pendingSubmission, id: 9, report_status: 'success' as const },
        { ...pendingSubmission, id: 10, member_id: 8, theater_id: 'C0099', report_status: 'failed' as const },
      ]);
      vi.mocked(resolveSubmission).mockImplementation(async (_db, id, status) => ({
        ...pendingSubmission,
        id,
        member_id: id === 10 ? 8 : 7,
        theater_id: id === 10 ? 'C0099' : 'C0013',
        status,
      }));

      await expect(service.reconcilePendingSubmissions()).resolves.toBe(2);

      expect(resolveSubmission).toHaveBeenCalledWith(tx, 9, 'succeeded');
      expect(resolveSubmission).toHaveBeenCalledWith(tx, 10, 'failed');
      expect(insertSelection).toHaveBeenCalledTimes(1);
      expect(publishMemberNotice).toHaveBeenCalledTimes(2);
      expect(publishMemberNotice).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ submissionId: 9, outcome: 'succeeded' }),
      );
      expect(publishMemberNotice).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ submissionId: 10, outcome: 'failed', reason: 'Source injoignable' }),
      );
    });

    it('does not count a submission another resolver already handled', async () => {
      vi.mocked(getResolvablePendingSubmissions).mockResolvedValue([
        { ...pendingSubmission, id: 9, report_status: 'success' as const },
      ]);
      vi.mocked(resolveSubmission).mockResolvedValue(undefined);

      await expect(service.reconcilePendingSubmissions()).resolves.toBe(0);
      expect(publishMemberNotice).not.toHaveBeenCalled();
    });

    it('keeps sweeping past an individual failure', async () => {
      vi.mocked(getResolvablePendingSubmissions).mockResolvedValue([
        { ...pendingSubmission, id: 9, report_status: 'success' as const },
        { ...pendingSubmission, id: 10, member_id: 8, theater_id: 'C0099', report_status: 'success' as const },
      ]);
      vi.mocked(getTheaterById).mockRejectedValueOnce(new Error('db glitch'));
      vi.mocked(resolveSubmission).mockImplementation(async (_db, id, status) => ({
        ...pendingSubmission,
        id,
        member_id: id === 10 ? 8 : 7,
        theater_id: id === 10 ? 'C0099' : 'C0013',
        status,
      }));

      await expect(service.reconcilePendingSubmissions()).resolves.toBe(1);
      expect(publishMemberNotice).toHaveBeenCalledTimes(1);
    });
  });

  describe('onProgressEvent', () => {
    it('resolves on a terminal completed event carrying the reportId', async () => {
      const spy = vi.spyOn(service, 'resolveReport').mockResolvedValue(null);

      service.onProgressEvent({ type: 'completed', summary: {} as never, reportId: 42 });
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(42));
    });

    it('resolves on a terminal failed event carrying the reportId', async () => {
      const spy = vi.spyOn(service, 'resolveReport').mockResolvedValue(null);

      service.onProgressEvent({ type: 'failed', error: 'boom', reportId: 43 });
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(43));
    });

    it('ignores non-terminal events and terminal events without a reportId', async () => {
      const spy = vi.spyOn(service, 'resolveReport');

      service.onProgressEvent({ type: 'started', total_theaters: 1, total_dates: 1 });
      service.onProgressEvent({ type: 'theater_started', theater_name: 'X', theater_id: 'C1', index: 1 });
      service.onProgressEvent({ type: 'completed', summary: {} as never });

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('swallows resolution errors instead of surfacing them to the progress fan-out', async () => {
      vi.spyOn(service, 'resolveReport').mockRejectedValue(new Error('boom'));

      service.onProgressEvent({ type: 'completed', summary: {} as never, reportId: 42 });
      await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    });
  });
});
