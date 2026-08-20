import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MovieService } from './movie-service.js';
import * as movieQueries from '../db/movie-queries.js';
import * as showtimeQueries from '../db/showtime-queries.js';
import * as selectionQueries from '../db/selection-queries.js';
import { type DB } from '../db/index.js';

vi.mock('../db/movie-queries.js');
vi.mock('../db/showtime-queries.js');
vi.mock('../db/selection-queries.js');
vi.mock('../utils/showtimes.js', () => ({
  groupShowtimesByTheater: vi.fn().mockImplementation((s) => s),
}));

import { groupShowtimesByTheater } from '../utils/showtimes.js';

// Faithful stand-in for the real groupShowtimesByTheater: groups showtime rows
// into theater entries keyed by theater_id (shape the overlay relies on).
const faithfulGroup = (showtimes: any[]) => {
  const byTheater = new Map<string, any>();
  for (const s of showtimes) {
    let entry = byTheater.get(s.theater_id);
    if (!entry) {
      entry = { ...s.theater, showtimes: [] };
      byTheater.set(s.theater_id, entry);
    }
    entry.showtimes.push(s);
  }
  return Array.from(byTheater.values());
};

describe('MovieService', () => {
  let movieService: MovieService;
  const mockDb = {} as DB;

  beforeEach(() => {
    vi.clearAllMocks();
    movieService = new MovieService(mockDb);
  });

  describe('getMoviesForWeek', () => {
    it('should fetch and merge movies and showtimes', async () => {
      vi.mocked(movieQueries.getWeeklyMovies).mockResolvedValue([{ id: 1 }] as any);
      vi.mocked(showtimeQueries.getWeeklyShowtimes).mockResolvedValue([{ movie_id: 1, id: 's1' }] as any);

      const result = await movieService.getMoviesForWeek('2026-03-11');

      expect(result).toHaveLength(1);
      expect(result[0].theaters).toBeDefined();
    });
  });

  describe('getMoviesForDate', () => {
    it('should fetch and merge movies and showtimes for a date', async () => {
      vi.mocked(movieQueries.getMoviesByDate).mockResolvedValue([{ id: 1 }] as any);
      vi.mocked(showtimeQueries.getShowtimesByDate).mockResolvedValue([{ movie_id: 1, id: 's1' }] as any);

      const result = await movieService.getMoviesForDate('2026-03-12', '2026-03-11');

      expect(result).toHaveLength(1);
    });
  });

  describe('getMovieById', () => {
    it('should return null if movie not found', async () => {
      vi.mocked(movieQueries.getMovie).mockResolvedValue(undefined);
      const result = await movieService.getMovieById(999, '2026-03-11');
      expect(result).toBeNull();
    });

    it('should return movie with showtimes if found', async () => {
      vi.mocked(movieQueries.getMovie).mockResolvedValue({ id: 1, title: 'Movie' } as any);
      vi.mocked(showtimeQueries.getShowtimesByMovieAndWeek).mockResolvedValue([{ id: 's1' }] as any);

      const result = await movieService.getMovieById(1, '2026-03-11');

      expect(result?.title).toBe('Movie');
      expect(result?.theaters).toBeDefined();
    });

    it('should hide a movie with no active theater showtimes', async () => {
      vi.mocked(movieQueries.getMovie).mockResolvedValue({ id: 1, title: 'Movie' } as any);
      vi.mocked(showtimeQueries.getShowtimesByMovieAndWeek).mockResolvedValue([]);

      await expect(movieService.getMovieById(1, '2026-03-11')).resolves.toBeNull();
    });
  });

  describe('search', () => {
    it('should call searchMovies query', async () => {
      vi.mocked(movieQueries.searchMovies).mockResolvedValue([]);
      await movieService.search('test', 5);
      expect(movieQueries.searchMovies).toHaveBeenCalledWith(mockDb, 'test', 5);
    });
  });
  describe('getSelectionMoviesForWeek', () => {
    it('returns an empty list without querying movies when the Selection is empty', async () => {
      vi.mocked(selectionQueries.getSelection).mockResolvedValue([]);

      const result = await movieService.getSelectionMoviesForWeek(7, '2026-03-11');

      expect(result).toEqual([]);
      expect(movieQueries.getWeeklyMoviesForTheaters).not.toHaveBeenCalled();
      expect(showtimeQueries.getWeeklyShowtimesForTheaters).not.toHaveBeenCalled();
    });

    it('merges Selection-scoped movies and showtimes, overlaying newness per theater and per movie', async () => {
      vi.mocked(groupShowtimesByTheater).mockImplementation(faithfulGroup as any);
      vi.mocked(selectionQueries.getSelection).mockResolvedValue([
        { id: 'C0001' } as any,
        { id: 'C0002' } as any,
      ]);
      vi.mocked(movieQueries.getWeeklyMoviesForTheaters).mockResolvedValue([
        {
          id: 1,
          title: 'Film A',
          theaters: [
            { id: 'C0001', isNewThisWeek: true },
            { id: 'C0002', isNewThisWeek: false },
          ],
        },
        {
          id: 2,
          title: 'Film B',
          theaters: [{ id: 'C0002', isNewThisWeek: false }],
        },
      ] as any);
      vi.mocked(showtimeQueries.getWeeklyShowtimesForTheaters).mockResolvedValue([
        { movie_id: 1, theater_id: 'C0001', id: 's1', theater: { id: 'C0001' } },
        { movie_id: 1, theater_id: 'C0002', id: 's2', theater: { id: 'C0002' } },
        { movie_id: 2, theater_id: 'C0002', id: 's3', theater: { id: 'C0002' } },
      ] as any);

      const result = await movieService.getSelectionMoviesForWeek(7, '2026-03-11');

      expect(movieQueries.getWeeklyMoviesForTheaters).toHaveBeenCalledWith(mockDb, '2026-03-11', ['C0001', 'C0002']);
      expect(showtimeQueries.getWeeklyShowtimesForTheaters).toHaveBeenCalledWith(mockDb, '2026-03-11', ['C0001', 'C0002']);
      expect(result).toHaveLength(2);
      expect(result[0].isNewThisWeek).toBe(true);
      expect(result[0].theaters.find((t: any) => t.id === 'C0001').isNewThisWeek).toBe(true);
      expect(result[0].theaters.find((t: any) => t.id === 'C0002').isNewThisWeek).toBe(false);
      expect(result[1].isNewThisWeek).toBe(false);
    });
  });

  describe('getSelectionMoviesForDate', () => {
    it('returns an empty list without querying when the Selection is empty', async () => {
      vi.mocked(selectionQueries.getSelection).mockResolvedValue([]);

      const result = await movieService.getSelectionMoviesForDate(7, '2026-03-12', '2026-03-11');

      expect(result).toEqual([]);
      expect(movieQueries.getMoviesByDateForTheaters).not.toHaveBeenCalled();
      expect(showtimeQueries.getShowtimesByDateForTheaters).not.toHaveBeenCalled();
    });

    it('scopes the date view to the Selection and keeps newness data', async () => {
      vi.mocked(groupShowtimesByTheater).mockImplementation(faithfulGroup as any);
      vi.mocked(selectionQueries.getSelection).mockResolvedValue([{ id: 'C0001' }] as any);
      vi.mocked(movieQueries.getMoviesByDateForTheaters).mockResolvedValue([
        { id: 1, title: 'Film A', theaters: [{ id: 'C0001', isNewThisWeek: true }] },
      ] as any);
      vi.mocked(showtimeQueries.getShowtimesByDateForTheaters).mockResolvedValue([
        { movie_id: 1, theater_id: 'C0001', id: 's1', theater: { id: 'C0001' } },
      ] as any);

      const result = await movieService.getSelectionMoviesForDate(7, '2026-03-12', '2026-03-11');

      expect(movieQueries.getMoviesByDateForTheaters).toHaveBeenCalledWith(mockDb, '2026-03-12', '2026-03-11', ['C0001']);
      expect(showtimeQueries.getShowtimesByDateForTheaters).toHaveBeenCalledWith(mockDb, '2026-03-12', '2026-03-11', ['C0001']);
      expect(result[0].isNewThisWeek).toBe(true);
      expect(result[0].theaters[0].isNewThisWeek).toBe(true);
    });
  });

});
