import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AccountPage from './AccountPage';
import * as meApi from '../api/me';
import { ApiError } from '../api/client';
import { AuthContext } from '../contexts/AuthContext';
import type { PermissionName } from '../types/role';

vi.mock('../api/me');

const memberUser = {
  id: 7,
  username: 'jane@example.com',
  role_id: 3,
  role_name: 'member',
  is_system_role: true,
  permissions: [] as PermissionName[],
};

const exportDocument: meApi.MemberDataExport = {
  exported_at: '2026-10-23T12:00:00.000Z',
  account: { email: 'jane@example.com', status: 'active', email_verified_at: null, created_at: '2026-01-01T00:00:00Z' },
  appearance: 'light',
  selection: [],
  submissions: [],
};

function renderPage(user = memberUser, logout = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{
        isAuthenticated: true,
        user,
        isAdmin: false,
        hasPermission: () => false,
        login: vi.fn(),
        logout,
      }}>
        <MemoryRouter initialEntries={['/account']}>
          <Routes>
            <Route path="/account" element={<AccountPage />} />
            <Route path="/" element={<div data-testid="home" />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { logout };
}

describe('AccountPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(meApi.getMemberProfile).mockResolvedValue({
      id: 7,
      email: 'jane@example.com',
      username: 'jane@example.com',
      role_name: 'member',
      status: 'active',
      email_verified: true,
      appearance: 'light',
      selectionCount: 0,
      selectionLimit: 10,
      created_at: '2026-01-01T00:00:00Z',
    });
  });

  it('redirects Staff away (the page is Member-only)', () => {
    renderPage({ ...memberUser, role_name: 'admin' });
    expect(screen.getByTestId('home')).toBeInTheDocument();
  });

  it('shows the Member email', async () => {
    renderPage();
    expect(await screen.findByTestId('account-email')).toHaveTextContent('jane@example.com');
  });

  it('downloads the export as a dated JSON file', async () => {
    vi.mocked(meApi.exportMemberData).mockResolvedValue(exportDocument);
    const createObjectURL = vi.fn(() => 'blob:export');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await userEvent.click(screen.getByTestId('export-data-button'));

    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('movie-planner-data-2026-10-23.json');
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:export'));
    click.mockRestore();
  });

  it('keeps delete disabled until the password is entered and the warning acknowledged', async () => {
    renderPage();
    const submit = screen.getByTestId('delete-account-submit');
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Password'), 'Str0ng!Pass');
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByTestId('delete-account-confirm'));
    expect(submit).toBeEnabled();
  });

  it('shows the server error on a wrong password and stays signed in', async () => {
    vi.mocked(meApi.deleteOwnAccount).mockRejectedValue(
      new ApiError('Password is incorrect', 403, { success: false, error: 'Password is incorrect' }),
    );
    const { logout } = renderPage();

    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByTestId('delete-account-confirm'));
    await userEvent.click(screen.getByTestId('delete-account-submit'));

    expect(await screen.findByTestId('delete-account-error')).toHaveTextContent('Password is incorrect');
    expect(logout).not.toHaveBeenCalled();
  });

  it('erases the account, signs out and goes home', async () => {
    vi.mocked(meApi.deleteOwnAccount).mockResolvedValue(undefined);
    const { logout } = renderPage();

    await userEvent.type(screen.getByLabelText('Password'), 'Str0ng!Pass');
    await userEvent.click(screen.getByTestId('delete-account-confirm'));
    await userEvent.click(screen.getByTestId('delete-account-submit'));

    await waitFor(() => expect(meApi.deleteOwnAccount).toHaveBeenCalledWith('Str0ng!Pass'));
    expect(await screen.findByTestId('home')).toBeInTheDocument();
    // The server already ended the Session: local-only sign-out.
    expect(logout).toHaveBeenCalledWith({ skipServerLogout: true });
  });
});
