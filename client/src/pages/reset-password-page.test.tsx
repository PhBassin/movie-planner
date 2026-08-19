import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ResetPasswordPage from './reset-password-page.js';
import { confirmPasswordReset } from '../api/auth.js';
import { AuthContext } from '../contexts/AuthContext.js';

vi.mock('../api/auth.js', () => ({
  confirmPasswordReset: vi.fn(),
}));

describe('ResetPasswordPage', () => {
  const logout = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    logout.mockResolvedValue(undefined);
  });

  it('confirms a valid token and redirects to login without auto-login', async () => {
    vi.mocked(confirmPasswordReset).mockResolvedValue(undefined);

    render(
      <AuthContext.Provider value={{
        isAuthenticated: true,
        user: null,
        isAdmin: false,
        hasPermission: vi.fn(),
        login: vi.fn(),
        logout,
      }}>
        <MemoryRouter initialEntries={['/reset-password?token=raw-token']}>
          <Routes>
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/login" element={<h1>Login page</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    fireEvent.change(screen.getByLabelText(/^new password$/i), {
      target: { value: 'NewPass123!' },
    });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: 'NewPass123!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(confirmPasswordReset).toHaveBeenCalledWith('raw-token', 'NewPass123!');
      expect(logout).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('heading', { name: /login page/i })).toBeInTheDocument();
    });
  });

  it('rejects mismatched passwords without calling the API', async () => {
    render(
      <MemoryRouter initialEntries={['/reset-password?token=raw-token']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/^new password$/i), {
      target: { value: 'NewPass123!' },
    });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: 'Different123!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/passwords do not match/i);
    });
    expect(confirmPasswordReset).not.toHaveBeenCalled();
  });

  it('offers the request page when the token is missing', () => {
    render(
      <MemoryRouter initialEntries={['/reset-password']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /invalid reset link/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute('href', '/forgot-password');
  });
});
