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
  | { type: 'completed'; summary: ScrapeSummary }
  | { type: 'failed'; error: string };
