// User types — role_id-based system (replaces old role TEXT column)

/**
 * The Member lifecycle discriminator (`users.status` — see CONTEXT.md →
 * Member). "deleted" is deliberately absent: deletion removes the row.
 * Staff rows carry 'active'.
 */
export type MemberStatus = 'unverified' | 'active' | 'suspended';

// Public user data (no password hash)
export interface UserPublic {
  id: number;
  username: string;
  role_id: number;
  role_name: string;
  created_at: string;
}
