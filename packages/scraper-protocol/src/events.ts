export interface ScheduleChangeEvent {
  action: 'created' | 'updated' | 'deleted';
  scheduleId: number;
  schedule?: {
    id: number;
    name: string;
    cron_expression: string;
    enabled: boolean;
    target_theaters?: string[] | null;
  };
}

export interface ScrapeSummary {
  total_theaters: number;
  successful_theaters: number;
  failed_theaters: number;
  total_movies: number;
  total_showtimes: number;
  total_dates: number;
  duration_ms: number;
  errors: Array<{
    theater_name: string;
    theater_id: string;
    date?: string;
    error: string;
    error_type?: 'http_429' | 'http_5xx' | 'http_4xx' | 'network' | 'parse' | 'timeout';
    http_status_code?: number;
  }>;
  status?: 'success' | 'partial_success' | 'failed' | 'rate_limited';
}

export type ProgressEvent =
  | { type: 'started'; total_theaters: number; total_dates: number }
  | { type: 'theater_started'; theater_name: string; theater_id: string; index: number }
  | { type: 'date_started'; date: string; theater_name: string }
  | { type: 'date_stale'; date: string; theater_name: string; actual_date: string }
  | { type: 'date_failed'; date: string; theater_name: string; error: string }
  | { type: 'movie_started'; movie_title: string; movie_id: number }
  | { type: 'movie_completed'; movie_title: string; showtimes_count: number }
  | { type: 'movie_failed'; movie_title: string; error: string }
  | { type: 'date_completed'; date: string; movies_count: number }
  | { type: 'theater_completed'; theater_name: string; total_movies: number }
  | { type: 'theater_failed'; theater_name: string; error: string }
  | { type: 'completed'; summary: ScrapeSummary; reportId?: number }
  | { type: 'failed'; error: string; reportId?: number };

/**
 * Member-domain outcome notice (ADR 0005) published on the PostgreSQL
 * `member:notices` channel when a TheaterSubmission resolves. Durability lives
 * in the `theater_submissions` row; this payload is the transient push routed
 * by `memberId` to the Member's live SSE connections on `/api/me/notifications`.
 *
 * `reason` is set only on `failed` and is sanitized Member-facing copy — never
 * the scrape error type or HTTP status. `theaterId` is the shared catalog's
 * TEXT id (e.g. `C0013`).
 */
export type MemberNoticeOutcome = 'succeeded' | 'succeeded_selection_full' | 'failed';

export interface MemberNotice {
  type: 'submission_resolved';
  /** Routing key — the submitter's user id; never sent to other Members. */
  memberId: number;
  submissionId: number;
  theaterId: string;
  theaterName: string;
  outcome: MemberNoticeOutcome;
  reason?: string;
}
