/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import MovieSearchBar from './MovieSearchBar';
import type { Movie } from '../types';

// Mock the API client
vi.mock('../api/client', () => ({
  searchMovies: vi.fn(),
}));

// Mock useDebounce to return immediately (no delay in tests)
vi.mock('../hooks/useDebounce', () => ({
  useDebounce: (value: any) => value,
}));

// Mock highlightText
vi.mock('../utils/highlight', () => ({
  highlightText: (text: string) => text,
}));

import { searchMovies } from '../api/client';

const makeMovie = (id: number, title: string): Movie => ({
  id,
  title,
  genres: ['Action'],
  actors: [],
  source_url: '',
});

describe('MovieSearchBar — inline filter mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderSearchBar = (props: { onFilter?: (movies: Movie[]) => void } = {}) =>
    render(
      <MemoryRouter>
        <MovieSearchBar {...props} />
      </MemoryRouter>
    );

  it('calls onFilter with search results when user types', async () => {
    const onFilter = vi.fn();
    const mockResults = [makeMovie(1, 'Inception'), makeMovie(2, 'Interstellar')];
    (searchMovies as any).mockResolvedValue(mockResults);

    renderSearchBar({ onFilter });

    const input = screen.getByTestId('search-input');
    await userEvent.type(input, 'In');

    await waitFor(() => {
      expect(onFilter).toHaveBeenCalledWith(mockResults);
    });
  });

  it('calls onFilter with empty array when query is cleared', async () => {
    const onFilter = vi.fn();
    const mockResults = [makeMovie(1, 'Inception')];
    (searchMovies as any).mockResolvedValue(mockResults);

    renderSearchBar({ onFilter });

    const input = screen.getByTestId('search-input');
    await userEvent.type(input, 'In');

    await waitFor(() => {
      expect(onFilter).toHaveBeenCalled();
    });

    onFilter.mockClear();
    await userEvent.clear(input);

    await waitFor(() => {
      expect(onFilter).toHaveBeenCalledWith([]);
    });
  });

  it('still renders navigation links in dropdown when onFilter is provided', async () => {
    const onFilter = vi.fn();
    const mockResults = [makeMovie(1, 'Inception')];
    (searchMovies as any).mockResolvedValue(mockResults);

    renderSearchBar({ onFilter });

    const input = screen.getByTestId('search-input');
    await userEvent.type(input, 'In');

    await waitFor(() => {
      expect(screen.getByTestId('search-results')).toBeInTheDocument();
    });

    // The dropdown should contain a link to the movie page
    const link = screen.getByRole('link', { name: /Inception/i });
    expect(link).toHaveAttribute('href', '/movie/1');
  });

  it('does not call onFilter when onFilter is not provided (backward compat)', async () => {
    const mockResults = [makeMovie(1, 'Inception')];
    (searchMovies as any).mockResolvedValue(mockResults);

    renderSearchBar(); // no onFilter

    const input = screen.getByTestId('search-input');
    await userEvent.type(input, 'In');

    await waitFor(() => {
      expect(screen.getByTestId('search-results')).toBeInTheDocument();
    });

    // onFilter shouldn't be called because it wasn't provided
    // (no error thrown means the code handles the missing prop gracefully)
    expect(screen.getByRole('link', { name: /Inception/i })).toBeInTheDocument();
  });
});
