import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

const mockUpsertTheater = vi.fn().mockResolvedValue(undefined);
const mockActivateTheater = vi.fn().mockResolvedValue(undefined);
const mockBrowserTransportFetchPage = vi.fn();
const mockFetchTransportFetchPage = vi.fn();
const mockParseTheaterPage = vi.fn();
const mockParseShowtimesJson = vi.fn().mockReturnValue([]);

vi.mock('../../../src/db/movie-queries.js', () => ({
  upsertMovie: vi.fn(),
  getMovie: vi.fn(),
}));

vi.mock('../../../src/db/showtime-queries.js', () => ({
  upsertShowtimes: vi.fn(),
  upsertWeeklyPrograms: vi.fn(),
}));

vi.mock('../../../src/db/theater-queries.js', () => ({
  upsertTheater: (...args: any[]) => mockUpsertTheater(...args),
  activateTheater: (...args: any[]) => mockActivateTheater(...args),
  getTheaters: vi.fn(),
  getTheaterConfigs: vi.fn(),
}));

vi.mock('../../../src/scraper/transports/puppeteer-transport.js', () => ({
  PuppeteerTransport: class {
    fetchPage = mockBrowserTransportFetchPage;
  },
  closeBrowser: vi.fn(),
}));

vi.mock('../../../src/scraper/transports/fetch-transport.js', () => ({
  FetchTransport: class {
    fetchPage = mockFetchTransportFetchPage;
  },
}));

vi.mock('../../../src/scraper/theater-parser.js', () => ({
  parseTheaterPage: mockParseTheaterPage,
}));

vi.mock('../../../src/scraper/theater-json-parser.js', () => ({
  parseShowtimesJson: mockParseShowtimesJson,
}));

vi.mock('../../../src/scraper/movie-parser.js', () => ({
  parseMoviePage: vi.fn(),
}));

vi.mock('../../../src/db/client.js', () => ({
  db: {},
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/utils/date.js', () => ({
  getScrapeDates: vi.fn().mockReturnValue([]),
  getWeekStartForDate: vi.fn().mockReturnValue('2026-03-09'),
}));

// --- Tests ---

describe('loadTheaterMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves the theater URL from the config when upserting', async () => {
    const theaterConfig = {
      id: 'C0072',
      name: 'Test Theater',
      url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0072.html',
    };

    const parsedTheater = {
      id: 'C0072',
      name: 'Test Theater From HTML',
      address: '1 rue de la Paix',
      city: 'Paris',
      // url is NOT present — parser does not extract it
    };

    mockBrowserTransportFetchPage.mockResolvedValue({
      html: '<html></html>',
      availableDates: ['2026-03-10'],
    });

    mockParseTheaterPage.mockReturnValue({
      theater: parsedTheater,
      movies: [],
    });

    // Dynamically import to pick up mocks
    const { loadTheaterMetadata } = await import('../../../src/scraper/index.js');

    await loadTheaterMetadata({} as any, theaterConfig);

    // upsertTheater must be called with the URL merged in from the config
    expect(mockUpsertTheater).toHaveBeenCalledOnce();
    const upsertedTheater = mockUpsertTheater.mock.calls[0][1];
    expect(upsertedTheater.url).toBe(theaterConfig.url);
  });

  it('returns the merged theater object (with url) not just the parsed theater', async () => {
    const theaterConfig = {
      id: 'C0072',
      name: 'Test Theater',
      url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0072.html',
    };

    const parsedTheater = {
      id: 'C0072',
      name: 'Test Theater From HTML',
    };

    mockBrowserTransportFetchPage.mockResolvedValue({
      html: '<html></html>',
      availableDates: ['2026-03-10', '2026-03-11'],
    });

    mockParseTheaterPage.mockReturnValue({
      theater: parsedTheater,
      movies: [],
    });

    const { loadTheaterMetadata } = await import('../../../src/scraper/index.js');

    const result = await loadTheaterMetadata({} as any, theaterConfig);

    expect(result.theater.url).toBe(theaterConfig.url);
    expect(result.availableDates).toEqual(['2026-03-10', '2026-03-11']);
  });
});

