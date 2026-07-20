import { memo } from 'react';
import MovieSearchBar from './MovieSearchBar';
import DaySelector from './DaySelector';
import type { Movie } from '../types';

interface FilterBarProps {
  weekStart: string;
  selectedDate: string;
  onSelectDate: (date: string | null) => void;
  onNow: (date: string, time: string) => void;
  isNowActive: boolean;
  onFilter: (movies: Movie[]) => void;
  onReset: () => void;
}

function FilterBar({
  weekStart,
  selectedDate,
  onSelectDate,
  onNow,
  isNowActive,
  onFilter,
  onReset,
}: FilterBarProps) {
  return (
    <div
      className="flex items-center gap-3 bg-white rounded-xl border border-gray-100 p-3 shadow-sm"
      data-testid="filter-bar"
    >
      <div className="flex-1 min-w-0">
        <MovieSearchBar
          placeholder="Rechercher un film..."
          className="w-full"
          onFilter={onFilter}
        />
      </div>

      <div className="flex-shrink-0">
        <DaySelector
          weekStart={weekStart}
          selectedDate={selectedDate || null}
          onSelectDate={onSelectDate}
          onNow={onNow}
          isNowActive={isNowActive}
        />
      </div>

      <button
        onClick={onReset}
        className="flex-shrink-0 px-3 py-2 text-sm rounded-lg bg-gray-50 text-gray-700 hover:bg-gray-100 transition font-semibold cursor-pointer active:scale-95"
        data-testid="filter-reset"
        aria-label="Réinitialiser les filtres"
      >
        <span className="text-base leading-none">🔄</span>
      </button>
    </div>
  );
}

export default memo(FilterBar);
