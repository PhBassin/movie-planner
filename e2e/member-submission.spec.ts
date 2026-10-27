import { test, expect } from '@playwright/test';

/**
 * Member TheaterSubmission flow (issues #62, #63 and #120): the submit form on
 * /cinemas drives `POST /api/me/submissions`; the async resolution arrives on
 * the `/api/me/notifications` SSE stream as a transient toast (ADR 0005).
 *
 * The default-run tests are hermetic: the synchronous POST contract is
 * intercepted so they never scrape or depend on the catalog's contents.
 *
 * The full live leg — a real `add_theater` scrape resolving to a success
 * toast with the new theater auto-added to the Selection — needs a reachable
 * AlloCiné and a theater id absent from the local database, so it is gated
 * behind E2E_LIVE_SUBMISSION=true and a custom URL:
 *
 *   E2E_LIVE_SUBMISSION=true \\
 *   E2E_LIVE_SUBMISSION_URL='https://www.allocine.fr/seance/salle_gen_csalle=CXXXXX.html' \\
 *   npm run e2e -- e2e/member-submission.spec.ts
 */

test.describe('Member theater submission', () => {
  async function signupAndLogin(page: import('@playwright/test').Page): Promise<void> {
    const email = `e2e-submit-${Date.now()}@example.com`;
    const password = 'Str0ng!Pass';

    await page.goto('/signup');
    await page.waitForLoadState('networkidle');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.fill('#confirm-password', password);
    await page.getByTestId('signup-submit').click();
    await expect(page.getByTestId('signup-complete-heading')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('signup-go-to-login').click();
    await page.fill('#username', email);
    await page.fill('#password', password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('user-menu-button')).toBeVisible({ timeout: 10000 });
  }

  test('acknowledges a queued submission (the async outcome arrives as a live notification)', async ({ page }) => {
    await signupAndLogin(page);

    await page.route('**/api/me/submissions', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { submission: { id: 9, status: 'pending', report_id: 42 } },
        }),
      }),
    );

    await page.goto('/cinemas');
    await expect(page.getByTestId('submission-form')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('submission-url').fill('https://www.allocine.fr/seance/salle_gen_csalle=C0099.html');
    await page.getByTestId('submission-submit').click();

    await expect(page.getByTestId('selection-toast')).toContainText('Proposition enregistrée');
    await expect(page.getByTestId('submission-url')).toHaveValue('');
  });

  test('degrades a catalog hit to a Selection add without scraping', async ({ page }) => {
    await signupAndLogin(page);

    await page.route('**/api/me/submissions', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { selectionAdded: true, theater: { id: 'C0001', name: 'UGC Opéra', status: 'active' } },
        }),
      }),
    );

    await page.goto('/cinemas');
    await page.getByTestId('submission-url').fill('https://www.allocine.fr/seance/salle_gen_csalle=C0001.html');
    await page.getByTestId('submission-submit').click();

    await expect(page.getByTestId('selection-toast')).toContainText('déjà dans le catalogue');
  });

  test('surfaces synchronous rejections (throttle) without a scrape', async ({ page }) => {
    await signupAndLogin(page);

    await page.route('**/api/me/submissions', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'You have reached the limit of 3 new cinema submissions.',
        }),
      }),
    );

    await page.goto('/cinemas');
    await page.getByTestId('submission-url').fill('https://www.allocine.fr/seance/salle_gen_csalle=C0099.html');
    await page.getByTestId('submission-submit').click();

    await expect(page.getByTestId('selection-toast')).toContainText('limit of 3 new cinema submissions');
  });

  test('"Mes soumissions": menu entry, unverified state, then submit → pending row → resolved', async ({ page }) => {
    await signupAndLogin(page);

    // Real API: a fresh (unverified) Member has no submissions yet.
    await page.getByTestId('user-menu-button').click();
    await page.getByTestId('submissions-link').click();
    await expect(page).toHaveURL(/\/submissions$/);
    await expect(page.getByTestId('submissions-unverified')).toContainText('Vérifiez votre email');

    const submittedUrl = 'https://www.allocine.fr/seance/salle_gen_csalle=C0099.html';
    const pendingItem = {
      id: 9,
      url: submittedUrl,
      status: 'pending',
      created_at: new Date().toISOString(),
      resolved_at: null,
      attempts: 1,
      theater: { id: 'C0099', status: 'provisioning' },
    };
    const resolvedItem = {
      ...pendingItem,
      status: 'succeeded',
      resolved_at: new Date().toISOString(),
      theater: { id: 'C0099', status: 'active', name: 'Cinéma E2E', city: 'Lyon' },
      in_selection: false,
    };
    let current: Record<string, unknown> = pendingItem;

    await page.route('**/api/me/submissions*', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { submission: { id: 9, status: 'pending', report_id: 42 } } }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { items: [current], total: 1, limit: 20, offset: 0 } }),
      });
    });

    await page.goto('/cinemas');
    await page.getByTestId('submission-url').fill(submittedUrl);
    await page.getByTestId('submission-submit').click();
    await page.getByTestId('submission-track-link').click();

    await expect(page.getByTestId('submissions-heading')).toBeVisible();
    const row = page.getByTestId('submission-row');
    await expect(row).toHaveAttribute('data-status', 'pending');
    await expect(row.getByTestId('submission-state')).toContainText('En cours depuis');
    await expect(row).toContainText(submittedUrl);

    // The resolution is durable: on the next read the row shows the outcome.
    current = resolvedItem;
    await page.reload();

    await expect(row).toHaveAttribute('data-status', 'succeeded');
    await expect(row.getByTestId('submission-theater-link')).toContainText('Cinéma E2E');
    await expect(row.getByTestId('submission-state')).toContainText('Ajouté au catalogue, pas dans votre Sélection');
    await expect(row.getByTestId('submission-add')).toBeVisible();
  });

  test('live leg: submit → watch the toast → theater lands in the Selection', async ({ page }) => {
    test.skip(
      process.env.E2E_LIVE_SUBMISSION !== 'true',
      'Needs E2E_LIVE_SUBMISSION=true, a reachable AlloCiné, and an unseeded theater URL (E2E_LIVE_SUBMISSION_URL).',
    );

    const url = process.env.E2E_LIVE_SUBMISSION_URL ?? '';
    test.skip(
      url.length === 0,
      'E2E_LIVE_SUBMISSION_URL must carry the AlloCiné theater URL to submit.',
    );

    await signupAndLogin(page);

    await page.goto('/cinemas');
    await page.getByTestId('submission-url').fill(url);
    await page.getByTestId('submission-submit').click();

    // The synchronous acknowledgment.
    await expect(
      page.getByTestId('selection-toast').or(page.getByTestId('member-notification')),
    ).toBeVisible({ timeout: 10000 });

    // The async resolution — the toast lands wherever the Member is.
    await expect(page.getByTestId('member-notification')).toContainText('a rejoint votre Selection', {
      timeout: 120000,
    });

    // The Selection now carries the submitted theater (the page refetched).
    const selectionResponse = await page.evaluate(async () => {
      const response = await fetch('/api/me/selection');
      return response.json();
    });
    const submittedTheaterId = new URL(url).searchParams.get('salle');
    expect(
      selectionResponse.data.some((theater: { id: string }) => theater.id === submittedTheaterId),
    ).toBe(true);
  });
});
