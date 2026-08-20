import type { DB } from '../db/index.js';
import {
  countNewSubmissionsSince,
  getMemberForSubmission,
  getTheaterById,
  insertSubmission,
  lockMemberForSubmission,
  type SubmissionMemberRow,
  type TheaterSubmissionRow,
} from '../db/submission-queries.js';
import { addTheater } from '../db/theater-queries.js';
import { createScrapeReport } from '../db/report-queries.js';
import { getBusProducer } from './bus-producer.js';
import { SelectionService } from './selection-service.js';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { MEMBER_ONLY_ENDPOINT_MESSAGE } from '../types/role.js';
import { cleanTheaterUrl, extractTheaterIdFromUrl, isValidAllocineUrl } from '../utils/url.js';
import { parseStrictInt } from '../utils/number.js';
import type { Theater } from '../types/scraper.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// TheaterSubmission create (issue #62): the synchronous half of a Member
// introducing a new cinema. The three proactive abuse controls — verification
// gate, URL dedup, per-Member throttle — all resolve here in the POST response;
// the async resolution (succeeded/failed) is the resolver's job (issue #63).
// ---------------------------------------------------------------------------

const THEATER_URL_MAX_LENGTH = 2048;

/** Per-Member new-cinema submission throttle (ADR 0003), env-tunable. */
const DEFAULT_SUBMISSION_THROTTLE_MAX = 3;
const DEFAULT_SUBMISSION_THROTTLE_WINDOW_MS = 60 * 60 * 1000;

function readPositiveEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseStrictInt(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function submissionThrottleMax(): number {
  return readPositiveEnvInt('SUBMISSION_THROTTLE_MAX', DEFAULT_SUBMISSION_THROTTLE_MAX);
}

function submissionThrottleWindowMs(): number {
  return readPositiveEnvInt('SUBMISSION_THROTTLE_WINDOW_MS', DEFAULT_SUBMISSION_THROTTLE_WINDOW_MS);
}

function validateSubmissionUrl(url: string): void {
  if (typeof url !== 'string' || !url || url.length > THEATER_URL_MAX_LENGTH) {
    throw new ValidationError('URL must be a string between 1 and 2048 characters');
  }
  if (!isValidAllocineUrl(url)) {
    throw new ValidationError('Invalid Allocine URL. Must be https://www.allocine.fr/...');
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  if (error instanceof Error) {
    return (error as Error & { code?: string }).code === '23505' || error.message.includes('duplicate key');
  }
  return false;
}

/**
 * The role + suspension gate shared by the read-only pre-gate and the
 * authoritative in-transaction check. Verification is checked separately:
 * selecting is open to unverified Members, submitting is verified-only.
 */
function assertMemberEligible(member: SubmissionMemberRow): void {
  if (member.role_name !== 'member') {
    throw new ForbiddenError(MEMBER_ONLY_ENDPOINT_MESSAGE);
  }
  if (member.status === 'suspended') {
    throw new ForbiddenError('This account is suspended');
  }
}

/** The synchronous outcome of `submit`: a dedup Selection add or a queued submission. */
export type SubmitResult =
  | { outcome: 'selection_added'; theater: Theater }
  | { outcome: 'submitted'; submission: TheaterSubmissionRow };

export class SubmissionService {
  constructor(private readonly db: DB) {}

  async submit(memberId: number, url: string): Promise<SubmitResult> {
    validateSubmissionUrl(url);

    const theaterId = extractTheaterIdFromUrl(url);
    if (!theaterId) {
      throw new ValidationError(
        'Could not extract theater ID from URL. URL format should be like https://www.allocine.fr/seance/salle_gen_csalle=C0013.html',
      );
    }
    const cleanedUrl = cleanTheaterUrl(url);

    // Pre-gate (read-only): role + suspension before the dedup fast path, so a
    // suspended Member with a stale token cannot reach even the Selection-add
    // downgrade. Selecting is open to unverified Members (the verification gate
    // below applies only to genuinely-new submissions), so verification is NOT
    // checked here.
    const gate = await getMemberForSubmission(this.db, memberId);
    if (!gate) {
      throw new NotFoundError('Member not found');
    }
    assertMemberEligible(gate);

    // Dedup fast path (read-only): a URL matching an active Theater degrades to
    // a Selection add — no new row, no scrape. Delegating to SelectionService
    // keeps the cap check (409 when full) and idempotency in one place, and
    // avoids holding the Member lock while the Selection transaction runs.
    const existing = await getTheaterById(this.db, theaterId);
    if (existing?.status === 'active') {
      const theater = await new SelectionService(this.db).add(memberId, theaterId);
      return { outcome: 'selection_added', theater };
    }

    return this.db.transaction(async (transaction) => {
      const tx = transaction as DB;

      // Authoritative re-check under the Member lock: closes the race between
      // the read-only pre-gate and this transaction, and applies the
      // verification gate (verified-only submission).
      const member = await lockMemberForSubmission(tx, memberId);
      if (!member) {
        throw new NotFoundError('Member not found');
      }
      assertMemberEligible(member);
      if (member.email_verified_at === null) {
        throw new ForbiddenError('You must verify your email before submitting a cinema');
      }

      // A provisioning Theater already exists for this id (someone is already
      // introducing it, or a prior attempt is still pending): never duplicate
      // the row or the scrape.
      const provisioning = await getTheaterById(tx, theaterId);
      if (provisioning) {
        throw new AppError('This cinema is already being added to the catalog', 409);
      }

      // Throttle: only genuinely-new cinemas count — dedup never creates a row.
      const max = submissionThrottleMax();
      const windowMs = submissionThrottleWindowMs();
      const recent = await countNewSubmissionsSince(tx, memberId, new Date(Date.now() - windowMs));
      if (recent >= max) {
        throw new AppError(
          `You have reached the limit of ${max} new cinema submissions. Please wait before submitting another cinema.`,
          429,
        );
      }

      // Immediate scrape: provisioning Theater + add_theater job + pending row,
      // all atomic so the catalog write, report, queue insert, and submission
      // can never be observed half-done.
      let reportId: number;
      try {
        await addTheater(tx, { id: theaterId, name: theaterId, url: cleanedUrl });
        reportId = await createScrapeReport(tx, 'manual');
        await getBusProducer().enqueueAddTheaterJob(reportId, cleanedUrl, transaction);
      } catch (error) {
        // A concurrent submitter raced the fast-path dedup read above: the
        // Theater now exists, so degrade to a conflict rather than duplicating.
        if (isDuplicateKeyError(error)) {
          throw new AppError('This cinema is already being added to the catalog', 409);
        }
        throw error;
      }

      const submission = await insertSubmission(tx, {
        memberId,
        url: cleanedUrl,
        theaterId,
        reportId,
      });

      logger.info(
        `🎬 member submission queued for ${cleanedUrl} (theater=${theaterId}, reportId=${reportId})`,
      );
      return { outcome: 'submitted', submission };
    });
  }
}
