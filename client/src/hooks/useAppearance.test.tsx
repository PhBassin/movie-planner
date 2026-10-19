import { render, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppearance } from './useAppearance.js';
import { getMemberProfile } from '../api/me.js';
import { AuthContext, type User } from '../contexts/AuthContext.js';
import { memberProfileFixture } from '../test/fixtures.js';
import { APPEARANCE_STORAGE_KEY } from '../utils/appearance.js';

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

// A stored Member session not yet validated by /api/auth/me
const pendingMemberAuth: AuthContextShape = { ...memberAuth, isAuthenticated: false };

const staffAuth: AuthContextShape = {
  ...memberAuth,
  user: { id: 1, username: 'admin', role_id: 1, role_name: 'admin', is_system_role: true, permissions: [] },
  isAdmin: true,
};

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
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.documentElement.classList.remove('dark');
    localStorage.clear();
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
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
  });

  it('never fetches a profile for a Visitor', async () => {
    renderHook(visitorAuth);

    expect(getMemberProfile).not.toHaveBeenCalled();
  });

  it('remembers the persisted Appearance locally for the pre-paint script', async () => {
    vi.mocked(getMemberProfile).mockResolvedValue(profile('dark'));

    renderHook(memberAuth);

    await waitFor(() => {
      expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('dark');
    });
  });

  it('keeps the pre-painted dark surface while the profile is loading', async () => {
    vi.mocked(getMemberProfile).mockReturnValue(new Promise(() => {}));
    document.documentElement.classList.add('dark');

    renderHook(memberAuth);

    await waitFor(() => {
      expect(getMemberProfile).toHaveBeenCalled();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('keeps the pre-painted dark surface while a stored Member session is being validated', () => {
    document.documentElement.classList.add('dark');
    localStorage.setItem(APPEARANCE_STORAGE_KEY, 'dark');

    renderHook(pendingMemberAuth);

    expect(getMemberProfile).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('dark');
  });

  it('forgets the local copy for Staff (Appearance is Member-owned)', () => {
    document.documentElement.classList.add('dark');
    localStorage.setItem(APPEARANCE_STORAGE_KEY, 'dark');

    renderHook(staffAuth);

    expect(getMemberProfile).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
  });
});
