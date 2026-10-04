import { useEffect, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AuthContext } from '../contexts/AuthContext.js';
import { getMemberProfile } from '../api/me.js';

/**
 * Member Appearance (light/dark) — see CONTEXT.md → Appearance. Syncs the
 * Member's persisted choice onto the document root (`html.dark`); the dark
 * surface then adapts the instance's Branding colors (see index.css). Staff
 * and Visitors have no Appearance: the class is removed for them.
 */
export function useAppearance() {
  const { isAuthenticated, user } = useContext(AuthContext);
  const isMember = isAuthenticated && user?.role_name === 'member';

  const { data: profile } = useQuery({
    queryKey: ['me'],
    queryFn: getMemberProfile,
    enabled: isMember,
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isMember && profile?.appearance === 'dark');
  }, [isMember, profile?.appearance]);
}
