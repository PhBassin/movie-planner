import type { DB } from '../db/index.js';
import { getShowtimesByDate, getShowtimesByMovieAndWeek, getWeeklyShowtimes, getShowtimesForTheaters, type SelectionScope } from '../db/showtime-queries.js';
import { getWeeklyMovies, getMoviesByDate, getMovie, searchMovies, searchMoviesForTheaters, getSelectionMoviesForTheaters, type SelectionMovie } from '../db/movie-queries.js';
import { getSelection } from '../db/selection-queries.js';
import { groupShowtimesByTheater } from '../utils/showtimes.js';
import type { MovieWithShowtimes, Showtime, Theater } from '../types/scraper.js';

export class MovieService {
  constructor(private db: DB) {}

  async getMoviesForWeek(weekStart: string): Promise<MovieWithShowtimes[]> {
    // ⚡ PERFORMANCE: Run independent DB queries concurrently to reduce total response time
    const [movies, allShowtimes] = await Promise.all([
      getWeeklyMovies(this.db, weekStart),
      getWeeklyShowtimes(this.db, weekStart)
    ]);
    return this.mergeMoviesAndShowtimes(movies, allShowtimes);
  }

  async getMoviesForDate(dateParam: string, weekStart: string): Promise<MovieWithShowtimes[]> {
    // ⚡ PERFORMANCE: Run independent DB queries concurrently to reduce total response time
    const [movies, allShowtimes] = await Promise.all([
      getMoviesByDate(this.db, dateParam, weekStart),
      getShowtimesByDate(this.db, dateParam, weekStart)
    ]);
    return this.mergeMoviesAndShowtimes(movies, allShowtimes);
  }

  async getMovieById(movieId: number, weekStart: string): Promise<MovieWithShowtimes | null> {
    const [movie, showtimes] = await Promise.all([
      getMovie(this.db, movieId),
      getShowtimesByMovieAndWeek(this.db, movieId, weekStart)
    ]);

    if (!movie) {
      return null;
    }

    if (showtimes.length === 0) {
      return null;
    }

    return {
      ...movie,
      theaters: groupShowtimesByTheater(showtimes)
    };
  }

  async search(query: string, limit: number = 10) {
    return searchMovies(this.db, query, limit);
  }

  async searchSelection(memberId: number, query: string, limit: number = 10) {
    const theaterIds = await this.getSelectionTheaterIds(memberId);
    if (theaterIds.length === 0) {
      return [];
    }
    return searchMoviesForTheaters(this.db, query, theaterIds, limit);
  }

  async getSelectionMoviesForWeek(memberId: number, weekStart: string): Promise<MovieWithShowtimes[]> {
    return this.getSelectionMovies(memberId, { weekStart });
  }

  async getSelectionMoviesForDate(memberId: number, date: string, weekStart: string): Promise<MovieWithShowtimes[]> {
    return this.getSelectionMovies(memberId, { weekStart, date });
  }

  private async getSelectionMovies(
    memberId: number,
    scope: Omit<SelectionScope, 'theaterIds'>,
  ): Promise<MovieWithShowtimes[]> {
    const theaterIds = await this.getSelectionTheaterIds(memberId);
    if (theaterIds.length === 0) {
      return [];
    }

    const selectionScope = { ...scope, theaterIds };
    const [movies, allShowtimes] = await Promise.all([
      getSelectionMoviesForTheaters(this.db, selectionScope),
      getShowtimesForTheaters(this.db, selectionScope),
    ]);
    return this.mergeSelectionMoviesAndShowtimes(movies, allShowtimes);
  }

  private async getSelectionTheaterIds(memberId: number): Promise<string[]> {
    const selection = await getSelection(this.db, memberId);
    return selection.map(theater => theater.id);
  }

  /**
   * Merge Selection-scoped movies with their showtimes: each movie keeps the
   * theaters carried by its own rows — the authoritative list for the New
   * section badges — and only gains the showtimes matching that theater. The
   * movie itself is flagged when at least one of its selected theaters
   * programs it newly this week.
   */
  private mergeSelectionMoviesAndShowtimes(
    movies: SelectionMovie[],
    allShowtimes: Array<Showtime & { theater: Theater }>
  ): MovieWithShowtimes[] {
    const showtimesByMovie = new Map<number, Map<string, Showtime[]>>();
    for (const showtime of allShowtimes) {
      let byTheater = showtimesByMovie.get(showtime.movie_id);
      if (!byTheater) {
        byTheater = new Map();
        showtimesByMovie.set(showtime.movie_id, byTheater);
      }
      const { theater: _theater, ...showtimeOnly } = showtime;
      byTheater.set(showtime.theater_id, [...(byTheater.get(showtime.theater_id) ?? []), showtimeOnly]);
    }

    return movies.map(movie => {
      const byTheater = showtimesByMovie.get(movie.id);
      const theaters = movie.theaters.map(theater => ({
        ...theater,
        showtimes: byTheater?.get(theater.id) ?? [],
      }));
      return {
        ...movie,
        theaters,
        isNewThisWeek: theaters.some(theater => theater.isNewThisWeek),
      };
    });
  }

  private mergeMoviesAndShowtimes(movies: any[], allShowtimes: any[]): MovieWithShowtimes[] {
    const showtimesByMovie = new Map<number, Array<Showtime & { theater: Theater }>>();
    
    for (const s of allShowtimes) {
      if (!showtimesByMovie.has(s.movie_id)) {
        showtimesByMovie.set(s.movie_id, []);
      }
      showtimesByMovie.get(s.movie_id)!.push(s);
    }

    return movies.map(f => ({
      ...f,
      theaters: groupShowtimesByTheater(showtimesByMovie.get(f.id) || [])
    }));
  }
}
