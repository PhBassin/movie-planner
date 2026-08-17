import apiClient from './core.js';
import type { ApiResponse, Theater } from '../types/index.js';

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
