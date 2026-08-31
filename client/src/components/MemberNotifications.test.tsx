import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemberNotifications, { useMemberNotifications } from './MemberNotifications.js';
import { AuthContext, type User } from '../contexts/AuthContext.js';
import * as memberApi from '../api/me.js';
import type { MemberNotice } from '../types/index.js';

vi.mock('../api/me.js', () => ({
  subscribeToMemberNotifications: vi.fn(),
}));

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

const memberAuth = { ...visitorAuth, isAuthenticated: true, user: member };

let noticeCallback: ((notice: MemberNotice) => void) | null = null;
const mockUnsubscribe = vi.fn();

function renderComponent(auth = memberAuth) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <MemberNotifications />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );

  return { ...view, invalidateSpy };
}

describe('MemberNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noticeCallback = null;
    vi.mocked(memberApi.subscribeToMemberNotifications).mockImplementation((cb) => {
      noticeCallback = cb;
      return mockUnsubscribe;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not subscribe for visitors', () => {
    renderComponent(visitorAuth);
    expect(memberApi.subscribeToMemberNotifications).not.toHaveBeenCalled();
  });

  it('subscribes for members and shows a success toast naming the theater', async () => {
    const { invalidateSpy } = renderComponent();

    expect(memberApi.subscribeToMemberNotifications).toHaveBeenCalledOnce();

    await waitFor(() => {
      expect(noticeCallback).not.toBeNull();
    });
    noticeCallback!({
      type: 'submission_resolved',
      memberId: 7,
      submissionId: 9,
      theaterId: 'C0013',
      theaterName: 'UGC Opéra',
      outcome: 'succeeded',
    });

    const toast = await screen.findByTestId('member-notification');
    expect(toast).toHaveTextContent('UGC Opéra');
    expect(toast).toHaveTextContent('a rejoint votre Selection');
    expect(toast.getAttribute('data-kind')).toBe('success');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['selection'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['selection-movies'] });
  });

  it('points the cap-blocked toast at the cinemas list', async () => {
    renderComponent();

    await waitFor(() => expect(noticeCallback).not.toBeNull());
    noticeCallback!({
      type: 'submission_resolved',
      memberId: 7,
      submissionId: 9,
      theaterId: 'C0013',
      theaterName: 'UGC Opéra',
      outcome: 'succeeded_selection_full',
    });

    const toast = await screen.findByTestId('member-notification');
    expect(toast).toHaveTextContent('Selection est pleine');
    expect(toast.getAttribute('data-kind')).toBe('cap-blocked');
    expect(screen.getByRole('link', { name: 'Voir les cinémas' })).toHaveAttribute('href', '/cinemas');
  });

  it('shows only the sanitized reason on failure', async () => {
    renderComponent();

    await waitFor(() => expect(noticeCallback).not.toBeNull());
    noticeCallback!({
      type: 'submission_resolved',
      memberId: 7,
      submissionId: 9,
      theaterId: 'C0013',
      theaterName: 'C0013',
      outcome: 'failed',
      reason: 'Source injoignable',
    });

    const toast = await screen.findByTestId('member-notification');
    expect(toast).toHaveTextContent('Source injoignable');
    expect(toast).not.toHaveTextContent('C0013');
    expect(toast.getAttribute('data-kind')).toBe('error');
  });

  it('dismisses the toast on the close button', async () => {
    renderComponent();

    await waitFor(() => expect(noticeCallback).not.toBeNull());
    noticeCallback!({
      type: 'submission_resolved',
      memberId: 7,
      submissionId: 9,
      theaterId: 'C0013',
      theaterName: 'UGC Opéra',
      outcome: 'succeeded',
    });

    await screen.findByTestId('member-notification');
    fireEvent.click(screen.getByRole('button', { name: 'Fermer la notification' }));
    await waitFor(() => expect(screen.queryByTestId('member-notification')).not.toBeInTheDocument());
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderComponent();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it('exposes dismiss from the hook', async () => {
    let hookNotice: ((notice: MemberNotice) => void) | null = null;
    vi.mocked(memberApi.subscribeToMemberNotifications).mockImplementation((cb) => {
      hookNotice = cb;
      return mockUnsubscribe;
    });

    const { result } = renderHookWithProviders(() => useMemberNotifications());

    await waitFor(() => expect(hookNotice).not.toBeNull());
    hookNotice!({
      type: 'submission_resolved',
      memberId: 7,
      submissionId: 9,
      theaterId: 'C0013',
      theaterName: 'UGC Opéra',
      outcome: 'succeeded',
    });

    await waitFor(() => expect(result.current.toast).not.toBeNull());
    expect(result.current.toast?.kind).toBe('success');
  });
});

function renderHookWithProviders(callback: () => ReturnType<typeof useMemberNotifications>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(callback, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={memberAuth}>
          {children}
        </AuthContext.Provider>
      </QueryClientProvider>
    ),
  });
}
