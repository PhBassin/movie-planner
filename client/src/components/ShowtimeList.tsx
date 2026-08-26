import { useMemo, memo, useState, useCallback, useRef } from 'react';
import type { Showtime, Movie, Theater } from '../types';
import CalendarPopover from './CalendarPopover';

interface ShowtimeListProps {
  showtimes: Showtime[];
  movie: Movie;
  theater: Theater;
}

function ShowtimeList({ showtimes, movie, theater }: ShowtimeListProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const sortedShowtimes = useMemo(
    () => [...showtimes].sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id)),
    [showtimes],
  );

  const handleToggle = useCallback((key: string) => {
    setOpenKey(prev => (prev === key ? null : key));
  }, []);

  const handleClose = useCallback(() => {
    setOpenKey(null);
  }, []);

  if (sortedShowtimes.length === 0) {
    return (
      <p className="text-gray-500 text-sm">Aucune séance disponible</p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {sortedShowtimes.map((showtime) => {
          const version = showtime.version || 'VF';
          const key = `${version}-${showtime.time}-${showtime.id}`;
          const isOpen = openKey === key;
          const anchorRef = { current: buttonRefs.current.get(key) ?? null };

          return (
            <div key={key} className="relative border-l-4 border-primary pl-3">
              <p className="text-sm font-semibold text-gray-700 mb-2">{version}</p>
              <button
                type="button"
                ref={(el) => {
                  if (el) buttonRefs.current.set(key, el);
                  else buttonRefs.current.delete(key);
                }}
                onClick={() => handleToggle(key)}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                className={`px-3 py-1 rounded text-sm font-medium transition active:scale-95 cursor-pointer ${
                  isOpen
                    ? 'bg-primary text-black shadow-sm'
                    : 'bg-gray-100 text-gray-700 hover:bg-yellow-100 hover:text-black'
                }`}
              >
                {showtime.time}
              </button>

              {isOpen && (
                <CalendarPopover
                  showtime={showtime}
                  movie={movie}
                  theater={theater}
                  anchorRef={anchorRef}
                  onClose={handleClose}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(ShowtimeList);
