import { test, expect } from '@playwright/test';

test.describe('Member Selection flow', () => {

    test('member browses the catalog and adds a theater to the Selection', async ({ page }) => {
        const email = `e2e-selection-${Date.now()}@example.com`;
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

        // Browse the public catalog and add a theater to the Selection.
        await page.goto('/cinemas');
        await expect(page.getByTestId('add-selection-C0153')).toBeVisible({ timeout: 10000 });
        await page.getByTestId('add-selection-C0153').click();
        await expect(page.getByTestId('selected-C0153')).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('selection-counter')).toContainText('1 / 50');

        // The persisted Selection includes the added theater.
        const selectionResponse = await page.evaluate(async () => {
            const response = await fetch('/api/me/selection');
            return response.json();
        });
        expect(selectionResponse.data.some((theater: { id: string }) => theater.id === 'C0153')).toBe(true);
    });
});
