import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SubmissionsPage, { pendingSinceLabel, SUBMISSIONS_PAGE_SIZE } from './SubmissionsPage.js';
import { AuthContext, type User } from '../contexts/AuthContext.js';
import * as memberApi from '../api/me.js';
import * as authApi from '../api/auth.js';
import { ApiError } from '../api/core.js';
import type { MemberProfile, MemberSubmission } from '../api/me.js';

vi.mock('../api/me.js', () => ({
  getMemberProfile: vi.fn(),
  getMemberSubmissions: vi.fn(),
  addToSelection: vi.fn(),
  submitTheater: vi.fn(),
}));

vi.mock('../api/auth.js', () => ({
  resendVerification: vi.fn(),
}));

const member: User = {
  id: 7,
  username: 'member@example.com',
  role_id: 3,
  role_name: 'member',
  is_system_role: true,
  permissions: [],
};

const baseAuth = {
  isAuthenticated: true,
  user: member,
  isAdmin: false,
  hasPermission: vi.fn(() => false),
  login: vi.fn(),
  logout: vi.fn(),
};

const profile: MemberProfile = {
  id: 7,
  email: 'member@example.com',
  username: 'member@example.com',
  role_name: 'member',
  status: 'active',
  email_verified: true,
  appearance: 'light',
  selectionCount: 1,
  selectionLimit: 50,
  created_at: '2026-01-01T00:00:00Z',
};

const URL_C1 = 'https://www.allocine.fr/seance/salle_gen_csalle=C0001.html';

function submission(overrides: Partial<MemberSubmission> = {}): MemberSubmission {
  return {
    id: 1,
    url: URL_C1,
    status: 'pending',
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    resolved_at: null,
    attempts: 1,
    theater: { id: 'C0001', status: 'provisioning' },
    ...overrides,
  };
}

function page(items: MemberSubmission[], total = items.length, offset = 0) {
  return { items, total, limit: SUBMISSIONS_PAGE_SIZE, offset };
}

