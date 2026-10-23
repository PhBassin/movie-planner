import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * Member self-service RGPD rights (issue #66, ADR 0004): export → delete →
 * login fails → the email can re-register immediately.
 */

async function signup(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/signup');
  await page.waitForLoadState('networkidle');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.fill('#confirm-password', password);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('signup-complete-heading')).toBeVisible({ timeout: 10000 });
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.fill('#username', email);
  await page.fill('#password', password);
  await page.getByTestId('login-submit').click();
}

test.describe('Member erasure and data export', () => {
  test('export, then self-delete with password re-entry; the email is reusable', async ({ page, browser }) => {
    const email = `e2e-erasure-${Date.now()}@example.com`;
    const password = 'Str0ng!Pass';

    await signup(page, email, password);
    await login(page, email, password);
    await expect(page.getByTestId('user-menu-button')).toBeVisible({ timeout: 10000 });

    // A second Session (another device) that erasure must end too.
    const otherDevice = await browser.newContext();
    const otherPage = await otherDevice.newPage();
    await login(otherPage, email, password);
    await expect(otherPage.getByTestId('user-menu-button')).toBeVisible({ timeout: 10000 });
    expect((await otherPage.request.get('/api/me')).status()).toBe(200);

    // Reach the account page through the user menu.
    await page.getByTestId('user-menu-button').click();
    await page.getByTestId('account-link').click();
    await expect(page.getByTestId('account-heading')).toBeVisible();
    await expect(page.getByTestId('account-email')).toHaveText(email);

    // Export: one JSON document with the account, never the password hash.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-data-button').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^movie-planner-data-\d{4}-\d{2}-\d{2}\.json$/);
    const raw = await readFile((await download.path())!, 'utf8');
    const exported = JSON.parse(raw);
    expect(exported.account.email).toBe(email);
    expect(exported).toHaveProperty('selection');
    expect(exported).toHaveProperty('submissions');
    expect(exported).toHaveProperty('appearance');
    expect(raw).not.toMatch(/password|hash/i);

    // A wrong password is refused and nothing is deleted.
    await page.fill('#delete-password', 'Wr0ng!Pass');
    await page.getByTestId('delete-account-confirm').check();
    await page.getByTestId('delete-account-submit').click();
    await expect(page.getByTestId('delete-account-error')).toContainText('Password is incorrect');

    // The right password erases the account and ends the Session.
    await page.fill('#delete-password', password);
    await page.getByTestId('delete-account-submit').click();
    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
    await expect(page.getByTestId('user-menu-button')).not.toBeVisible();

    // The other device's Session is gone with the account (refresh tokens
    // cascade; requireMember finds no row behind its access token).
    expect((await otherPage.request.get('/api/me')).status()).toBe(401);
    expect((await otherPage.request.post('/api/auth/refresh')).ok()).toBe(false);
    await otherDevice.close();

    // The account is gone: login fails.
    await login(page, email, password);
    await expect(page.locator('text=/Invalid credentials/i')).toBeVisible({ timeout: 5000 });

    // No tombstone: the same email can register again right away.
    await signup(page, email, password);
  });
});
