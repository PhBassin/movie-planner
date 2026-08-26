import type { DB } from '../db/index.js';
import { getShowtimesByDate, getShowtimesByDateForTheaters, getShowtimesByMovieAndWeek, getWeeklyShowtimes, getWeeklyShowtimesForTheaters } from '../db/showtime-queries.js';
import { getWeeklyMovies, getMoviesByDate, getMovie, searchMovies, searchMoviesForTheaters, getWeeklyMoviesForTheaters, getMoviesByDateForTheaters, type SelectionMovie } from '../db/movie-queries.js';
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
    return this.getSelectionMovies(
      memberId,
      (theaterIds) => getWeeklyMoviesForTheaters(this.db, weekStart, theaterIds),
      (theaterIds) => getWeeklyShowtimesForTheaters(this.db, weekStart, theaterIds),
    );
  }

  async getSelectionMoviesForDate(memberId: number, date: string, weekStart: string): Promise<MovieWithShowtimes[]> {
    return this.getSelectionMovies(
      memberId,
      (theaterIds) => getMoviesByDateForTheaters(this.db, date, weekStart, theaterIds),
      (theaterIds) => getShowtimesByDateForTheaters(this.db, date, weekStart, theaterIds),
    );
  }

  private async getSelectionMovies(
    memberId: number,
    getMovies: (theaterIds: string[]) => Promise<SelectionMovie[]>,
    getShowtimes: (theaterIds: string[]) => Promise<Array<Showtime & { theater: Theater }>>,
  ): Promise<MovieWithShowtimes[]> {
    const theaterIds = await this.getSelectionTheaterIds(memberId);
    if (theaterIds.length === 0) {
      return [];
    }

    const [movies, allShowtimes] = await Promise.all([getMovies(theaterIds), getShowtimes(theaterIds)]);
    return this.mergeSelectionMoviesAndShowtimes(movies, allShowtimes);
  }

  private async getSelectionTheaterIds(memberId: number): Promise<string[]> {
    const selection = await getSelection(this.db, memberId);
    return selection.map(theater => theater.id);
  }

  /**
   * Merge Selection-scoped movies with their showtimes, then overlay the
   * per-theater newness carried by the movie rows: each theater entry gains
   * `isNewThisWeek`, and the movie itself is flagged when at least one of its
   * selected theaters programs it newly this week.
   */
  private mergeSelectionMoviesAndShowtimes(
    movies: SelectionMovie[],
    allShowtimes: Array<Showtime & { theater: Theater }>
  ): MovieWithShowtimes[] {
    const merged = this.mergeMoviesAndShowtimes(movies, allShowtimes);

    const newnessByMovieTheater = new Map<string, boolean>();
    for (const movie of movies) {
      for (const theater of movie.theaters) {
        newnessByMovieTheater.set(`${movie.id}|${theater.id}`, theater.isNewThisWeek);
      }
    }

    return merged.map(movie => {
      const theaters = movie.theaters.map(theater => ({
        ...theater,
        isNewThisWeek: newnessByMovieTheater.get(`${movie.id}|${theater.id}`) ?? false,
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
