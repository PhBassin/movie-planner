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
  submitTheater: vi.fn(),
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
      offer: null,
      rememberedCount: 0,
      choiceLimit: 50,
      selectionOverQuota: false,
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
    vi.mocked(memberApi.getSelection).mockImplementation(async () => (selected ? [{ ...catalog[0], active: true }] : []));
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
      offer: null,
      rememberedCount: 0,
      choiceLimit: 50,
      selectionOverQuota: false,
      created_at: '2026-01-01T00:00:00Z',
    }));

    renderPage(member);
    await screen.findByText('UGC Opéra');
    fireEvent.click(screen.getByTestId('add-selection-C0001'));

    await waitFor(() => expect(memberApi.addToSelection).toHaveBeenCalledWith('C0001', expect.anything()));
    expect(await screen.findByTestId('selected-C0001')).toBeInTheDocument();
    expect(screen.getByTestId('selection-usage')).toHaveTextContent('1 / 50 actifs');
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
      offer: null,
      rememberedCount: 0,
      choiceLimit: 50,
      selectionOverQuota: false,
      created_at: '2026-01-01T00:00:00Z',
    });

    renderPage(member);

    const addButton = await screen.findByTestId('add-selection-C0001');
    expect(addButton).toBeDisabled();
    expect(screen.getByTestId('selection-usage')).toHaveTextContent('50 / 50 actifs');
    // Billing disabled: no offer to explain.
    expect(screen.queryByTestId('selection-offer')).not.toBeInTheDocument();
  });

  it('shows a 409 notice and refreshes the profile after a stale count', async () => {
    vi.mocked(memberApi.addToSelection).mockRejectedValue(
      new ApiError('Selection contains 50 theaters; maximum is 50', 409),
    );

    renderPage(member);
    await screen.findByText('UGC Opéra');
    fireEvent.click(screen.getByTestId('add-selection-C0001'));

    expect(await screen.findByTestId('selection-toast')).toHaveTextContent('Votre Selection est pleine (50 cinémas actifs).');
    await waitFor(() => expect(memberApi.getMemberProfile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(memberApi.getSelection).toHaveBeenCalledTimes(2));
  });

  describe('freemium quotas (ADR 0011)', () => {
    const freeProfile = (overrides: Partial<memberApi.MemberProfile> = {}): memberApi.MemberProfile => ({
      id: 7,
      email: 'member@example.com',
      username: 'member@example.com',
      role_name: 'member',
      status: 'active',
      email_verified: true,
      appearance: 'light',
      offer: 'free',
      selectionCount: 0,
      selectionLimit: 3,
      rememberedCount: 0,
      choiceLimit: 50,
      selectionOverQuota: false,
      created_at: '2026-01-01T00:00:00Z',
      ...overrides,
    });

    it('explains the free offer and disables new adds at the 3-theater quota', async () => {
      vi.mocked(memberApi.getMemberProfile).mockResolvedValue(freeProfile({ selectionCount: 3 }));

      renderPage(member);

      const addButton = await screen.findByTestId('add-selection-C0001');
      expect(addButton).toBeDisabled();
      expect(addButton).toHaveAttribute('title', 'Selection pleine (3 / 3 actifs)');
      expect(screen.getByTestId('selection-usage')).toHaveTextContent('3 / 3 actifs');
      expect(screen.getByTestId('selection-offer')).toHaveTextContent('Offre gratuite : 3 cinémas actifs. Premium : jusqu’à 50.');
    });

    it('shows the premium quota', async () => {
      vi.mocked(memberApi.getMemberProfile).mockResolvedValue(freeProfile({ offer: 'premium', selectionCount: 4, selectionLimit: 50 }));

      renderPage(member);

      expect(await screen.findByTestId('selection-offer')).toHaveTextContent('Premium : jusqu’à 50 cinémas actifs.');
      expect(screen.getByTestId('add-selection-C0001')).toBeEnabled();
    });

    it('marks a remembered choice and reactivates it below quota', async () => {
      vi.mocked(memberApi.getMemberProfile).mockResolvedValue(freeProfile({ selectionCount: 1, rememberedCount: 1 }));
      vi.mocked(memberApi.getSelection).mockResolvedValue([
        { ...catalog[0], active: true },
        { ...catalog[1], active: false },
      ]);
      vi.mocked(memberApi.addToSelection).mockResolvedValue(catalog[1]);

      renderPage(member);

      expect(await screen.findByTestId('remembered-C0002')).toHaveTextContent('Mémorisé');
      expect(screen.getByTestId('selected-C0001')).toBeInTheDocument();
      expect(screen.getByTestId('selection-remembered')).toHaveTextContent('+ 1 mémorisé');
      expect(screen.getByTestId('remove-selection-C0002')).toBeInTheDocument();
      const reactivate = screen.getByTestId('add-selection-C0002');
      expect(reactivate).toHaveTextContent('Réactiver');
      fireEvent.click(reactivate);
      await waitFor(() => expect(memberApi.addToSelection).toHaveBeenCalledWith('C0002', expect.anything()));
    });

    it('cannot reactivate a remembered choice at quota', async () => {
      vi.mocked(memberApi.getMemberProfile).mockResolvedValue(freeProfile({ selectionCount: 3, rememberedCount: 1 }));
      vi.mocked(memberApi.getSelection).mockResolvedValue([{ ...catalog[1], active: false }]);

      renderPage(member);

      expect(await screen.findByTestId('add-selection-C0002')).toBeDisabled();
    });

    it('blocks new choices at 50 stored choices but still allows reactivation', async () => {
      vi.mocked(memberApi.getMemberProfile).mockResolvedValue(freeProfile({ selectionCount: 2, rememberedCount: 48 }));
      vi.mocked(memberApi.getSelection).mockResolvedValue([{ ...catalog[1], active: false }]);

      renderPage(member);

      const add = await screen.findByTestId('add-selection-C0001');
      expect(add).toBeDisabled();
      expect(add).toHaveAttribute('title', '50 cinémas déjà enregistrés');
      expect(screen.getByTestId('add-selection-C0002')).toBeEnabled();
    });

    it('explains the free quota from the 409 details when the browser count was stale', async () => {
      vi.mocked(memberApi.getMemberProfile).mockResolvedValue(freeProfile({ offer: 'premium', selectionCount: 3, selectionLimit: 50 }));
      vi.mocked(memberApi.addToSelection).mockRejectedValue(
        new ApiError('Free offer allows 3 active theaters; premium allows up to 50', 409, {
          success: false,
          error: 'Free offer allows 3 active theaters; premium allows up to 50',
          details: [{ reason: 'quota_reached', usage: { offer: 'free', selectionQuota: 3, choiceLimit: 50 } }],
        }),
      );

      renderPage(member);
      fireEvent.click(await screen.findByTestId('add-selection-C0001'));

      expect(await screen.findByTestId('selection-toast')).toHaveTextContent(
        'L’offre gratuite permet 3 cinémas actifs. Premium permet d’en suivre jusqu’à 50.',
      );
      await waitFor(() => expect(memberApi.getMemberProfile).toHaveBeenCalledTimes(2));
    });

    it('explains the 50-choice bound from the 409 details', async () => {
      vi.mocked(memberApi.getMemberProfile).mockResolvedValue(freeProfile({ selectionCount: 1 }));
      vi.mocked(memberApi.addToSelection).mockRejectedValue(
        new ApiError('Selection holds 50 choices', 409, {
          details: [{ reason: 'choices_full', usage: { offer: 'free', selectionQuota: 3, choiceLimit: 50 } }],
        }),
      );

      renderPage(member);
      fireEvent.click(await screen.findByTestId('add-selection-C0001'));

      expect(await screen.findByTestId('selection-toast')).toHaveTextContent(
        'Vous avez déjà 50 cinémas enregistrés. Retirez un cinéma mémorisé pour en ajouter un autre.',
      );
    });

    it('tells an over-quota Member how to get the Homepage back', async () => {
      vi.mocked(memberApi.getMemberProfile).mockResolvedValue(freeProfile({ selectionCount: 5, selectionOverQuota: true }));

      renderPage(member);

      expect(await screen.findByTestId('selection-over-quota')).toHaveTextContent(
        'Votre Selection compte 5 cinémas actifs, votre offre en permet 3.',
      );
    });
  });

  it('hides the submission form from Visitors', async () => {
    renderPage();
    await screen.findByText('UGC Opéra');

    expect(screen.queryByTestId('submission-form')).not.toBeInTheDocument();
  });

  it('submits a new cinema and announces the pending proposal', async () => {
    vi.mocked(memberApi.submitTheater).mockResolvedValue({
      outcome: 'submitted',
      submission: { id: 9, status: 'pending', report_id: 42 },
    });

    renderPage(member);
    await screen.findByText('UGC Opéra');

    fireEvent.change(screen.getByTestId('submission-url'), {
      target: { value: 'https://www.allocine.fr/seance/salle_gen_csalle=C0099.html' },
    });
    fireEvent.click(screen.getByTestId('submission-submit'));

    await waitFor(() =>
      expect(memberApi.submitTheater).toHaveBeenCalledWith(
        'https://www.allocine.fr/seance/salle_gen_csalle=C0099.html',
        expect.anything(),
      ),
    );
    expect(await screen.findByTestId('selection-toast')).toHaveTextContent('Proposition enregistrée');
    expect(screen.getByTestId('submission-track-link')).toHaveAttribute('href', '/submissions');
    expect((screen.getByTestId('submission-url') as HTMLInputElement).value).toBe('');
  });

  it('surfaces the dedup downgrade when the proposed cinema already exists', async () => {
    vi.mocked(memberApi.submitTheater).mockResolvedValue({
      outcome: 'selection_added',
      theater: catalog[0],
    });

    renderPage(member);
    await screen.findByText('UGC Opéra');

    fireEvent.change(screen.getByTestId('submission-url'), {
      target: { value: 'https://www.allocine.fr/seance/salle_gen_csalle=C0001.html' },
    });
    fireEvent.click(screen.getByTestId('submission-submit'));

    expect(await screen.findByTestId('selection-toast')).toHaveTextContent('déjà dans le catalogue');
  });

  it('surfaces submission rejections (throttle, unverified) in the toast', async () => {
    vi.mocked(memberApi.submitTheater).mockRejectedValue(
      new ApiError('You have reached the limit of 3 new cinema submissions.', 429),
    );

    renderPage(member);
    await screen.findByText('UGC Opéra');

    fireEvent.change(screen.getByTestId('submission-url'), {
      target: { value: 'https://www.allocine.fr/seance/salle_gen_csalle=C0099.html' },
    });
    fireEvent.click(screen.getByTestId('submission-submit'));

    expect(await screen.findByTestId('selection-toast')).toHaveTextContent('limit of 3 new cinema submissions');
  });
});
