import { render, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppearance } from './useAppearance.js';
import { getMemberProfile } from '../api/me.js';
import { AuthContext, type User } from '../contexts/AuthContext.js';
import { memberProfileFixture } from '../test/fixtures.js';

const profile = memberProfileFixture;

interface AuthContextShape {
  isAuthenticated: boolean;
  user: User | null;
  isAdmin: boolean;
  hasPermission: () => boolean;
  login: () => void;
  logout: () => void;
}

vi.mock('../api/me', () => ({
  getMemberProfile: vi.fn(),
  updateAppearance: vi.fn(),
}));

const memberAuth: AuthContextShape = {
  isAuthenticated: true,
  user: { id: 7, username: 'jane@example.com', role_id: 3, role_name: 'member', is_system_role: false, permissions: [] },
  isAdmin: false,
  hasPermission: () => false,
  login: vi.fn(),
  logout: vi.fn(),
};

const visitorAuth: AuthContextShape = { ...memberAuth, isAuthenticated: false, user: null };

const renderHook = (auth: AuthContextShape) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <Probe />
      </AuthContext.Provider>
    </QueryClientProvider>
  );
};

function Probe() {
  useAppearance();
  return null;
}

describe('useAppearance', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.documentElement.classList.remove('dark');
  });

  it('applies the dark class for a Member whose Appearance is dark', async () => {
    vi.mocked(getMemberProfile).mockResolvedValue(profile('dark'));

    renderHook(memberAuth);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });

  it('applies no dark class for a Member whose Appearance is light', async () => {
    vi.mocked(getMemberProfile).mockResolvedValue(profile('light'));

    renderHook(memberAuth);

    await waitFor(() => {
      expect(getMemberProfile).toHaveBeenCalled();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('removes the dark class when the Member logs out', async () => {
    vi.mocked(getMemberProfile).mockResolvedValue(profile('dark'));
    document.documentElement.classList.add('dark');

    const { rerender } = renderHook(memberAuth);

    await waitFor(() => {
      expect(getMemberProfile).toHaveBeenCalled();
    });

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider value={visitorAuth}>
          <Probe />
        </AuthContext.Provider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  it('never fetches a profile for a Visitor', async () => {
    renderHook(visitorAuth);

    expect(getMemberProfile).not.toHaveBeenCalled();
  });
});