function renderPage(auth: typeof baseAuth | (Omit<typeof baseAuth, 'user'> & { user: User }) = baseAuth) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/submissions']}>
          <Routes>
            <Route path="/submissions" element={<SubmissionsPage />} />
            <Route path="/" element={<p>home</p>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

describe('pendingSinceLabel', () => {
  it('counts whole minutes since the attempt', () => {
    const now = Date.parse('2026-01-01T10:12:30Z');
    expect(pendingSinceLabel('2026-01-01T10:00:00Z', now)).toBe('En cours depuis 12 min');
  });

  it('says less than a minute for a fresh attempt', () => {
    const now = Date.parse('2026-01-01T10:00:20Z');
    expect(pendingSinceLabel('2026-01-01T10:00:00Z', now)).toBe('En cours depuis moins d’une minute');
  });
});

describe('SubmissionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(memberApi.getMemberProfile).mockResolvedValue(profile);
  });

  it('sends Staff back to the homepage', async () => {
    renderPage({ ...baseAuth, user: { ...member, role_name: 'admin' } });

    expect(await screen.findByText('home')).toBeInTheDocument();
    expect(memberApi.getMemberSubmissions).not.toHaveBeenCalled();
  });

  it('renders each row state and the throttle reminder', async () => {
    vi.mocked(memberApi.getMemberSubmissions).mockResolvedValue(page([
      submission({ id: 1 }),
      submission({
        id: 2, url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0002.html', status: 'succeeded',
        theater: { id: 'C0002', status: 'active', name: 'UGC Opéra', city: 'Paris' }, in_selection: true,
      }),
      submission({
        id: 3, url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0003.html', status: 'succeeded',
        theater: { id: 'C0003', status: 'active', name: 'Pathé Wepler', city: null }, in_selection: false,
      }),
      submission({
        id: 4, url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0004.html', status: 'failed',
        theater: { id: 'C0004', status: 'provisioning' }, reason: 'Source injoignable', attempts: 3,
      }),
    ]));

    renderPage();

    const rows = await screen.findAllByTestId('submission-row');
    expect(rows).toHaveLength(4);
    expect(screen.getByTestId('submissions-throttle-reminder')).toBeInTheDocument();

    expect(within(rows[0]).getByTestId('submission-state')).toHaveTextContent('En cours depuis 5 min');
    expect(within(rows[0]).getByText(URL_C1)).toBeInTheDocument();
    expect(within(rows[0]).queryByTestId('submission-theater-link')).not.toBeInTheDocument();

    expect(within(rows[1]).getByTestId('submission-theater-link')).toHaveAttribute('href', '/theater/C0002');
    expect(within(rows[1]).getByTestId('submission-theater-link')).toHaveTextContent('UGC Opéra · Paris');
    expect(within(rows[1]).getByTestId('submission-state')).toHaveTextContent('Ajouté à votre Sélection');
    expect(within(rows[1]).queryByTestId('submission-add')).not.toBeInTheDocument();

    expect(within(rows[2]).getByTestId('submission-state')).toHaveTextContent('Ajouté au catalogue, pas dans votre Sélection');
    expect(within(rows[2]).getByTestId('submission-add')).toBeInTheDocument();

    expect(within(rows[3]).getByTestId('submission-state')).toHaveTextContent('Source injoignable');
    expect(within(rows[3]).getByTestId('submission-retry')).toBeInTheDocument();
    expect(within(rows[3]).getByTestId('submission-attempts')).toHaveTextContent('3 tentatives');
    expect(within(rows[0]).queryByTestId('submission-attempts')).not.toBeInTheDocument();
  });

  it('adds a succeeded cinema to the Selection and refreshes the list', async () => {
    vi.mocked(memberApi.getMemberSubmissions).mockResolvedValue(page([
      submission({ status: 'succeeded', theater: { id: 'C0001', status: 'active', name: 'UGC', city: null }, in_selection: false }),
    ]));
    vi.mocked(memberApi.addToSelection).mockResolvedValue({ id: 'C0001', name: 'UGC', status: 'active' });

    const { invalidateSpy } = renderPage();
    fireEvent.click(await screen.findByTestId('submission-add'));

    await waitFor(() => expect(memberApi.addToSelection).toHaveBeenCalledWith('C0001'));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'submissions'] }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['selection'] });
  });

  it('explains a full Selection when the add hits the cap', async () => {
    vi.mocked(memberApi.getMemberSubmissions).mockResolvedValue(page([
      submission({ status: 'succeeded', theater: { id: 'C0001', status: 'active', name: 'UGC', city: null }, in_selection: false }),
    ]));
    vi.mocked(memberApi.addToSelection).mockRejectedValue(new ApiError('Selection limit reached', 409));

    renderPage();
    fireEvent.click(await screen.findByTestId('submission-add'));

    expect(await screen.findByTestId('submission-action-error')).toHaveTextContent('Votre Sélection est pleine');
  });

  it('retries a failed submission with the same URL', async () => {
    vi.mocked(memberApi.getMemberSubmissions).mockResolvedValue(page([
      submission({ status: 'failed', reason: 'Source injoignable' }),
    ]));
    vi.mocked(memberApi.submitTheater).mockResolvedValue({
      outcome: 'submitted',
      submission: { id: 2, status: 'pending', report_id: 9 },
    });

    const { invalidateSpy } = renderPage();
    fireEvent.click(await screen.findByTestId('submission-retry'));

    await waitFor(() => expect(memberApi.submitTheater).toHaveBeenCalledWith(URL_C1));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'submissions'] }));
  });

  it.each([
    [new ApiError('Too many submissions', 429), 'limite de propositions'],
    [new ApiError('This cinema is already being added to the catalog', 409), 'already being added'],
  ])('surfaces retry errors inline (%s)', async (error, expected) => {
    vi.mocked(memberApi.getMemberSubmissions).mockResolvedValue(page([
      submission({ status: 'failed', reason: 'Source injoignable' }),
    ]));
    vi.mocked(memberApi.submitTheater).mockRejectedValue(error);

    renderPage();
    fireEvent.click(await screen.findByTestId('submission-retry'));

    expect(await screen.findByTestId('submission-action-error')).toHaveTextContent(expected);
  });

  it('loads the next page on "Voir plus"', async () => {
    vi.mocked(memberApi.getMemberSubmissions)
      .mockResolvedValueOnce(page([submission({ id: 1 })], 2, 0))
      .mockResolvedValueOnce(page([submission({ id: 2, url: 'https://example.test/second' })], 2, 1));

    renderPage();
    fireEvent.click(await screen.findByTestId('submissions-load-more'));

    await waitFor(() => expect(screen.getAllByTestId('submission-row')).toHaveLength(2));
    expect(memberApi.getMemberSubmissions).toHaveBeenNthCalledWith(1, { limit: SUBMISSIONS_PAGE_SIZE, offset: 0 });
    expect(memberApi.getMemberSubmissions).toHaveBeenNthCalledWith(2, { limit: SUBMISSIONS_PAGE_SIZE, offset: 1 });
    expect(screen.queryByTestId('submissions-load-more')).not.toBeInTheDocument();
  });

  it('points a verified Member with no submissions to the submission form', async () => {
    vi.mocked(memberApi.getMemberSubmissions).mockResolvedValue(page([]));

    renderPage();

    expect(await screen.findByTestId('submissions-empty')).toBeInTheDocument();
    expect(screen.getByTestId('submissions-empty-link')).toHaveAttribute('href', '/cinemas');
    expect(screen.queryByTestId('submissions-throttle-reminder')).not.toBeInTheDocument();
  });

  it('asks an unverified Member to verify, with a resend action', async () => {
    vi.mocked(memberApi.getMemberProfile).mockResolvedValue({ ...profile, status: 'unverified', email_verified: false });
    vi.mocked(memberApi.getMemberSubmissions).mockResolvedValue(page([]));
    vi.mocked(authApi.resendVerification).mockResolvedValue(undefined);

    renderPage();

    expect(await screen.findByTestId('submissions-unverified')).toHaveTextContent('Vérifiez votre email pour proposer un cinéma');
    fireEvent.click(screen.getByTestId('submissions-resend-verification'));

    await waitFor(() => expect(authApi.resendVerification).toHaveBeenCalledWith('member@example.com'));
    expect(await screen.findByRole('status')).toHaveTextContent('Un nouvel email de vérification');
  });
});
