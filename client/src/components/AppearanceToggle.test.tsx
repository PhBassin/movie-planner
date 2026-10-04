import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppearanceToggle from './AppearanceToggle.js';
import { updateAppearance } from '../api/me.js';
import { memberProfileFixture } from '../test/fixtures.js';

vi.mock('../api/me', () => ({
  updateAppearance: vi.fn(),
  getMemberProfile: vi.fn(),
}));

const profile = memberProfileFixture;

const renderToggle = (appearance: 'light' | 'dark', cachedProfile = profile(appearance)) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(['me'], cachedProfile);

  return render(
    <QueryClientProvider client={queryClient}>
      <AppearanceToggle appearance={appearance} />
    </QueryClientProvider>
  );
};

describe('AppearanceToggle', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers switching to dark when light is active', () => {
    renderToggle('light');

    const button = screen.getByTestId('appearance-toggle');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveTextContent('Mode sombre');
  });

  it('offers switching to light when dark is active', () => {
    renderToggle('dark');

    const button = screen.getByTestId('appearance-toggle');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveTextContent('Mode clair');
  });

  it('persists dark through the profile route and updates the shared cache', async () => {
    vi.mocked(updateAppearance).mockResolvedValue('dark');

    renderToggle('light');
    fireEvent.click(screen.getByTestId('appearance-toggle'));

    await waitFor(() => {
      expect(updateAppearance).toHaveBeenCalledWith('dark', expect.anything());
    });
  });

  it('persists light when toggling back', async () => {
    vi.mocked(updateAppearance).mockResolvedValue('light');

    renderToggle('dark');
    fireEvent.click(screen.getByTestId('appearance-toggle'));

    await waitFor(() => {
      expect(updateAppearance).toHaveBeenCalledWith('light', expect.anything());
    });
  });
});
