// User types — role_id-based system (replaces old role TEXT column)

/**
 * The Member lifecycle discriminator (`users.status` — see CONTEXT.md →
 * Member). "deleted" is deliberately absent: deletion removes the row.
 * Staff rows carry 'active'.
 */
export type MemberStatus = 'unverified' | 'active' | 'suspended';

/**
 * A Member's Appearance (see CONTEXT.md → Appearance): the light/dark flag
 * stored in `member_preferences`. The only visual control a Member owns.
 */
export const APPEARANCES = ['light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

export function isAppearance(value: unknown): value is Appearance {
  return typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value);
}

// Public user data (no password hash)
export interface UserPublic {
  id: number;
  username: string;
  role_id: number;
  role_name: string;
  created_at: string;
}
