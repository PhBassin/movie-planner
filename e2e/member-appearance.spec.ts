import { test, expect, type Page } from '@playwright/test';

interface MoviesApiResponse {
  data: {
    movies: Array<{ theaters: Array<{ id: string }> }>;
  };
}

async function fetchJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url) => {
    const response = await fetch(url);
    return response.json();
  }, path);
}

async function registerAndLogin(page: Page, email: string, password: string): Promise<void> {
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
  await expect(page.getByTestId('user-menu-button')).toBeVisible({ timeout: 10000 });
}

async function selectOneCinema(page: Page): Promise<void> {
  const moviesResponse = await fetchJson<MoviesApiResponse>(page, '/api/movies');
  const theaterIds = [
    ...new Set(moviesResponse.data.movies.flatMap(m => m.theaters.map(t => t.id))),
  ];
  expect(theaterIds.length).toBeGreaterThan(0);

  await page.goto('/cinemas');
  await expect(page.getByTestId(`add-selection-${theaterIds[0]}`)).toBeVisible({ timeout: 10000 });
  await page.getByTestId(`add-selection-${theaterIds[0]}`).click();
  await expect(page.getByTestId(`selected-${theaterIds[0]}`)).toBeVisible({ timeout: 10000 });
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.fill('#username', email);
  await page.fill('#password', password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('user-menu-button')).toBeVisible({ timeout: 10000 });
}

test.describe('Member Appearance (light/dark)', () => {
  test('toggle persists across reload, logout/login and a second browser', async ({ page, browser }) => {
    const email = `e2e-appearance-${Date.now()}@example.com`;
    const password = 'Str0ng!Pass';

    await registerAndLogin(page, email, password);
    await selectOneCinema(page);

    // Homepage toggle control — light by default.
    await page.goto('/');
    await expect(page.getByTestId('appearance-toggle')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    // Switch to dark: the document root flips and the dark surface renders —
    // the page ground and the homepage's content cards (Branding colors kept).
    await page.getByTestId('appearance-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    const bodyColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyColor).toBe('rgb(17, 24, 39)');
    await expect(page.locator('[data-testid="movie-card"]').first()).toBeVisible();
    // Poll: the card transitions its background, so read after it settles.
    await expect.poll(() =>
      page.evaluate(
        () => getComputedStyle(document.querySelector('[data-testid="movie-card"]')!).backgroundColor
      )
    ).toBe('rgb(31, 41, 55)');

    // Persists across a reload (server-side, not just client state).
    await page.reload();
    await expect(page.getByTestId('appearance-toggle')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Persists across logout/login.
    await page.getByTestId('user-menu-button').click();
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('appearance-toggle')).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    await login(page, email, password);
    await page.goto('/');
    await expect(page.getByTestId('appearance-toggle')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Persists to a second browser (per-Member, cross-device).
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await login(secondPage, email, password);
    await secondPage.goto('/');
    await expect(secondPage.getByTestId('appearance-toggle')).toBeVisible({ timeout: 10000 });
    await expect(secondPage.locator('html')).toHaveClass(/dark/);

    // Toggling back to light persists too — re-fetched by both browsers.
    await page.getByTestId('appearance-toggle').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await secondPage.reload();
    await expect(secondPage.locator('html')).not.toHaveClass(/dark/);

    await secondContext.close();
  });
});
