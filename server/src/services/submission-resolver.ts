import type { MemberNotice, MemberNoticeOutcome, ProgressEvent } from '@movie-planner/scraper-protocol';import type { DB } from '../db/index.js';
import {
  getPendingSubmissionByReport,
  getResolvablePendingSubmissions,
  resolveSubmission as writeTerminalStatus,
  type TheaterSubmissionRow,
} from '../db/submission-queries.js';
import { getScrapeReport, type ScrapeReport } from '../db/report-queries.js';
import { getTheaterById } from '../db/theater-queries.js';
import {
  getSelectionCount,
  insertSelection,
  isTheaterSelected,
  lockMemberForSelection,
} from '../db/selection-queries.js';
import { getBusProducer } from './bus-producer.js';
import { MAX_SELECTION_SIZE } from './selection-service.js';
import { NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// TheaterSubmission resolver (issue #63, ADR 0005 sub-decisions 7 and 8).
//
// The server owns the whole terminal transition of a Member's submission: the
// scraper stays a domain-agnostic worker. On a terminal ProgressEvent whose
// `reportId` joins a `theater_submissions` row — or when reconciliation finds
// a pending row whose ScrapeReport already went terminal — one transaction
// runs, in order: (1) the submission's terminal status write (idempotent via
// `UPDATE … WHERE status = 'pending'`), (2) the Selection auto-add under the
// existing cap transaction (`SELECT … FOR UPDATE` on the Member's users row),
// then, after commit, (3) the best-effort notice publish on `member:notices`,
// so the durable facts always commit before the ephemeral push.
// ---------------------------------------------------------------------------

/** Sanitized Member-facing failure copy — never the scrape error type/status. */
const FAILED_NOTICE_REASON = 'Source injoignable';

/** Terminal ScrapeReport statuses that mean the add_theater scrape itself worked. */
const SCRAPE_OK_STATUSES = new Set(['success', 'partial_success']);

function isTerminalReportStatus(status: ScrapeReport['status']): boolean {
  return status === 'success' || status === 'partial_success' || status === 'failed';
}

export class SubmissionResolutionService {
  constructor(
    private readonly db: DB,
    private readonly producer: Pick<ReturnType<typeof getBusProducer>, 'publishMemberNotice'> = getBusProducer(),
  ) {}

  /**
   * Live path: a terminal ProgressEvent arrived from `scrape:progress`. Fires
   * the resolution routine fire-and-forget; never throws into the caller.
   */
  onProgressEvent(event: ProgressEvent): void {
    if (event.type !== 'completed' && event.type !== 'failed') return;
    if (typeof event.reportId !== 'number') return;
    const reportId = event.reportId;

    void this.resolveReport(reportId).catch((error) => {
      logger.error(`[submission-resolver] Failed to resolve report ${reportId}`, { error });
    });
  }

  /**
   * Resolve every pending submission whose ScrapeReport already went terminal.
   * Runs at server startup and on a ~60s sweep (ADR 0005 sub-decision 8);
   * idempotence lives in the `UPDATE … WHERE status = 'pending'` guard.
   * Returns the number of submissions this run resolved.
   */
  async reconcilePendingSubmissions(): Promise<number> {
    const resolvable = await getResolvablePendingSubmissions(this.db);
    let resolved = 0;
    for (const submission of resolvable) {
      const scrapeOk = SCRAPE_OK_STATUSES.has(submission.report_status);
      try {
        const result = await this.resolveSubmission(submission, scrapeOk);
        if (result) resolved++;
      } catch (error) {
        logger.error(`[submission-resolver] Reconciliation failed for submission ${submission.id}`, { error });
      }
    }
    if (resolvable.length > 0) {
      logger.info(
        `[submission-resolver] Reconciliation: ${resolved}/${resolvable.length} pending submission(s) resolved`,
      );
    }
    return resolved;
  }

  /**
   * Resolve the pending submission joined to `reportId`, if any and if the
   * report is terminal. Returns the published notice, or null when there is
   * nothing to resolve (no pending submission, or the report is still running).
   */
  async resolveReport(reportId: number): Promise<MemberNotice | null> {
    const submission = await getPendingSubmissionByReport(this.db, reportId);
    if (!submission) return null;

    const report = await getScrapeReport(this.db, reportId);
    if (!report || !isTerminalReportStatus(report.status)) return null;

    return this.resolveSubmission(submission, SCRAPE_OK_STATUSES.has(report.status));
  }

  /**
   * The single resolution routine — one transaction, in order:
   * status write → auto-add / cap-block; the notice publish follows the commit.
   * Returns null when another resolver (notification vs reconcile race, or a
   * second web instance) won the `pending` guard.
   */
  async resolveSubmission(
    submission: Pick<TheaterSubmissionRow, 'id' | 'member_id' | 'theater_id'>,
    scrapeOk: boolean,
  ): Promise<MemberNotice | null> {
    const notice = await this.db.transaction(async (transaction): Promise<MemberNotice | null> => {
      const tx = transaction;

      // The theater row must exist for the notice copy regardless of outcome,
      // and its status must be `active` before a success may auto-add. Reading
      // it inside the transaction keeps the decision consistent with the write.
      const theater = await getTheaterById(tx, submission.theater_id);
      const theaterReady = theater !== undefined && theater.status === 'active';
      const effectiveOutcome: 'succeeded' | 'failed' = scrapeOk && theaterReady ? 'succeeded' : 'failed';
      if (scrapeOk && !theaterReady) {
        logger.error(
          `[submission-resolver] Submission ${submission.id} scraped ok but theater ${submission.theater_id} is not active; resolving as failed`,
        );
      }

      // (1) Terminal status write — the idempotence guard. Losing the race
      // yields no row and aborts the rest of the routine.
      const resolved = await writeTerminalStatus(
        tx,
        submission.id,
        effectiveOutcome,
      );
      if (!resolved) return null;

      // (2) Selection auto-add under the cap transaction — only on success,
      // never on failure (a failed submission never reaches the Selection).
      if (effectiveOutcome === 'succeeded') {
        const member = await lockMemberForSelection(tx, resolved.member_id);
        if (!member) {
          throw new NotFoundError(`Member not found: ${resolved.member_id}`);
        }

        const alreadySelected = await isTheaterSelected(tx, resolved.member_id, resolved.theater_id);
        if (!alreadySelected) {
          const count = await getSelectionCount(tx, resolved.member_id);
          if (count >= MAX_SELECTION_SIZE) {
            // Cap-blocked: the scrape succeeded and the Theater is in the
            // catalog, but the Selection is full — a distinct notice outcome
            // (ADR 0005 sub-decision 6). The row stays `succeeded`.
            return this.buildNotice(resolved, 'succeeded_selection_full', theater);
          }
          await insertSelection(tx, resolved.member_id, resolved.theater_id);
        }
      }

      return this.buildNotice(resolved, effectiveOutcome, theater);
    });

    if (!notice) return null;

    // (3) Ephemeral push, only after the durable facts committed. Best-effort:
    // publishMemberNotice already swallows and logs transport failures.
    await this.producer.publishMemberNotice(notice);
    logger.info(
      `[submission-resolver] Submission ${submission.id} resolved (${notice.outcome}); notice published for member=${submission.member_id}`,
    );
    return notice;
  }

  private buildNotice(
    submission: TheaterSubmissionRow,
    outcome: MemberNoticeOutcome,
    theater: { name: string } | undefined,
  ): MemberNotice {
    return {
      type: 'submission_resolved',
      memberId: submission.member_id,
      submissionId: submission.id,
      theaterId: submission.theater_id,
      theaterName: theater?.name ?? submission.theater_id,
      outcome,
      ...(outcome === 'failed' ? { reason: FAILED_NOTICE_REASON } : {}),
    };
  }
}
