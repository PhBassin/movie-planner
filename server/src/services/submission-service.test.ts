import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../db/index.js';
import { SubmissionService } from './submission-service.js';
import {
  countNewSubmissionsSince,
  getMemberForSubmission,
  insertSubmission,
  lockMemberForSubmission,
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

  it('rejects a URL whose theater is still provisioning (no duplicate, no scrape)', async () => {
    vi.mocked(getTheaterById).mockResolvedValue({ id: 'C0013', name: 'C0013', status: 'provisioning' });

    await expect(service.submit(7, 'https://www.allocine.fr/seance/salle_gen_csalle=C0013.html')).rejects.toEqual(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(addTheater).not.toHaveBeenCalled();
    expect(createScrapeReport).not.toHaveBeenCalled();
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
