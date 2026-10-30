import apiClient from './core';
import type { ApiResponse } from '../types';

// ============================================================================
// MEMBER ADMIN TYPES (issue #65) — the wire shape of /api/members
// ============================================================================

/** Mirror of `MemberStatus` from the server (`users.status`). */
export type MemberStatus = 'unverified' | 'active' | 'suspended';

/**
 * The admin-facing Member view: identity + lifecycle + Member-owned data
 * counts. No credentials.
 */
export interface MemberAdminView {
  id: number;
  username: string;
  email: string;
  role_name: string;
  status: MemberStatus;
  email_verified_at: string | null;
  appearance: 'light' | 'dark';
  /** Every stored Selection choice, active and remembered together. */
  selection_count: number;
  /** The remembered part of `selection_count` (always 0 while billing is disabled). */
  remembered_selection_count: number;
  submission_count: number;
  created_at: string;
}

// ============================================================================
// MEMBERS API FUNCTIONS (admin only — members:* permissions)
// ============================================================================

/**
 * List Members (newest first).
 * @param params Optional pagination parameters
 */
export async function getMembers(params?: {
  limit?: number;
  offset?: number;
}): Promise<MemberAdminView[]> {
  const response = await apiClient.get<ApiResponse<MemberAdminView[]>>('/members', {
    ...params,
  });

  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to fetch members');
  }

  return response.data;
}

/**
 * Get one Member by ID. Missing Members and Staff ids are both a 404.
 * @param id Member ID
 */
export async function getMemberById(id: number): Promise<MemberAdminView> {
  const response = await apiClient.get<ApiResponse<MemberAdminView>>(`/members/${id}`);

  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to fetch member');
  }

  return response.data;
}

/**
 * Suspend a Member (admin only): blocks login and revokes all their
 * Sessions at once. Only active Members can be suspended.
 * @param id Member ID
 * @returns The updated Member (status: 'suspended')
 */
export async function suspendMember(id: number): Promise<MemberAdminView> {
  const response = await apiClient.post<ApiResponse<MemberAdminView>>(`/members/${id}/suspend`);

  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to suspend member');
  }

  return response.data;
}

/**
 * Reinstate a suspended Member (admin only): back to 'active' with their
 * Selection, Appearance and submissions intact.
 * @param id Member ID
 * @returns The updated Member (status: 'active')
 */
export async function reinstateMember(id: number): Promise<MemberAdminView> {
  const response = await apiClient.post<ApiResponse<MemberAdminView>>(`/members/${id}/reinstate`);

  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to reinstate member');
  }

  return response.data;
}

/**
 * Delete a Member (admin only): removes the account and cascaded
 * Member-owned data. Theaters they introduced stay in the catalog (ADR 0004).
 * @param id Member ID
 */
export async function deleteMember(id: number): Promise<void> {
  // 204 No Content: there is no envelope to inspect. Failures surface as
  // ApiError from the client (non-2xx), so resolving means it was deleted.
  await apiClient.delete(`/members/${id}`);
}
