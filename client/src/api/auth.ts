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

/**
 * Confirm a Member's email address with the token from the verification
 * email (the `/verify?token=...` link target). Throws `ApiError` with the
 * server's sanitized message when the token is unknown or expired.
 */
export async function verifyEmail(token: string): Promise<void> {
  await apiClient.post<ApiResponse<{ message: string }>>('/auth/verify-email', { token });
}

/**
 * Ask for a fresh verification email. Enumeration-safe on the server: the
 * response is identical whether or not the email belongs to an unverified
 * Member, so this never rejects for an unknown address.
 */
export async function resendVerification(email: string): Promise<void> {
  await apiClient.post<ApiResponse<{ message: string }>>('/auth/resend-verification', { email });
}
