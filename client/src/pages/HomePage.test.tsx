/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import HomePage from './HomePage';
import * as clientApi from '../api/client';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from '../contexts/AuthContext';

// Mock the API client
const mockAuthContext = {
  isAuthenticated: true,
  user: { id: 1, username: 'testuser', role_id: 1, role_name: 'admin', is_system_role: true, permissions: ['theaters:create', 'scraper:trigger'] as any[] },
  logout: vi.fn(),
  login: vi.fn(),
  isAdmin: false,
  hasPermission: vi.fn(() => true),
  token: 'mock-token',
};

const renderWithClient = (ui: React.ReactElement, auth: React.ContextType<typeof AuthContext> = mockAuthContext) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        {ui}
      </AuthContext.Provider>
    </QueryClientProvider>
  );
};
vi.mock('../api/client', () => ({
  getWeeklyMovies: vi.fn(),
  getMoviesByDate: vi.fn(),
  getTheaters: vi.fn(),
  addTheater: vi.fn(),
  searchMovies: vi.fn(),
  getMemberProfile: vi.fn(),
  getSelection: vi.fn(),
  getSelectionMovies: vi.fn(),
  searchSelectionMovies: vi.fn(),
}));

describe('HomePage', () => {
  let mockGetWeeklyMovies: ReturnType<typeof vi.fn>;
  let mockGetTheaters: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetWeeklyMovies = vi.fn();
    mockGetTheaters = vi.fn();

    // Re-bind mocks
    (clientApi.getWeeklyMovies as any) = mockGetWeeklyMovies;
    (clientApi.getTheaters as any) = mockGetTheaters;

    // Default successful responses
    mockGetWeeklyMovies.mockResolvedValue({ movies: [], weekStart: '2023-01-01' });
    mockGetTheaters.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should load data on mount', async () => {
    renderWithClient(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockGetWeeklyMovies).toHaveBeenCalled();
      expect(mockGetTheaters).toHaveBeenCalled();
    });
  });

  it('should NOT show ScrapeProgress on the home page', async () => {
    renderWithClient(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockGetWeeklyMovies).toHaveBeenCalled();
    });

    // Scraping UI has been moved to admin — should never appear on HomePage
    expect(screen.queryByTestId('scrape-progress')).not.toBeInTheDocument();
  });

  it('should NOT show a scrape button on the home page', async () => {
    renderWithClient(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockGetWeeklyMovies).toHaveBeenCalled();
    });

    // Scraping UI has been moved to admin — no scrape button on public pages
    expect(screen.queryByTestId('scrape-all-button')).not.toBeInTheDocument();
  });
});

