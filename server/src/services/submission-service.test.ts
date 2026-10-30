import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../db/index.js';
import { SubmissionService, toMemberSubmissionView } from './submission-service.js';
import {
  countNewSubmissionsSince,
  countSubmissionAttempts,
  getMemberForSubmission,
  insertSubmission,
  listMemberSubmissionsByTheater,
  lockMemberForSubmission,
  lockTheaterForSubmission,
} from '../db/submission-queries.js';
import { addTheater, getTheaterById } from '../db/theater-queries.js';
import { createScrapeReport } from '../db/report-queries.js';
import { getBusProducer } from './bus-producer.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { cleanTheaterUrl, extractTheaterIdFromUrl, isValidAllocineUrl } from '../utils/url.js';

const mockSelectionAdd = vi.fn();

vi.mock('../db/submission-queries.js', () => ({
  lockMemberForSubmission: vi.fn(),
  getMemberForSubmission: vi.fn(),
  countNewSubmissionsSince: vi.fn(),
  insertSubmission: vi.fn(),
  lockTheaterForSubmission: vi.fn(),
  countSubmissionAttempts: vi.fn(),
  listMemberSubmissionsByTheater: vi.fn(),
}));

vi.mock('../db/theater-queries.js', () => ({
  addTheater: vi.fn(),
  getTheaterById: vi.fn(),
}));

vi.mock('../db/report-queries.js', () => ({
  createScrapeReport: vi.fn(),
}));

vi.mock('./bus-producer.js', () => ({
  getBusProducer: vi.fn(),
}));

vi.mock('./selection-service.js', () => ({
  SelectionService: class {
    add = mockSelectionAdd;
  },
}));

