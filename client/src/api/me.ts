import apiClient from './core.js';
import type { ApiResponse, Theater, MemberNotice } from '../types/index.js';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export interface MemberProfile {
  id: number;
  email: string;
  username: string;
  role_name: string;
  status: 'unverified' | 'active' | 'suspended';
  email_verified: boolean;
  appearance: 'light' | 'dark';
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