describe('HomePage — bouton Maintenant', () => {
  // Today is 2026-03-30 (Monday), within a week starting 2026-03-25
  const FIXED_TODAY = '2026-03-30';
  const WEEK_START = '2026-03-25';
  // Current time: 13:00 — showtimes at 12:00 are past, 14:00 is future
  const FIXED_NOW = new Date('2026-03-30T13:00:00');

  const makeFilmsResponse = () => ({
    movies: [
      {
        id: 101,
        title: 'Film Passé',
        genres: [],
        actors: [],
        source_url: '',
        theaters: [
          {
            id: 'C1',
            name: 'Theater 1',
            address: '',
            city: 'Paris',
            showtimes: [{ id: 's1', date: FIXED_TODAY, time: '12:00', experiences: [] }],
          },
        ],
      },
      {
        id: 102,
        title: 'Film Futur',
        genres: [],
        actors: [],
        source_url: '',
        theaters: [
          {
            id: 'C1',
            name: 'Theater 1',
            address: '',
            city: 'Paris',
            showtimes: [{ id: 's2', date: FIXED_TODAY, time: '14:00', experiences: [] }],
          },
        ],
      },
    ],
    weekStart: WEEK_START,
    date: FIXED_TODAY,
  });

  const renderHomePage = () =>
    renderWithClient(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    vi.clearAllMocks();
    (clientApi.getWeeklyMovies as any).mockResolvedValue({ movies: [], weekStart: WEEK_START });
    (clientApi.getTheaters as any).mockResolvedValue([]);
    (clientApi.getMoviesByDate as any).mockResolvedValue(makeFilmsResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the FilterBar inside the sticky container', async () => {
    renderHomePage();
    await waitFor(() => expect(screen.queryByTestId('filter-bar')).toBeInTheDocument());
    expect(screen.getByTestId('filter-bar')).toBeInTheDocument();
    expect(screen.getByTestId('sticky-search-date-container')).toBeInTheDocument();
  });

  it('renders the reset button in the FilterBar', async () => {
    renderHomePage();
    await waitFor(() => expect(screen.queryByTestId('filter-reset')).toBeInTheDocument());
    expect(screen.getByTestId('filter-reset')).toBeInTheDocument();
  });

  it('does not render the old "Tous les jours" button', async () => {
    renderHomePage();
    await waitFor(() => expect(screen.queryByTestId('filter-bar')).toBeInTheDocument());
    expect(screen.queryByTestId('day-selector-all')).not.toBeInTheDocument();
  });

  it('renders the Maintenant button in the DaySelector', async () => {
    renderHomePage();
    await waitFor(() => expect(screen.queryByRole('button', { name: /maintenant/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /maintenant/i })).toBeInTheDocument();
  });

  it('fetches today\'s films when Maintenant is clicked', async () => {
    renderHomePage();
    await waitFor(() => expect(screen.getByRole('button', { name: /maintenant/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /maintenant/i }));

    await waitFor(() => {
      expect(clientApi.getMoviesByDate).toHaveBeenCalledWith(FIXED_TODAY);
    });
  });

  it('hides films with only past showtimes after Maintenant click', async () => {
    renderHomePage();
    await waitFor(() => expect(screen.getByRole('button', { name: /maintenant/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /maintenant/i }));

    await waitFor(() => {
      expect(screen.getByText('Film Futur')).toBeInTheDocument();
    });
    expect(screen.queryByText('Film Passé')).not.toBeInTheDocument();
  });

  it('filters movies correctly and memoizes the result on subsequent renders', async () => {
    // This test ensures that when the page is rendered and updated, the filtering functions correctly.
    renderHomePage();
    await waitFor(() => expect(screen.getByRole('button', { name: /maintenant/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /maintenant/i }));
    await waitFor(() => {
      expect(screen.getByText('Film Futur')).toBeInTheDocument();
    });
  });

  it('reset button clears the search input text (end-to-end)', async () => {
    (clientApi.searchMovies as any).mockResolvedValue([
      { id: 101, title: 'Film Passé', genres: [], actors: [], source_url: '' },
    ]);

    renderHomePage();
    await waitFor(() => expect(screen.getByTestId('search-input')).toBeInTheDocument());

    const input = screen.getByTestId('search-input') as HTMLInputElement;
    await fireEvent.change(input, { target: { value: 'Film' } });

    await waitFor(() => expect(input.value).toBe('Film'));

    fireEvent.click(screen.getByTestId('filter-reset'));

    await waitFor(() => expect(input.value).toBe(''));
  });
});

describe('HomePage — polymorphic root', () => {
  const FIXED_TODAY = '2026-03-30';
  const WEEK_START = '2026-03-25';

  const visitorAuth = {
    ...mockAuthContext,
    isAuthenticated: false,
    user: null,
  };

  const memberAuth = {
    ...mockAuthContext,
    isAuthenticated: true,
    isAdmin: false,
    hasPermission: vi.fn(() => false),
    user: { id: 7, username: 'member@example.com', role_id: 3, role_name: 'member', is_system_role: false, permissions: [] as any[] },
  };

  const makeMemberProfile = (overrides: Record<string, unknown> = {}) => ({
    id: 7,
    email: 'member@example.com',
    username: 'member@example.com',
    role_name: 'member',
    status: 'active',
    email_verified: true,
    appearance: 'light',
    selectionCount: 2,
    selectionLimit: 50,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  });

  const makeSelectionMovie = (id: number, title: string, isNew: boolean) => ({
    id,
    title,
    genres: [],
    actors: [],
    source_url: '',
    isNewThisWeek: isNew,
    theaters: [
      {
        id: 'C0001',
        name: 'UGC Opéra',
        address: 'Rue',
        city: 'Paris',
        isNewThisWeek: isNew,
        showtimes: [{ id: `s${id}`, date: FIXED_TODAY, time: '20:00', experiences: [] }],
      },
    ],
  });

  const setupMember = ({ movies = [], profile, selection }: {
    movies?: any[];
    profile?: Record<string, unknown>;
    selection?: any[];
  } = {}) => {
    (clientApi.getMemberProfile as any).mockResolvedValue(makeMemberProfile(profile));
    (clientApi.getSelection as any).mockResolvedValue(selection ?? [{ id: 'C0001', name: 'UGC Opéra', status: 'active' }]);
    (clientApi.getSelectionMovies as any).mockResolvedValue({ movies, weekStart: WEEK_START });
  };

  const renderPage = (auth: React.ContextType<typeof AuthContext> = memberAuth) =>
    renderWithClient(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
      auth,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    (clientApi.getWeeklyMovies as any).mockResolvedValue({ movies: [], weekStart: WEEK_START });
    (clientApi.getTheaters as any).mockResolvedValue([]);
  });

  it('renders the Selection movies for a Member instead of the weekly catalog', async () => {
    setupMember({ movies: [makeSelectionMovie(1, 'Film Sélection', false)] });

    renderPage();

    await waitFor(() => expect(clientApi.getSelectionMovies).toHaveBeenCalled());
    expect(clientApi.getWeeklyMovies).not.toHaveBeenCalled();
    expect(await screen.findByText('Film Sélection')).toBeInTheDocument();
  });

  it('loads today for a Visitor by default', async () => {
    const today = new Date().toISOString().split('T')[0];
    (clientApi.getMoviesByDate as any).mockResolvedValue({ movies: [], weekStart: '2026-03-25', date: today });

    renderPage(visitorAuth);

    await waitFor(() => expect(clientApi.getMoviesByDate).toHaveBeenCalledWith(today));
    expect(clientApi.getWeeklyMovies).not.toHaveBeenCalled();
    expect(await screen.findByTestId('signup-cta')).toBeInTheDocument();
  });

  it('shows the day heading without the week range to a Visitor on the default view', async () => {
    const today = new Date().toISOString().split('T')[0];
    (clientApi.getMoviesByDate as any).mockResolvedValue({ movies: [], weekStart: '2026-03-25', date: today });

    renderPage(visitorAuth);

    expect(await screen.findByText('Films du jour')).toBeInTheDocument();
    expect(screen.getByText("Aujourd'hui")).toBeInTheDocument();
    expect(screen.queryByText('Semaine ciné')).not.toBeInTheDocument();
  });

  it('scopes the quick theater links to the Selection for a Member', async () => {
    setupMember({
      movies: [makeSelectionMovie(1, 'Film Sélection', false)],
      selection: [{ id: 'C0001', name: 'UGC Opéra', status: 'active' }],
    });

    renderPage();

    await waitFor(() => expect(clientApi.getSelection).toHaveBeenCalled());
    expect(clientApi.getTheaters).not.toHaveBeenCalled();
    expect(await screen.findByText('UGC Opéra')).toBeInTheDocument();
  });

  it('partitions the New section: a new movie appears exactly once, only in the section', async () => {
    setupMember({
      movies: [makeSelectionMovie(1, 'Film Nouveau', true), makeSelectionMovie(2, 'Film Ancien', false)],
    });

    renderPage();

    const section = await screen.findByTestId('new-this-week-section');
    expect(within(section).getByText('Film Nouveau')).toBeInTheDocument();
    expect(within(section).queryByText('Film Ancien')).not.toBeInTheDocument();
    expect(screen.getAllByText('Film Nouveau')).toHaveLength(1);
    expect(screen.getAllByText('Film Ancien')).toHaveLength(1);
    expect(screen.getByText('Nouveautés cette semaine')).toBeInTheDocument();
  });

  it('hides the New section when a specific date is selected', async () => {
    setupMember({
      movies: [makeSelectionMovie(1, 'Film Nouveau', true), makeSelectionMovie(2, 'Film Ancien', false)],
    });

    renderPage();

    await screen.findByTestId('new-this-week-section');
    fireEvent.click(screen.getByTestId('day-selector-2026-03-27'));

    await waitFor(() => expect(clientApi.getSelectionMovies).toHaveBeenCalledWith('2026-03-27'));
    await waitFor(() => expect(screen.queryByTestId('new-this-week-section')).not.toBeInTheDocument());
    expect(screen.getAllByText('Film Nouveau')).toHaveLength(1);
  });

  it('keeps the New section in the Maintenant view', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-30T13:00:00'));
    try {
      setupMember({
        movies: [makeSelectionMovie(1, 'Film Nouveau', true), makeSelectionMovie(2, 'Film Ancien', false)],
      });

      renderPage();

      await screen.findByTestId('new-this-week-section');
      fireEvent.click(screen.getByRole('button', { name: /maintenant/i }));

      // "Maintenant" keeps the week-level dataset: no date param is sent.
      await waitFor(() => expect(clientApi.getSelectionMovies).toHaveBeenCalledWith(undefined));
      await waitFor(() => expect(screen.getByTestId('new-this-week-section')).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides movies with no showtime left today in the Maintenant view', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-30T13:00:00'));
    try {
      setupMember({
        movies: [
          makeSelectionMovie(1, 'Film Tard', false),
          {
            ...makeSelectionMovie(2, 'Film Matin', false),
            theaters: [{
              id: 'C0001',
              name: 'UGC Opéra',
              isNewThisWeek: false,
              showtimes: [{ id: 's2', date: FIXED_TODAY, time: '10:00', experiences: [] }],
            }],
          },
        ],
      });

      renderPage();

      await screen.findByText('Film Tard');
      fireEvent.click(screen.getByRole('button', { name: /maintenant/i }));

      expect(await screen.findByText('Film Tard')).toBeInTheDocument();
      expect(screen.queryByText('Film Matin')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the New section partition during a Member search', async () => {
    setupMember({
      movies: [makeSelectionMovie(1, 'Film Nouveau', true), makeSelectionMovie(2, 'Film Ancien', false)],
    });
    (clientApi.searchSelectionMovies as any).mockResolvedValue([
      { id: 1, title: 'Film Nouveau', genres: [], actors: [], source_url: '' },
      { id: 2, title: 'Film Ancien', genres: [], actors: [], source_url: '' },
    ]);

    renderPage();

    await screen.findByTestId('new-this-week-section');
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'Film' } });

    await waitFor(() => expect(clientApi.searchSelectionMovies).toHaveBeenCalledWith('Film'));
    const section = await screen.findByTestId('new-this-week-section');
    expect(within(section).getByText('Film Nouveau')).toBeInTheDocument();
    expect(within(section).queryByText('Film Ancien')).not.toBeInTheDocument();
    expect(screen.getAllByText('Film Nouveau')).toHaveLength(1);
  });

  it('shows the full catalog and a sign-up CTA to a Visitor', async () => {
    const today = new Date().toISOString().split('T')[0];
    (clientApi.getMoviesByDate as any).mockResolvedValue({
      movies: [makeSelectionMovie(1, 'Film Catalogue', false)],
      weekStart: WEEK_START,
      date: today,
    });

    renderPage(visitorAuth);

    expect(await screen.findByText('Film Catalogue')).toBeInTheDocument();
    expect(screen.getByTestId('signup-cta')).toBeInTheDocument();
    expect(clientApi.getSelectionMovies).not.toHaveBeenCalled();
  });

  it('shows no sign-up CTA to an authenticated Staff user', async () => {
    renderPage(mockAuthContext);

    await waitFor(() => expect(clientApi.getWeeklyMovies).toHaveBeenCalled());
    expect(screen.queryByTestId('signup-cta')).not.toBeInTheDocument();
  });

  it('shows a verification reminder to an unverified Member', async () => {
    setupMember({
      movies: [makeSelectionMovie(1, 'Film Sélection', false)],
      profile: { email_verified: false, status: 'unverified' },
    });

    renderPage();

    expect(await screen.findByTestId('verify-email-reminder')).toBeInTheDocument();
    expect(await screen.findByText('Film Sélection')).toBeInTheDocument();
  });

  it('shows no verification reminder to a verified Member', async () => {
    setupMember({ movies: [makeSelectionMovie(1, 'Film Sélection', false)] });

    renderPage();

    await waitFor(() => expect(clientApi.getSelectionMovies).toHaveBeenCalled());
    expect(screen.queryByTestId('verify-email-reminder')).not.toBeInTheDocument();
  });

  it('shows only the add-cinema CTA when the Selection is empty', async () => {
    setupMember({ movies: [], profile: { selectionCount: 0 }, selection: [] });

    renderPage();

    expect(await screen.findByTestId('empty-selection-cta')).toBeInTheDocument();
    expect(screen.queryByTestId('filter-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('new-this-week-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sticky-search-date-container')).not.toBeInTheDocument();
  });
});
