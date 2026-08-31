import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ShowtimeList from './ShowtimeList';
import type { Showtime, Movie, Theater } from '../types';

vi.mock('./CalendarPopover', () => ({ default: () => null }));

const mockMovie: Movie = {
  id: 1,
  title: 'Test Film',
  genres: [],
  actors: [],
  source_url: 'https://example.com',
};

const mockTheater: Theater = { id: 'C1', name: 'Theater 1' };

const makeShowtime = (id: string, time: string, version?: string): Showtime => ({
  id,
  movie_id: 1,
  theater_id: 'C1',
  date: '2026-03-30',
  time,
  datetime_iso: `2026-03-30T${time}:00`,
  version,
  experiences: [],
  week_start: '2026-03-25',
}) as Showtime;

const versionBlock = (version: string) => {
  const label = screen.getByText(version);
  return label.parentElement as HTMLElement;
};

const blockTimes = (version: string) =>
  within(versionBlock(version))
    .getAllByRole('button')
    .map(button => button.textContent);

describe('ShowtimeList — grouping et tri', () => {
  it('regroupe par version et trie les séances chronologiquement dans chaque groupe', () => {
    render(
      <ShowtimeList
        showtimes={[
          makeShowtime('s3', '18:00', 'VO'),
          makeShowtime('s1', '20:00', 'VF'),
          makeShowtime('s2', '14:00', 'VF'),
          makeShowtime('s4', '16:00', 'VO'),
        ]}
        movie={mockMovie}
        theater={mockTheater}
      />,
    );

    expect(screen.getAllByText('VF')).toHaveLength(1);
    expect(screen.getAllByText('VO')).toHaveLength(1);
    expect(blockTimes('VF')).toEqual(['14:00', '20:00']);
    expect(blockTimes('VO')).toEqual(['16:00', '18:00']);
  });

  it('utilise VF comme version par défaut', () => {
    render(
      <ShowtimeList
        showtimes={[makeShowtime('s1', '14:00')]}
        movie={mockMovie}
        theater={mockTheater}
      />,
    );

    expect(screen.getByText('VF')).toBeInTheDocument();
    expect(blockTimes('VF')).toEqual(['14:00']);
  });

  it('affiche une seule séance par groupe sans entrelacer les versions', () => {
    render(
      <ShowtimeList
        showtimes={[
          makeShowtime('s1', '14:00', 'VF'),
          makeShowtime('s2', '15:00', 'VO'),
          makeShowtime('s3', '16:00', 'VF'),
        ]}
        movie={mockMovie}
        theater={mockTheater}
      />,
    );

    expect(blockTimes('VF')).toEqual(['14:00', '16:00']);
    expect(blockTimes('VO')).toEqual(['15:00']);
  });

  it('affiche l\'état vide quand aucune séance', () => {
    render(<ShowtimeList showtimes={[]} movie={mockMovie} theater={mockTheater} />);

    expect(screen.getByText(/Aucune séance disponible/i)).toBeInTheDocument();
  });
});
