import { useContext, useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getWeeklyMovies, getMoviesByDate, getSelectionMovies, searchSelectionMovies, getTheaters, getMemberProfile, getSelection, addTheater } from '../api/client.js';
import MovieCard from '../components/MovieCard.js';
import FilterBar from '../components/FilterBar.js';
import ScrollToTop from '../components/ScrollToTop.js';
import { AuthContext } from '../contexts/AuthContext.js';
import TheatersQuickLinks from '../components/TheatersQuickLinks.js';
import { LoadingSpinner, ErrorMessage } from '../components/ui/PageStates.js';
import { useDateTimeFilter } from '../hooks/useDateTimeFilter.js';
import type { Movie } from '../types';
import { getTodayDate } from '../utils/date.js';

export default function HomePage() {
  const queryClient = useQueryClient();
  const { selectedDate, afterTime, selectDate, selectNow, resetAll } = useDateTimeFilter();
  const { isAuthenticated, user, hasPermission } = useContext(AuthContext);
  const isMember = isAuthenticated && user?.role_name === 'member';
  const isVisitorToday = !isAuthenticated && !selectedDate;
  const [searchResults, setSearchResults] = useState<Movie[] | null>(null);
  const [resetKey, setResetKey] = useState(0);

  // "Maintenant" is a from-now filter over the week dataset, not a day
  // narrowing: it keeps `selectedDate` set (to today) alongside `afterTime`.
  const isMaintenant = afterTime !== null;
  // The view is narrowed to one specific date picked in the day selector.
  // The Visitor default (today's catalog) is not a narrowing, and neither is
  // "Maintenant".
  const isSpecificDateView = selectedDate !== '' && !isMaintenant;

  const profileQuery = useQuery({
    queryKey: ['me'],
    queryFn: getMemberProfile,
    enabled: isMember,
  });
  const profile = profileQuery.data;

  const { data: theaters = [], isLoading: isLoadingTheaters } = useQuery({
    queryKey: isMember ? ['selection'] : ['theaters'],
    queryFn: () => (isMember ? getSelection() : getTheaters()),
  });

  const { data: moviesData, isLoading: isLoadingMovies, error: moviesError } = useQuery({
    queryKey: isMember ? ['selection-movies', selectedDate] : ['movies', selectedDate],
    queryFn: () =>
      isMember
        ? // "Maintenant" keeps the week-level dataset (the New section is a
          // week concept) and filters from now client-side.
          getSelectionMovies(isSpecificDateView ? selectedDate : undefined)
        : selectedDate
          ? getMoviesByDate(selectedDate)
          : isAuthenticated
            ? getWeeklyMovies()
            : getMoviesByDate(getTodayDate()),
  });

  const allMovies = useMemo(() => moviesData?.movies || [], [moviesData]);
  // When "Maintenant" is active, hide movies with no showtime left on the
  // selected day. When search is active, filter by search results.
  const movies = useMemo(() => {
    let filtered = allMovies;

    if (afterTime) {
      const day = selectedDate || getTodayDate();
      filtered = filtered.filter(movie =>
        movie.theaters.some(c => c.showtimes.some(s => s.date === day && s.time >= afterTime))
      );
    }

    if (searchResults !== null) {
      const searchIds = new Set(searchResults.map(m => m.id));
      filtered = filtered.filter(movie => searchIds.has(movie.id));
    }

    return filtered;
  }, [allMovies, afterTime, selectedDate, searchResults]);
  const weekStart = moviesData?.weekStart || '';

  // A Member's homepage waits for the profile too — it decides the empty-Selection state.
  const isLoading = isLoadingTheaters || isLoadingMovies || (isMember && profileQuery.isLoading);
  const error = moviesError instanceof Error ? moviesError.message : null;

  // The New section is a week-level concept: it shows in the week and
  // "Maintenant" views and hides when the view is narrowed to a single date.
  const newThisWeekMovies = isSpecificDateView ? [] : movies.filter(movie => movie.isNewThisWeek);
  const continuingMovies = isSpecificDateView ? movies : movies.filter(movie => !movie.isNewThisWeek);
  const selectionEmpty = isMember && profile !== undefined && profile.selectionCount === 0;

  const handleDateSelect = useCallback((date: string | null) => {
    selectDate(date || '');
  }, [selectDate]);

  const handleFilter = useCallback((movies: Movie[] | null) => {
    setSearchResults(movies);
  }, []);

  const handleReset = useCallback(() => {
    resetAll();
    setSearchResults(null);
    setResetKey(k => k + 1);
  }, [resetAll]);
  const formatterDate = useMemo(() => new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }), []);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '';
    return formatterDate.format(date);
  };

  const getWeekEndDate = (startStr: string) => {
    if (!startStr) return '';
    const start = new Date(startStr);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return formatDate(end.toISOString());
  };

  const addTheaterMutation = useMutation({
    mutationFn: addTheater,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theaters'] });
      queryClient.invalidateQueries({ queryKey: ['movies', selectedDate] });
    },
    onError: (err: Error) => {
      alert(err.message || 'Erreur lors de l\'ajout du cinéma');
    }
  });

  const handleAddTheater = useCallback(async () => {
    const url = window.prompt("Entrez l'URL Allociné du cinéma à ajouter (ex: https://www.allocine.fr/seance/salle_affich-salle=C0013.html):");
    if (!url) return;

    addTheaterMutation.mutate(url);
  }, [addTheaterMutation]);

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;

  // Empty Selection: the whole homepage is the add-cinema call to action.
  if (selectionEmpty) {
    return (
      <div className="max-w-5xl mx-auto">
        <div className="bg-gray-50 rounded-2xl p-12 text-center border-2 border-dashed border-gray-200">
          <h1 className="text-2xl font-bold mb-3">Votre sélection est vide</h1>
          <p className="text-gray-600 mb-6 max-w-md mx-auto">
            Ajoutez des cinémas à votre sélection pour voir leurs programmes sur votre page d'accueil.
          </p>
          <Link
            to="/cinemas"
            data-testid="empty-selection-cta"
            className="inline-block px-6 py-3 bg-primary text-black font-bold rounded-lg hover:opacity-90 transition"
          >
            Choisir mes cinémas
          </Link>
        </div>
        <ScrollToTop />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Verification reminder — unverified Members keep the full homepage */}
      {isMember && profile && !profile.email_verified && (
        <div
          data-testid="verify-email-reminder"
          className="mb-4 bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-3 text-sm text-yellow-800"
        >
          Votre adresse e-mail n'est pas encore vérifiée. Vérifiez votre boîte de réception
          pour pouvoir soumettre de nouveaux cinémas.
        </div>
      )}

      {/* Sign-up call to action — Visitors see the full catalog, non-blocking */}
      {!isAuthenticated && (
        <div
          data-testid="signup-cta"
          className="mb-4 bg-white border border-gray-100 shadow-sm rounded-xl px-4 py-3 flex items-center justify-between gap-4 flex-wrap"
        >
          <p className="text-gray-700 text-sm font-medium">
            Créez un compte pour sélectionner vos cinémas et suivre leurs programmes sur une page personnalisée.
          </p>
          <Link
            to="/signup"
            className="px-4 py-2 bg-primary text-black text-sm font-bold rounded-lg hover:opacity-90 transition"
          >
            Créer un compte
          </Link>
        </div>
      )}

      {/* Title and Date Info */}
      <div className="mb-4">
        <h1 className="text-4xl font-bold mb-3">
          {selectedDate || isVisitorToday ? 'Films du jour' : 'Au programme cette semaine'}
        </h1>
        {weekStart && !selectedDate && !isVisitorToday && (
          <div className="flex items-center gap-2 text-gray-500 font-medium">
            <span className="bg-gray-100 px-2 py-0.5 rounded text-sm">Semaine ciné</span>
            <span>Du {formatDate(weekStart)} au {getWeekEndDate(weekStart)}</span>
          </div>
        )}
        {(selectedDate || isVisitorToday) && (
          <div className="flex items-center gap-2 text-gray-500 font-medium">
            <span className="bg-gray-100 px-2 py-0.5 rounded text-sm">
              {selectedDate ? 'Date sélectionnée' : "Aujourd'hui"}
            </span>
            <span>{formatDate(selectedDate || getTodayDate())}</span>
          </div>
        )}
      </div>

      {/* Sticky Unified Filter Bar — stays visible while scrolling */}
      <div
        className="sticky z-40 bg-gray-50/95 backdrop-blur-sm pt-3 pb-3 mb-4 shadow-sm -mx-4 px-4"
        style={{ top: 'var(--layout-header-offset, 64px)' }}
        data-testid="sticky-search-date-container"
      >
        {weekStart && (
          <FilterBar
            weekStart={weekStart}
            selectedDate={selectedDate}
            onSelectDate={handleDateSelect}
            onNow={selectNow}
            isNowActive={afterTime !== null}
            onFilter={handleFilter}
            searchFn={isMember ? searchSelectionMovies : undefined}
            onReset={handleReset}
            resetKey={resetKey}
          />
        )}
      </div>

      {/* Quick Theater Links - Below sticky header */}
      <TheatersQuickLinks
        theaters={theaters}
        canAddTheater={isAuthenticated && hasPermission('theaters:create')}
        onAddTheater={handleAddTheater}
      />

      {/* New this week — a partition: these movies appear only here */}
      {newThisWeekMovies.length > 0 && (
        <section data-testid="new-this-week-section" className="mb-8">
          <h2 className="text-2xl font-bold mb-4">Nouveautés cette semaine</h2>
          <div className="space-y-6">
            {newThisWeekMovies.map((movie) => (
              <MovieCard key={movie.id} movie={movie} isNew initialAfterTime={afterTime} />
            ))}
          </div>
        </section>
      )}

      {/* Movies List */}
      <div className="space-y-6">
        {continuingMovies.length > 0 ? (
          continuingMovies.map((movie) => (
            <MovieCard key={movie.id} movie={movie} initialAfterTime={afterTime} />
          ))
        ) : (
          movies.length === 0 && (
            <div className="bg-gray-50 rounded-2xl p-12 text-center border-2 border-dashed border-gray-200">
              <p className="text-gray-600 text-lg font-medium mb-2">
                {selectedDate ? 'Aucun film programmé pour cette date.' : 'Aucun film programmé pour le moment.'}
              </p>
              <p className="text-gray-400 text-sm max-w-md mx-auto">
                Les données des cinémas sont mises à jour automatiquement ou depuis l'interface d'administration.
              </p>
            </div>
          )
        )}
      </div>

      {/* Scroll to Top Button */}
      <ScrollToTop />
    </div>
  );
}
