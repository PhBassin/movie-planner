import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsertShowtimes: vi.fn(),
  upsertWeeklyPrograms: vi.fn(),
  upsertMovie: vi.fn(),
  getMovie: vi.fn(),
  parseShowtimesJson: vi.fn(),
  parseMoviePage: vi.fn(),
  delay: vi.fn(),
  browserTransportFetchPage: vi.fn(),
  fetchTransportFetchPage: vi.fn(),
}));

vi.mock('../../db/showtime-queries.js', () => ({
  upsertShowtimes: mocks.upsertShowtimes,
  upsertWeeklyPrograms: mocks.upsertWeeklyPrograms,
}));

vi.mock('../../db/movie-queries.js', () => ({
  upsertMovie: mocks.upsertMovie,
  getMovie: mocks.getMovie,
}));

vi.mock('../theater-json-parser.js', () => ({
  parseShowtimesJson: mocks.parseShowtimesJson,
}));

vi.mock('../movie-parser.js', () => ({
  parseMoviePage: mocks.parseMoviePage,
}));

import {
  AllocineScraperStrategy,
  shouldRefreshMovieDetails,
} from './AllocineScraperStrategy.js';
import type { Transport } from '../transports/transport.js';

const browserTransport: Transport = {
  fetchPage: mocks.browserTransportFetchPage,
};
const fetchTransport: Transport = {
  fetchPage: mocks.fetchTransportFetchPage,
};

function makeStrategy() {
  return new AllocineScraperStrategy(
    browserTransport,
    fetchTransport,
    mocks.delay,
  );
}

describe('shouldRefreshMovieDetails', () => {
  it('returns true when existing movie is missing', () => {
    expect(shouldRefreshMovieDetails(null)).toBe(true);
  });

  it('returns true when trailer_url is missing', () => {
    expect(
      shouldRefreshMovieDetails({
        duration_minutes: 120,
        director: 'Director',
        screenwriters: ['Writer'],
      })
    ).toBe(true);
  });

  it('returns false when all required details exist', () => {
    expect(
      shouldRefreshMovieDetails({
        duration_minutes: 120,
        director: 'Director',
        screenwriters: ['Writer'],
        trailer_url: 'https://www.allocine.fr/video/player_gen_cmedia=99&cfilm=123.html',
      })
    ).toBe(false);
  });
});

describe('AllocineScraperStrategy scrapeTheater detail refresh fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // fetchTransport returns the JSON blob the showtimes API would yield.
    // The strategy does JSON.parse + parseShowtimesJson; the parser is
    // mocked so the test controls the parsed shape.
    mocks.fetchTransportFetchPage.mockImplementation(async (url: string) => {
      if (url.includes('/_/showtimes/')) {
        return { html: JSON.stringify({ results: [] }) };
      }
      if (url.includes('/film/fichefilm')) {
        return { html: '<html></html>' };
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    mocks.parseShowtimesJson.mockReturnValue([
      {
        movie: {
          id: 123,
          title: 'Test Movie',
          genres: [],
          actors: [],
          source_url: 'https://www.allocine.fr/film/fichefilm_gen_cfilm=123.html',
        },
        showtimes: [{ week_start: '2026-03-25' }],
        is_new_this_week: false,
      },
    ]);

    mocks.getMovie.mockResolvedValue({
      duration_minutes: 120,
      director: undefined,
      screenwriters: ['Existing Writer'],
      trailer_url: 'https://www.allocine.fr/video/player_gen_cmedia=99&cfilm=123.html',
    });

    // fetchTransport for the movie page throws — the strategy catches and
    // logs, then falls back to the existing trailer_url.
    mocks.parseMoviePage.mockReturnValue({});

    mocks.upsertShowtimes.mockResolvedValue(undefined);
    mocks.upsertMovie.mockResolvedValue(undefined);
    mocks.upsertWeeklyPrograms.mockResolvedValue(undefined);
    mocks.delay.mockResolvedValue(undefined);
  });

  it('preserves existing trailer_url when movie detail fetch fails', async () => {
    const strategy = makeStrategy();

    await strategy.scrapeTheater(
      {} as any,
      {
        id: 'C0001',
        name: 'Theater Test',
        url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0001.html',
        source: 'allocine',
      },
      '2026-03-28',
      500
    );

    expect(mocks.upsertMovie).toHaveBeenCalledTimes(1);
    const upsertedMovie = mocks.upsertMovie.mock.calls[0][1];
    expect(upsertedMovie.trailer_url).toBe(
      'https://www.allocine.fr/video/player_gen_cmedia=99&cfilm=123.html'
    );
  });

  it('applies movie delay even when movie detail fetch fails', async () => {
    const strategy = makeStrategy();

    await strategy.scrapeTheater(
      {} as any,
      {
        id: 'C0001',
        name: 'Theater Test',
        url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0001.html',
        source: 'allocine',
      },
      '2026-03-28',
      750
    );

    expect(mocks.delay).toHaveBeenCalledWith(750);
  });

  it('builds the showtimes URL via the fetch transport, not the browser transport', async () => {
    const strategy = makeStrategy();

    await strategy.scrapeTheater(
      {} as any,
      {
        id: 'C0001',
        name: 'Theater Test',
        url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0001.html',
        source: 'allocine',
      },
      '2026-03-28',
      500
    );

    // The browser transport is for JS-rendered pages only; showtimes go
    // through the fetch transport. Puppeteer never gets called.
    expect(mocks.browserTransportFetchPage).not.toHaveBeenCalled();
    expect(mocks.fetchTransportFetchPage).toHaveBeenCalledWith(
      'https://www.allocine.fr/_/showtimes/theater-C0001/d-2026-03-28/'
    );
  });
});
