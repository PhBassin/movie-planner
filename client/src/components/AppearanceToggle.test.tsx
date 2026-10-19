import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppearanceToggle from './AppearanceToggle.js';
import { updateAppearance, type Appearance, type MemberProfile } from '../api/me.js';
import { ME_QUERY_KEY } from '../api/query-keys.js';
import { memberProfileFixture } from '../test/fixtures.js';

vi.mock('../api/me', () => ({
  updateAppearance: vi.fn(),
  getMemberProfile: vi.fn(),
}));

const profile = memberProfileFixture;

const renderToggle = (appearance: Appearance) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(ME_QUERY_KEY, profile(appearance));

  render(
    <QueryClientProvider client={queryClient}>
      <AppearanceToggle appearance={appearance} />
    </QueryClientProvider>
  );
  return {
    cachedAppearance: () => queryClient.getQueryData<MemberProfile>(ME_QUERY_KEY)?.appearance,
  };
};

describe('AppearanceToggle', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is a toggle button with a stable name, not pressed when light is active', () => {
    renderToggle('light');

    const button = screen.getByRole('button', { name: 'Mode sombre' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('is pressed when dark is active, keeping the same name', () => {
    renderToggle('dark');

    const button = screen.getByRole('button', { name: 'Mode sombre' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('persists dark through the profile route and flips the shared profile cache', async () => {
    vi.mocked(updateAppearance).mockResolvedValue('dark');

    const { cachedAppearance } = renderToggle('light');
    fireEvent.click(screen.getByTestId('appearance-toggle'));

    await waitFor(() => {
      expect(updateAppearance).toHaveBeenCalledWith('dark', expect.anything());
    });
    await waitFor(() => {
      expect(cachedAppearance()).toBe('dark');
    });
    expect(screen.queryByTestId('appearance-toggle-error')).not.toBeInTheDocument();
  });

  it('persists light when toggling back', async () => {
    vi.mocked(updateAppearance).mockResolvedValue('light');

    const { cachedAppearance } = renderToggle('dark');
    fireEvent.click(screen.getByTestId('appearance-toggle'));

    await waitFor(() => {
      expect(updateAppearance).toHaveBeenCalledWith('light', expect.anything());
    });
    await waitFor(() => {
      expect(cachedAppearance()).toBe('light');
    });
  });

  it('flips the cache optimistically before the server answers', async () => {
    vi.mocked(updateAppearance).mockReturnValue(new Promise(() => {}));

    const { cachedAppearance } = renderToggle('light');
    fireEvent.click(screen.getByTestId('appearance-toggle'));

    await waitFor(() => {
      expect(cachedAppearance()).toBe('dark');
    });
  });

  it('rolls the cache back and tells the Member when the write fails', async () => {
    vi.mocked(updateAppearance).mockRejectedValue(new Error('network down'));

    const { cachedAppearance } = renderToggle('light');
    fireEvent.click(screen.getByTestId('appearance-toggle'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible d’enregistrer votre choix');
    expect(cachedAppearance()).toBe('light');
  });
});
