import { render } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type User } from '../contexts/AuthContext.js';
import { useClearQueryCacheOnLogout } from './useClearQueryCacheOnLogout.js';

const member: User = {
  id: 7,
  username: 'jane@example.com',
  role_id: 3,
  role_name: 'member',
  is_system_role: false,
  permissions: [],
};

function Probe() {
  useClearQueryCacheOnLogout();
  return null;
}

const tree = (queryClient: QueryClient, user: User | null) => (
  <QueryClientProvider client={queryClient}>
    <AuthContext.Provider
      value={{
        isAuthenticated: user !== null,
        user,
        isAdmin: false,
        hasPermission: () => false,
        login: vi.fn(),
        logout: vi.fn(),
      }}
    >
      <Probe />
    </AuthContext.Provider>
  </QueryClientProvider>
);

describe('useClearQueryCacheOnLogout', () => {
  it('drops the cached account data when the session ends', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['me'], { appearance: 'dark' });

    const { rerender } = render(tree(queryClient, member));
    expect(queryClient.getQueryData(['me'])).toBeDefined();

    rerender(tree(queryClient, null));

    expect(queryClient.getQueryData(['me'])).toBeUndefined();
  });

  it('keeps the cache for a Visitor who never had a session', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['theaters'], []);

    const { rerender } = render(tree(queryClient, null));
    rerender(tree(queryClient, null));

    expect(queryClient.getQueryData(['theaters'])).toEqual([]);
  });
});