vi.mock('../utils/url.js', () => ({
  isValidAllocineUrl: vi.fn(() => true),
  extractTheaterIdFromUrl: vi.fn(() => 'C0013'),
  cleanTheaterUrl: vi.fn(() => 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html'),
}));

const verifiedMember = { id: 7, role_name: 'member', status: 'active', email_verified_at: '2024-01-01T00:00:00Z' };
const unverifiedMember = { id: 7, role_name: 'member', status: 'unverified', email_verified_at: null };
const suspendedMember = { id: 7, role_name: 'member', status: 'suspended', email_verified_at: '2024-01-01T00:00:00Z' };
const activeTheater = { id: 'C0013', name: 'UGC Opéra', status: 'active' as const };

describe('SubmissionService.submit', () => {
  const transactionDb = {} as DB;
  const db = {
    transaction: vi.fn(async (callback: (tx: DB) => Promise<unknown>) => callback(transactionDb)),
  } as unknown as DB;
  let service: SubmissionService;
  const enqueueAddTheaterJob = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SubmissionService(db);
    vi.mocked(isValidAllocineUrl).mockReturnValue(true);
    vi.mocked(extractTheaterIdFromUrl).mockReturnValue('C0013');
    vi.mocked(cleanTheaterUrl).mockReturnValue('https://www.allocine.fr/seance/salle_gen_csalle=C0013.html');
    vi.mocked(lockMemberForSubmission).mockResolvedValue(verifiedMember);
    vi.mocked(getMemberForSubmission).mockResolvedValue(verifiedMember);
    vi.mocked(getTheaterById).mockResolvedValue(undefined);
    vi.mocked(countNewSubmissionsSince).mockResolvedValue(0);
    vi.mocked(lockTheaterForSubmission).mockResolvedValue(undefined);
    vi.mocked(countSubmissionAttempts).mockResolvedValue({ total: 0, pending: 0 });
    vi.mocked(getBusProducer).mockReturnValue({ enqueueAddTheaterJob } as never);
  });

  afterEach(() => {
    delete process.env.SUBMISSION_THROTTLE_MAX;
    delete process.env.SUBMISSION_THROTTLE_WINDOW_MS;
  });

  it('rejects an invalid (non-allocine) URL', async () => {
    vi.mocked(isValidAllocineUrl).mockReturnValue(false);

    await expect(service.submit(7, 'https://bad.example')).rejects.toBeInstanceOf(ValidationError);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects a URL from which no theater id can be extracted', async () => {
    vi.mocked(extractTheaterIdFromUrl).mockReturnValue(null);

    await expect(service.submit(7, 'https://www.allocine.fr/nothing')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an empty or over-long URL before any DB work', async () => {
    await expect(service.submit(7, '')).rejects.toBeInstanceOf(ValidationError);
    await expect(service.submit(7, 'https://www.allocine.fr/'.padEnd(2049, 'x'))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('degrades an active-theater URL to a Selection add without scraping', async () => {
    vi.mocked(getTheaterById).mockResolvedValue(activeTheater);
    mockSelectionAdd.mockResolvedValue(activeTheater);

    const result = await service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html');

    expect(result).toEqual({ outcome: 'selection_added', theater: activeTheater });
    expect(mockSelectionAdd).toHaveBeenCalledWith(7, 'C0013');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(addTheater).not.toHaveBeenCalled();
    expect(createScrapeReport).not.toHaveBeenCalled();
    expect(enqueueAddTheaterJob).not.toHaveBeenCalled();
    expect(insertSubmission).not.toHaveBeenCalled();
  });

  describe('retry of a provisioning Theater (ADR 0010)', () => {
    const url = 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html';
    const storedUrl = 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html?corrected';
    const provisioningRow = { id: 'C0013', url: storedUrl, status: 'provisioning' as const };

    beforeEach(() => {
      vi.mocked(getTheaterById).mockResolvedValue({ id: 'C0013', name: 'C0013', status: 'provisioning' });
      vi.mocked(lockTheaterForSubmission).mockResolvedValue(provisioningRow);
    });

    it('rejects while an attempt is still pending (no duplicate, no scrape)', async () => {
      vi.mocked(countSubmissionAttempts).mockResolvedValue({ total: 1, pending: 1 });

      await expect(service.submit(7, url)).rejects.toEqual(expect.objectContaining({ statusCode: 409 }));
      expect(lockTheaterForSubmission).toHaveBeenCalledWith(transactionDb, 'C0013');
      expect(addTheater).not.toHaveBeenCalled();
      expect(createScrapeReport).not.toHaveBeenCalled();
      expect(insertSubmission).not.toHaveBeenCalled();
    });

    it('rejects a Staff-introduced provisioning Theater that has no submission attempt', async () => {
      vi.mocked(countSubmissionAttempts).mockResolvedValue({ total: 0, pending: 0 });

      await expect(service.submit(7, url)).rejects.toEqual(expect.objectContaining({ statusCode: 409 }));
      expect(createScrapeReport).not.toHaveBeenCalled();
    });

    it('degrades to a Selection add when the Theater went active under the lock (raced the fast path)', async () => {
      vi.mocked(lockTheaterForSubmission).mockResolvedValue({ id: 'C0013', url: storedUrl, status: 'active' });
      mockSelectionAdd.mockResolvedValue(activeTheater);

      const result = await service.submit(7, url);

      expect(result).toEqual({ outcome: 'selection_added', theater: activeTheater });
      expect(mockSelectionAdd).toHaveBeenCalledWith(7, 'C0013');
      expect(countSubmissionAttempts).not.toHaveBeenCalled();
      expect(createScrapeReport).not.toHaveBeenCalled();
      expect(insertSubmission).not.toHaveBeenCalled();
    });

    it('re-enqueues add_theater on the existing row (its stored URL) and inserts a new pending attempt', async () => {
      vi.mocked(countSubmissionAttempts).mockResolvedValue({ total: 2, pending: 0 });
      vi.mocked(createScrapeReport).mockResolvedValue(43);
      enqueueAddTheaterJob.mockResolvedValue(1);
      vi.mocked(insertSubmission).mockResolvedValue({
        id: 10,
        member_id: 7,
        url,
        theater_id: 'C0013',
        status: 'pending',
        report_id: 43,
        created_at: '2024-01-02T00:00:00Z',
        resolved_at: null,
      });

      const result = await service.submit(7, url);

      expect(result).toEqual({ outcome: 'submitted', submission: expect.objectContaining({ id: 10, report_id: 43 }) });
      expect(addTheater).not.toHaveBeenCalled();
      expect(createScrapeReport).toHaveBeenCalledWith(transactionDb, 'manual');
      expect(enqueueAddTheaterJob).toHaveBeenCalledWith(43, storedUrl, transactionDb);
      expect(insertSubmission).toHaveBeenCalledWith(transactionDb, {
        memberId: 7,
        url,
        theaterId: 'C0013',
        reportId: 43,
      });
    });

    it('counts a retry toward the per-Member throttle', async () => {
      vi.mocked(countSubmissionAttempts).mockResolvedValue({ total: 1, pending: 0 });
      vi.mocked(countNewSubmissionsSince).mockResolvedValue(3);

      await expect(service.submit(7, url)).rejects.toEqual(
        expect.objectContaining({ statusCode: 429, message: expect.stringContaining('retries included') }),
      );
      expect(createScrapeReport).not.toHaveBeenCalled();
      expect(enqueueAddTheaterJob).not.toHaveBeenCalled();
    });

    it('still requires a verified Member to retry', async () => {
      vi.mocked(getMemberForSubmission).mockResolvedValue(unverifiedMember);
      vi.mocked(lockMemberForSubmission).mockResolvedValue(unverifiedMember);
      vi.mocked(countSubmissionAttempts).mockResolvedValue({ total: 1, pending: 0 });

      await expect(service.submit(7, url)).rejects.toEqual(expect.objectContaining({ statusCode: 403 }));
      expect(lockTheaterForSubmission).not.toHaveBeenCalled();
      expect(createScrapeReport).not.toHaveBeenCalled();
    });
  });

  it('blocks an unverified Member from a genuinely-new submission with a verification message', async () => {
    vi.mocked(getMemberForSubmission).mockResolvedValue(unverifiedMember);
    vi.mocked(lockMemberForSubmission).mockResolvedValue(unverifiedMember);

    await expect(service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html')).rejects.toEqual(
      expect.objectContaining({ statusCode: 403, message: expect.stringContaining('verify your email') }),
    );
    expect(addTheater).not.toHaveBeenCalled();
  });

  it('lets an unverified Member still dedup an existing cinema into their Selection', async () => {
    vi.mocked(getMemberForSubmission).mockResolvedValue(unverifiedMember);
    vi.mocked(getTheaterById).mockResolvedValue(activeTheater);
    mockSelectionAdd.mockResolvedValue(activeTheater);

    const result = await service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html');

    expect(result).toEqual({ outcome: 'selection_added', theater: activeTheater });
    expect(mockSelectionAdd).toHaveBeenCalledWith(7, 'C0013');
  });

  it('blocks a suspended Member at the pre-gate, even from the Selection-add downgrade', async () => {
    vi.mocked(getMemberForSubmission).mockResolvedValue(suspendedMember);
    vi.mocked(getTheaterById).mockResolvedValue(activeTheater);

    await expect(service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(mockSelectionAdd).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects Staff accounts in defense of the route-level gate', async () => {
    vi.mocked(getMemberForSubmission).mockResolvedValue({
      id: 1,
      role_name: 'admin',
      status: 'active',
      email_verified_at: '2024-01-01T00:00:00Z',
    });

    await expect(service.submit(1, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('throws NotFoundError when the Member no longer exists', async () => {
    vi.mocked(getMemberForSubmission).mockResolvedValue(undefined);

    await expect(service.submit(999, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rejects the N+1th new-cinema submission within the window (env-tunable threshold)', async () => {
    process.env.SUBMISSION_THROTTLE_MAX = '2';
    vi.mocked(countNewSubmissionsSince).mockResolvedValue(2);

    await expect(service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html')).rejects.toEqual(
      expect.objectContaining({ statusCode: 429, message: expect.stringContaining('2') }),
    );
    expect(addTheater).not.toHaveBeenCalled();
    expect(createScrapeReport).not.toHaveBeenCalled();
    expect(enqueueAddTheaterJob).not.toHaveBeenCalled();
  });

  it('creates a provisioning Theater, enqueues add_theater, and inserts a pending row', async () => {
    vi.mocked(addTheater).mockResolvedValue({
      id: 'C0013',
      name: 'C0013',
      url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html',
      status: 'provisioning',
    });
    vi.mocked(createScrapeReport).mockResolvedValue(42);
    enqueueAddTheaterJob.mockResolvedValue(1);
    vi.mocked(insertSubmission).mockResolvedValue({
      id: 9,
      member_id: 7,
      url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html',
      theater_id: 'C0013',
      status: 'pending',
      report_id: 42,
      created_at: '2024-01-01T00:00:00Z',
      resolved_at: null,
    });

    const result = await service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html');

    expect(result.outcome).toBe('submitted');
    expect(addTheater).toHaveBeenCalledWith(transactionDb, {
      id: 'C0013',
      name: 'C0013',
      url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html',
    });
    expect(createScrapeReport).toHaveBeenCalledWith(transactionDb, 'manual');
    expect(enqueueAddTheaterJob).toHaveBeenCalledWith(
      42,
      'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html',
      transactionDb,
    );
    expect(insertSubmission).toHaveBeenCalledWith(transactionDb, {
      memberId: 7,
      url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html',
      theaterId: 'C0013',
      reportId: 42,
    });
  });

  it('translates a concurrent duplicate-key Theater insert into a conflict', async () => {
    vi.mocked(addTheater).mockRejectedValue(Object.assign(new Error('duplicate key value'), { code: '23505' }));

    await expect(service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html')).rejects.toEqual(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(createScrapeReport).not.toHaveBeenCalled();
    expect(insertSubmission).not.toHaveBeenCalled();
  });

  it('recognizes a duplicate-key error without a pg error code', async () => {
    vi.mocked(addTheater).mockRejectedValue(new Error('duplicate key value violates unique constraint'));

    await expect(service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html')).rejects.toEqual(
      expect.objectContaining({ statusCode: 409 }),
    );
  });

  it('re-throws a non-duplicate error unchanged', async () => {
    const boom = new Error('boom');
    vi.mocked(addTheater).mockRejectedValue(boom);

    await expect(service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html')).rejects.toBe(boom);
  });
});

describe('Mes soumissions view', () => {
  const baseRow = {
    id: 9,
    url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html',
    status: 'pending' as const,
    created_at: '2026-01-01T00:00:00Z',
    resolved_at: null,
    attempts: 1,
    theater_id: 'C0013',
    theater_status: 'provisioning' as const,
    theater_name: 'C0013',
    theater_city: null,
    in_selection: false,
    remembered: false,
  };

  it('never exposes a provisioning Theater placeholder name', () => {
    const view = toMemberSubmissionView(baseRow);

    expect(view.theater).toEqual({ id: 'C0013', status: 'provisioning' });
    expect(view).not.toHaveProperty('in_selection');
    expect(view).not.toHaveProperty('reason');
  });

  it('exposes name, city and in_selection for a succeeded active Theater', () => {
    const view = toMemberSubmissionView({
      ...baseRow,
      status: 'succeeded',
      resolved_at: '2026-01-01T00:05:00Z',
      theater_status: 'active',
      theater_name: 'UGC Opéra',
      theater_city: 'Paris',
      in_selection: true,
      attempts: 2,
    });

    expect(view.theater).toEqual({ id: 'C0013', status: 'active', name: 'UGC Opéra', city: 'Paris' });
    expect(view.in_selection).toBe(true);
    expect(view.attempts).toBe(2);
  });

  it('carries only the sanitized reason for a failed attempt', () => {
    const view = toMemberSubmissionView({ ...baseRow, status: 'failed', resolved_at: '2026-01-01T00:05:00Z' });

    expect(view.reason).toBe('Source injoignable');
    expect(view).not.toHaveProperty('in_selection');
  });

  it("exposes in_selection for a failed attempt whose Theater another Member's retry activated", () => {
    const view = toMemberSubmissionView({
      ...baseRow,
      status: 'failed',
      resolved_at: '2026-01-01T00:05:00Z',
      theater_status: 'active',
      theater_name: 'UGC Opéra',
      in_selection: false,
    });

    expect(view.in_selection).toBe(false);
    expect(view.theater).toMatchObject({ status: 'active', name: 'UGC Opéra' });
  });

  it('marks a remembered choice of an active Theater, and omits the flag otherwise', () => {
    const activeRow = { ...baseRow, status: 'succeeded' as const, theater_status: 'active' as const, theater_name: 'UGC Opéra' };

    const remembered = toMemberSubmissionView({ ...activeRow, remembered: true });
    expect(remembered.in_selection).toBe(false);
    expect(remembered.remembered).toBe(true);

    expect(toMemberSubmissionView(activeRow)).not.toHaveProperty('remembered');
    expect(toMemberSubmissionView({ ...baseRow, remembered: true })).not.toHaveProperty('remembered');
  });

  it('lists one page with its total', async () => {
    vi.mocked(listMemberSubmissionsByTheater).mockResolvedValue({ rows: [baseRow], total: 5 });
    const db = {} as DB;

    const page = await new SubmissionService(db).listForMember(7, { limit: 1, offset: 2 });

    expect(page).toEqual({ items: [toMemberSubmissionView(baseRow)], total: 5, limit: 1, offset: 2 });
    expect(listMemberSubmissionsByTheater).toHaveBeenCalledWith(db, 7, { limit: 1, offset: 2 }, { rememberedCountsAsActive: true });
  });
});