describe('addTheaterAndScrape', () => {
  const VALID_URL = 'https://www.allocine.fr/seance/salle_gen_csalle=C0072.html';

  const parsedTheater = {
    id: 'C0072',
    name: 'Theater Test',
    address: '1 rue de la Paix',
    city: 'Paris',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowserTransportFetchPage.mockResolvedValue({
      html: '<html></html>',
      availableDates: ['2026-03-10'],
    });
    mockParseTheaterPage.mockReturnValue({ theater: parsedTheater, movies: [] });
    mockFetchTransportFetchPage.mockResolvedValue({ html: '{}' });
    mockParseShowtimesJson.mockReturnValue([]);
  });

  it('should reject invalid Allociné URLs', async () => {
    const { addTheaterAndScrape } = await import('../../../src/scraper/index.js');

    await expect(addTheaterAndScrape({} as any, 'not-a-url')).rejects.toThrow(
      /no scraper strategy found for url/i
    );
    await expect(addTheaterAndScrape({} as any, 'https://www.google.com/path')).rejects.toThrow(
      /no scraper strategy found for url/i
    );
  });

  it('should reject URLs from non-allocine domains', async () => {
    const { addTheaterAndScrape } = await import('../../../src/scraper/index.js');

    await expect(
      addTheaterAndScrape({} as any, 'https://evil.com/seance/salle_gen_csalle=C0072.html')
    ).rejects.toThrow(/no scraper strategy found for url/i);
  });

  it('should reject valid-looking URLs without a theater ID', async () => {
    const { addTheaterAndScrape } = await import('../../../src/scraper/index.js');

    await expect(
      addTheaterAndScrape({} as any, 'https://www.allocine.fr/seance/salle_gen_csalle=.html')
    ).rejects.toThrow(/theater id/i);
  });

  it('should call loadTheaterMetadata with cleaned URL and extracted theater ID', async () => {
    const { addTheaterAndScrape } = await import('../../../src/scraper/index.js');

    const dirtyUrl = 'https://www.allocine.fr/seance/salle_gen_csalle=C0072.html?utm_source=test';

    await addTheaterAndScrape({} as any, dirtyUrl);

    expect(mockBrowserTransportFetchPage).toHaveBeenCalledOnce();
    const calledUrl: string = mockBrowserTransportFetchPage.mock.calls[0][0];
    // URL should be cleaned (no query params)
    expect(calledUrl).not.toContain('utm_source');
    expect(calledUrl).toContain('C0072');
  });

  it('should scrape all available dates', async () => {
    const { addTheaterAndScrape } = await import('../../../src/scraper/index.js');

    mockBrowserTransportFetchPage.mockResolvedValue({
      html: '<html></html>',
      availableDates: ['2026-03-10', '2026-03-11', '2026-03-12'],
    });

    await addTheaterAndScrape({} as any, VALID_URL);

    // fetchTransport.fetchPage called once per date
    expect(mockFetchTransportFetchPage).toHaveBeenCalledTimes(3);
  });

  it('should return the upserted theater data with URL', async () => {
    const { addTheaterAndScrape } = await import('../../../src/scraper/index.js');

    const result = await addTheaterAndScrape({} as any, VALID_URL);

    expect(result).toMatchObject({ id: 'C0072', name: 'Theater Test' });
    expect(result.url).toBe(VALID_URL);
    expect(mockActivateTheater).toHaveBeenCalledWith(expect.anything(), 'C0072');
  });

  it('should emit progress events when publisher provided', async () => {
    const { addTheaterAndScrape } = await import('../../../src/scraper/index.js');

    mockBrowserTransportFetchPage.mockResolvedValue({
      html: '<html></html>',
      availableDates: ['2026-03-10'],
    });

    const mockPublisher = { emit: vi.fn().mockResolvedValue(undefined) };

    await addTheaterAndScrape({} as any, VALID_URL, mockPublisher);

    expect(mockPublisher.emit).toHaveBeenCalled();
  });

  it('should continue scraping remaining dates even if one date fails', async () => {
    const { addTheaterAndScrape } = await import('../../../src/scraper/index.js');

    mockBrowserTransportFetchPage.mockResolvedValue({
      html: '<html></html>',
      availableDates: ['2026-03-10', '2026-03-11'],
    });

    // First date fails, second succeeds
    mockFetchTransportFetchPage
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ html: '{}' });

    // Should not throw — errors on individual dates are swallowed
    await expect(addTheaterAndScrape({} as any, VALID_URL)).resolves.toBeDefined();
    expect(mockFetchTransportFetchPage).toHaveBeenCalledTimes(2);
  });

  it('should leave the theater provisioning when every date scrape fails', async () => {
    const { addTheaterAndScrape } = await import('../../../src/scraper/index.js');

    mockBrowserTransportFetchPage.mockResolvedValue({
      html: '<html></html>',
      availableDates: ['2026-03-10', '2026-03-11'],
    });
    mockFetchTransportFetchPage.mockRejectedValue(new Error('Network error'));

    await expect(addTheaterAndScrape({} as any, VALID_URL)).rejects.toThrow('failed');
    expect(mockActivateTheater).not.toHaveBeenCalled();
  });
});
