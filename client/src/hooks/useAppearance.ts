import { useEffect, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AuthContext } from '../contexts/AuthContext.js';
import { getMemberProfile } from '../api/me.js';
import { ME_QUERY_KEY } from '../api/query-keys.js';
import { applyMemberAppearance, clearMemberAppearance } from '../utils/appearance.js';

/**
 * Member Appearance (light/dark) — see CONTEXT.md → Appearance. Syncs the
 * Member's persisted choice onto the document root (`html.dark`) across all
 * of the Member's pages; the dark surface then adapts the instance's
 * Branding colors (see index.css). Staff and Visitors have no Appearance:
 * the class and its local copy are removed for them (and on logout).
 *
 * While a stored Member session is still being validated, or their profile
 * is loading, the pre-paint choice (public/appearance-init.js) is left as
 * is — clearing it then would reintroduce the light flash it prevents.
 */
export function useAppearance() {
  const { isAuthenticated, user } = useContext(AuthContext);
  const isMemberUser = user?.role_name === 'member';
  const isMember = isAuthenticated && isMemberUser;

  const { data: profile } = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: getMemberProfile,
    enabled: isMember,
  });
  const appearance = isMember ? profile?.appearance : undefined;

  useEffect(() => {
    if (!isMemberUser) {
      clearMemberAppearance();
      return;
    }
    if (appearance) {
      applyMemberAppearance(appearance);
    }
  }, [isMemberUser, appearance]);
}
