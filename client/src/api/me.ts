import apiClient from './core.js';
import type { ApiResponse, Theater, MemberNotice } from '../types/index.js';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/** A Member's Appearance (see CONTEXT.md → Appearance). */
export type Appearance = 'light' | 'dark';

export interface MemberProfile {
  id: number;
  email: string;
  username: string;
  role_name: string;
  status: 'unverified' | 'active' | 'suspended';
  email_verified: boolean;
  appearance: Appearance;
  selectionCount: number;
  selectionLimit: number;
  created_at: string;
}

export async function getMemberProfile(): Promise<MemberProfile> {
  const response = await apiClient.get<ApiResponse<{ user: MemberProfile }>>('/me');
  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to fetch member profile');
  }
  return response.data.user;
}

export async function updateAppearance(appearance: Appearance): Promise<Appearance> {
  const response = await apiClient.put<ApiResponse<{ id: number; appearance: Appearance }>>(
    '/me/appearance',
    { appearance }
  );
  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to update appearance');
  }
  return response.data.appearance;
}

export async function getSelection(): Promise<Theater[]> {
  const response = await apiClient.get<ApiResponse<Theater[]>>('/me/selection');
  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to fetch Selection');
  }
  return response.data;
}

export async function addToSelection(theaterId: string): Promise<Theater> {
  const response = await apiClient.post<ApiResponse<Theater>>(`/me/selection/${theaterId}`);
  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to add theater to Selection');
  }
  return response.data;
}

export async function removeFromSelection(theaterId: string): Promise<void> {
  await apiClient.delete(`/me/selection/${theaterId}`);
}

/**
 * The synchronous outcome of proposing a new cinema (CONTEXT.md →
 * TheaterSubmission): a dedup Selection add, or an async submission whose
 * resolution arrives later on the notifications stream.
 */
export interface PendingSubmission {
  id: number;
  status: 'pending' | 'succeeded' | 'failed';
  report_id: number;
}

export type SubmitTheaterResult =
  | { outcome: 'selection_added'; theater: Theater }
  | { outcome: 'submitted'; submission: PendingSubmission };

export async function submitTheater(url: string): Promise<SubmitTheaterResult> {
  const response = await apiClient.post<ApiResponse<{ selectionAdded?: boolean; theater?: Theater; submission?: PendingSubmission }>>(
    '/me/submissions',
    { url },
  );
  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to submit theater');
  }
  if (response.data.selectionAdded && response.data.theater) {
    return { outcome: 'selection_added', theater: response.data.theater };
  }
  if (response.data.submission) {
    return { outcome: 'submitted', submission: response.data.submission };
  }
  throw new Error('Unexpected submission response');
}

/**
 * One "Mes soumissions" item (`GET /api/me/submissions`, issue #120): the
 * latest attempt for a Theater. `name`/`city`/`in_selection` exist only for
 * an `active` Theater (a `failed` attempt's Theater may have been activated by
 * another Member's retry); `reason` only for `failed`.
 */
export interface MemberSubmission {
  id: number;
  url: string;
  status: 'pending' | 'succeeded' | 'failed';
  created_at: string;
  resolved_at: string | null;
  attempts: number;
  theater: { id: string; status: 'provisioning' | 'active'; name?: string; city?: string | null };
  in_selection?: boolean;
  reason?: string;
}

export interface MemberSubmissionPage {
  items: MemberSubmission[];
  total: number;
  limit: number;
  offset: number;
}

export async function getMemberSubmissions(page: { limit: number; offset: number }): Promise<MemberSubmissionPage> {
  const response = await apiClient.get<ApiResponse<MemberSubmissionPage>>('/me/submissions', {
    limit: page.limit,
    offset: page.offset,
  });
  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to fetch submissions');
  }
  return response.data;
}

/**
 * The Member data export document (`GET /api/me/export`, ADR 0004 → RGPD
 * Article 20): the Member's own data, never credentials.
 */
export interface MemberDataExport {
  exported_at: string;
  account: {
    email: string;
    status: MemberProfile['status'];
    email_verified_at: string | null;
    created_at: string;
  };
  appearance: Appearance;
  selection: Array<{
    theater_id: string;
    name: string;
    city: string | null;
    url: string | null;
    status: 'provisioning' | 'active';
  }>;
  submissions: Array<{
    id: number;
    url: string;
    theater_id: string;
    status: 'pending' | 'succeeded' | 'failed';
    created_at: string;
    resolved_at: string | null;
  }>;
}

export async function exportMemberData(): Promise<MemberDataExport> {
  const response = await apiClient.get<ApiResponse<MemberDataExport>>('/me/export');
  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to export your data');
  }
  return response.data;
}

/**
 * Member self-erasure (`POST /api/me/delete`, ADR 0004 → RGPD Article 17):
 * immediate and irreversible, gated by the current password. Server errors
 * (wrong password, suspended account) reject as `ApiError`.
 */
export async function deleteOwnAccount(password: string): Promise<void> {
  await apiClient.post<ApiResponse<{ message: string }>>('/me/delete', { password });
}

/**
 * Live-only SSE subscription to the Member's submission-outcome notices
 * (`GET /api/me/notifications`, ADR 0005). Auth rides the session cookie at
 * the handshake; no backlog is replayed on connect. Returns an unsubscribe.
 */
export function subscribeToMemberNotifications(
  onNotice: (notice: MemberNotice) => void,
  onError?: (error: Error) => void,
): () => void {
  const eventSource = new EventSource(`${API_BASE_URL}/me/notifications`, { withCredentials: true });

  eventSource.onmessage = (event) => {
    try {
      onNotice(JSON.parse(event.data) as MemberNotice);
    } catch (error) {
      console.error('Failed to parse member notification:', error);
    }
  };

  eventSource.onerror = () => {
    if (onError) {
      onError(new Error('Notification stream lost'));
    }
  };

  return () => {
    eventSource.close();
  };
}
