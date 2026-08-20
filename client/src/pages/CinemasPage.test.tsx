import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CinemasPage from './CinemasPage.js';
import { AuthContext, type User } from '../contexts/AuthContext.js';
import * as theatersApi from '../api/theaters.js';
import * as memberApi from '../api/me.js';
import { ApiError } from '../api/core.js';

vi.mock('../api/theaters.js', () => ({
  getTheaters: vi.fn(),
}));

vi.mock('../api/me.js', () => ({
  getMemberProfile: vi.fn(),
  getSelection: vi.fn(),
  addToSelection: vi.fn(),
  removeFromSelection: vi.fn(),
}));

const catalog = [
  { id: 'C0001', name: 'UGC Opéra', city: 'Paris', status: 'active' as const },
  { id: 'C0002', name: 'Pathé Wepler', city: 'Paris', status: 'active' as const },
  { id: 'P0001', name: 'En préparation', city: 'Paris', status: 'provisioning' as const },
];

const member: User = {
  id: 7,
  username: 'member@example.com',
  role_id: 3,
  role_name: 'member',
  is_system_role: true,
  permissions: [],
};

const visitorAuth = {
  isAuthenticated: false,
  user: null,
  isAdmin: false,
  hasPermission: vi.fn(() => false),
  login: vi.fn(),
  logout: vi.fn(),
};

function renderPage(user: User | null = null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const auth = user
    ? { ...visitorAuth, isAuthenticated: true, user }
    : visitorAuth;

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <CinemasPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('CinemasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(theatersApi.getTheaters).mockResolvedValue(catalog);
    vi.mocked(memberApi.getMemberProfile).mockResolvedValue({
      id: 7,
      email: 'member@example.com',
      username: 'member@example.com',
      role_name: 'member',
      status: 'active',
      email_verified: true,
      appearance: 'light',
      selectionCount: 0,
      selectionLimit: 50,
      created_at: '2026-01-01T00:00:00Z',
    });
    vi.mocked(memberApi.getSelection).mockResolvedValue([]);
  });

  it('lets a Visitor search the active catalog without Selection controls', async () => {
    renderPage();

    await screen.findByText('UGC Opéra');
    expect(screen.getByText('Pathé Wepler')).toBeInTheDocument();
    expect(screen.queryByText('En préparation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('add-selection-C0001')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('cinemas-search'), { target: { value: 'wepler' } });

    expect(screen.queryByText('UGC Opéra')).not.toBeInTheDocument();
    expect(screen.getByText('Pathé Wepler')).toBeInTheDocument();
  });

  it('adds a theater and refreshes the visible Selection state', async () => {
    let selected = false;
    vi.mocked(memberApi.addToSelection).mockImplementation(async () => {
      selected = true;
      return catalog[0];
    });
    vi.mocked(memberApi.getSelection).mockImplementation(async () => (selected ? [catalog[0]] : []));
    vi.mocked(memberApi.getMemberProfile).mockImplementation(async () => ({
      id: 7,
      email: 'member@example.com',
      username: 'member@example.com',
      role_name: 'member',
      status: 'active',
      email_verified: true,
      appearance: 'light',
      selectionCount: selected ? 1 : 0,
      selectionLimit: 50,
      created_at: '2026-01-01T00:00:00Z',
    }));

    renderPage(member);
    await screen.findByText('UGC Opéra');
    fireEvent.click(screen.getByTestId('add-selection-C0001'));

    await waitFor(() => expect(memberApi.addToSelection).toHaveBeenCalledWith('C0001', expect.anything()));
    expect(await screen.findByTestId('selected-C0001')).toBeInTheDocument();
    expect(screen.getByText('1 / 50')).toBeInTheDocument();
  });

  it('disables adds proactively when the Selection is full', async () => {
    vi.mocked(memberApi.getMemberProfile).mockResolvedValue({
      id: 7,
      email: 'member@example.com',
      username: 'member@example.com',
      role_name: 'member',
      status: 'active',
      email_verified: true,
      appearance: 'light',
      selectionCount: 50,
      selectionLimit: 50,
      created_at: '2026-01-01T00:00:00Z',
    });

    renderPage(member);

    const addButton = await screen.findByTestId('add-selection-C0001');
    expect(addButton).toBeDisabled();
    expect(screen.getByText('50 / 50')).toBeInTheDocument();
  });

  it('shows a 409 notice and refreshes the profile after a stale count', async () => {
    vi.mocked(memberApi.addToSelection).mockRejectedValue(
      new ApiError('Selection contains 50 theaters; maximum is 50', 409),
    );

    renderPage(member);
    await screen.findByText('UGC Opéra');
    fireEvent.click(screen.getByTestId('add-selection-C0001'));

    expect(await screen.findByTestId('selection-toast')).toHaveTextContent('Selection contains 50 theaters');
    await waitFor(() => expect(memberApi.getMemberProfile).toHaveBeenCalledTimes(2));
  });
});
