import { useContext, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthContext } from '../contexts/AuthContext.js';

/**
 * Drop every cached query when the session ends (logout or session expiry).
 * Cached data is per-account (profile, Selection, Appearance…): without this,
 * the next account signing in on the same tab would briefly see the previous
 * one's data until each query refetched.
 */
export function useClearQueryCacheOnLogout() {
  const { user } = useContext(AuthContext);
  const queryClient = useQueryClient();
  const hadUser = useRef(user !== null);

  useEffect(() => {
    if (hadUser.current && user === null) {
      queryClient.clear();
    }
    hadUser.current = user !== null;
  }, [user, queryClient]);
}
