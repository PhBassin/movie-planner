import { test, expect } from '@playwright/test';

test.describe('Member registration flow', () => {

    test('signup page is reachable from login and creates an account', async ({ page }) => {
        const email = `e2e-member-${Date.now()}@example.com`;
        const password = 'Str0ng!Pass';

        // The signup page is linked from the login page.
        await page.goto('/login');
        await page.waitForLoadState('networkidle');
        await page.locator('[data-testid="login-signup-link"]').click();

        await expect(page.getByTestId('signup-heading')).toBeVisible({ timeout: 10000 });

        // Fill the signup form.
        await page.fill('#email', email);
        await page.fill('#password', password);
        await page.fill('#confirm-password', password);
        await page.getByTestId('signup-submit').click();

        // Success confirmation is shown.
        await expect(page.getByTestId('signup-complete-heading')).toBeVisible({ timeout: 10000 });

        // Navigate to login and sign in as the freshly registered
        // (unverified) Member — unverified Members may log in.
        await page.getByTestId('signup-go-to-login').click();
        await expect(page.getByTestId('login-heading')).toBeVisible({ timeout: 10000 });

        await page.fill('#username', email);
        await page.fill('#password', password);
        await page.getByTestId('login-submit').click();

        // Login succeeds and lands on the home page.
        await page.waitForSelector('header nav', { timeout: 10000 });
    });

    test('signup rejects mismatched passwords client-side', async ({ page }) => {
        await page.goto('/signup');
        await page.waitForLoadState('networkidle');

        await page.fill('#email', `e2e-mismatch-${Date.now()}@example.com`);
        await page.fill('#password', 'Str0ng!Pass');
        await page.fill('#confirm-password', 'Different1!');
        await page.getByTestId('signup-submit').click();

        await expect(page.getByRole('alert')).toContainText(/passwords do not match/i);
    });

    test('signup rejects a duplicate email', async ({ page }) => {
        const email = `e2e-dupe-${Date.now()}@example.com`;
        const password = 'Str0ng!Pass';

        // First registration succeeds.
        await page.goto('/signup');
        await page.fill('#email', email);
        await page.fill('#password', password);
        await page.fill('#confirm-password', password);
        await page.getByTestId('signup-submit').click();
        await expect(page.getByTestId('signup-complete-heading')).toBeVisible({ timeout: 10000 });

        // Second registration with the same email is rejected.
        await page.goto('/signup');
        await page.fill('#email', email);
        await page.fill('#password', password);
        await page.fill('#confirm-password', password);
        await page.getByTestId('signup-submit').click();

        await expect(page.getByRole('alert')).toContainText(/already exists/i, { timeout: 10000 });
    });
});
