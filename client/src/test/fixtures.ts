import type { MemberProfile } from '../api/me.js';

/**
 * Shared test fixture: a verified active Member profile with a configurable
 * Appearance (the only Member-owned visual preference).
 */
export function memberProfileFixture(appearance: MemberProfile['appearance']): MemberProfile {
  return {
    id: 7,
    email: 'jane@example.com',
    username: 'jane@example.com',
    role_name: 'member',
    status: 'active',
    email_verified: true,
    appearance,
    selectionCount: 0,
    selectionLimit: 50,
    created_at: '2024-01-01T00:00:00Z',
  };
}
