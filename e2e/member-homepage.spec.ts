import { test, expect, type Page } from '@playwright/test';

interface TheaterLike {
  id: string;
}

async function fetchJson(page: Page, path: string): Promise<any> {
  return page.evaluate(async (url) => {
    const response = await fetch(url);
    return response.json();
  }, path);
}

test.describe('Member Selection homepage', () => {
  test('register → select cinemas → homepage shows their showtimes', async ({ page }) => {
    const email = `e2e-homepage-${Date.now()}@example.com`;
    const password = 'Str0ng!Pass';

    // Register a fresh Member, then sign in (unverified Members may log in).
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.fill('#confirm-password', password);
    await page.getByTestId('signup-submit').click();
    await expect(page.getByTestId('signup-complete-heading')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('signup-go-to-login').click();
    await expect(page.getByTestId('login-heading')).toBeVisible({ timeout: 10000 });

    await page.fill('#username', email);
    await page.fill('#password', password);
    await page.getByTestId('login-submit').click();
    await page.waitForSelector('header nav', { timeout: 10000 });

    // Pick a theater that actually has showtimes this week, plus a catalog
    // theater that is NOT selected, from the public catalog data.
    const moviesResponse = await fetchJson(page, '/api/movies');
    const theaterIdsWithShowtimes: string[] = [
      ...new Set(moviesResponse.data.movies.flatMap((m: { theaters: TheaterLike[] }) => m.theaters.map(t => t.id))),
    ];
    expect(theaterIdsWithShowtimes.length).toBeGreaterThan(0);
    const selectedId = theaterIdsWithShowtimes[0];

    const theatersResponse = await fetchJson(page, '/api/theaters');
    const unselectedTheater = theatersResponse.data.find((t: TheaterLike) => t.id !== selectedId);

    // Empty Selection first: the homepage is the add-cinema CTA, nothing else.
    await page.goto('/');
    await expect(page.getByTestId('empty-selection-cta')).toBeVisible({ timeout: 10000 });
    expect(page.getByTestId('filter-bar')).toHaveCount(0);

    // Select one cinema from the catalog.
    await page.goto('/cinemas');
    await expect(page.getByTestId(`add-selection-${selectedId}`)).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`add-selection-${selectedId}`).click();
    await expect(page.getByTestId(`selected-${selectedId}`)).toBeVisible({ timeout: 10000 });

    // The homepage now renders the Selection: movies playing at the selected
    // theater, and never a non-selected theater.
    await page.goto('/');
    await expect(page.getByTestId('empty-selection-cta')).toHaveCount(0);
    await expect(page.locator('[data-testid="movie-card"]').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`a[href="/theater/${selectedId}"]`).first()).toBeVisible();
    if (unselectedTheater) {
      await expect(page.locator(`a[href="/theater/${unselectedTheater.id}"]`)).toHaveCount(0);
    }

    // An unverified Member keeps the homepage, with the verification reminder.
    await expect(page.getByTestId('verify-email-reminder')).toBeVisible();
    await expect(page.getByTestId('signup-cta')).toHaveCount(0);
  });
});
