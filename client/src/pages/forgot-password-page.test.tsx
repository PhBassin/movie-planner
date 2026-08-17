import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ForgotPasswordPage from './forgot-password-page.js';
import { requestPasswordReset } from '../api/auth.js';

vi.mock('../api/auth.js', () => ({
  requestPasswordReset: vi.fn(),
}));

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits the email and shows enumeration-safe confirmation copy', async () => {
    vi.mocked(requestPasswordReset).mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(requestPasswordReset).toHaveBeenCalledWith('jane@example.com');
    });
    expect(screen.getByRole('heading', { name: /check your inbox/i })).toBeInTheDocument();
    expect(screen.getByText(/if an account exists/i)).toBeInTheDocument();
  });

  it('shows a network error without revealing account existence', async () => {
    vi.mocked(requestPasswordReset).mockRejectedValue(new Error('Network error'));

    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/could not send/i);
    });
    expect(screen.getByRole('alert')).not.toHaveTextContent(/account exists/i);
  });
});
