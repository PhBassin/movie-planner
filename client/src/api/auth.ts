import apiClient from './core.js';
import type { ApiResponse } from '../types/index.js';

/** The public shape returned by `POST /auth/signup` for a new Member. */
export interface MemberSignupResponse {
  id: number;
  username: string;
  email: string;
  role_id: number;
  role_name: string;
  status: string;
}

/**
 * Register a new Member account (public route, no auth). The account starts
 * `unverified`; the Member obtains a session by logging in. Throws `ApiError`
 * (see `api/core`) with the server's sanitized message on rejection.
 */
export async function signup(email: string, password: string): Promise<MemberSignupResponse> {
  const response = await apiClient.post<ApiResponse<{ user: MemberSignupResponse }>>(
    '/auth/signup',
    { email, password },
  );

  if (!response.data) {
    throw new Error('Signup failed');
  }

  return response.data.user;
}
