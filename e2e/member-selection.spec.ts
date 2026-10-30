import { test, expect, type Page } from '@playwright/test';

async function registerAndLogin(page: Page, email: string): Promise<void> {
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
    // Wait for a real logged-in signal — `header nav` is present on every
    // page (including /login), so it never proves the session was
    // established, letting the next navigation race the login request.
    await expect(page.getByTestId('user-menu-button')).toBeVisible({ timeout: 10000 });
}

test.describe('Member Selection flow', () => {

    test('member browses the catalog, adds theaters and is held to the free quota', async ({ page }) => {
        await registerAndLogin(page, `e2e-selection-${Date.now()}@example.com`);

        // Browse the public catalog and add a theater to the Selection.
        await page.goto('/cinemas');
        await expect(page.getByTestId('add-selection-C0153')).toBeVisible({ timeout: 10000 });
        await page.getByTestId('add-selection-C0153').click();
        await expect(page.getByTestId('selected-C0153')).toBeVisible({ timeout: 10000 });
        // The e2e stack runs the fake billing adapter: a fresh Member is free (3 active).
        await expect(page.getByTestId('selection-usage')).toHaveText('1 / 3 actifs');
        await expect(page.getByTestId('selection-offer')).toContainText('Offre gratuite');

        // The persisted Selection includes the added theater.
        const selectionResponse = await page.evaluate(async () => {
            const response = await fetch('/api/me/selection');
            return response.json();
        });
        expect(selectionResponse.data.some((theater: { id: string }) => theater.id === 'C0153')).toBe(true);

        // Same Member (the register limiter bounds signups per run): a free
        // Member is held to 3 active theaters (ADR 0011 D2).
        const theaters = await page.evaluate(async () => {
            const response = await fetch('/api/theaters');
            return response.json();
        });
        const otherIds: string[] = theaters.data
            .filter((theater: { id: string; status: string }) => theater.status === 'active' && theater.id !== 'C0153')
            .map((theater: { id: string }) => theater.id);
        test.skip(otherIds.length < 3, 'the quota check needs at least 4 active catalog theaters');
        const [second, third, fourth] = otherIds;

        for (const id of [second, third]) {
            await page.getByTestId(`add-selection-${id}`).click();
            await expect(page.getByTestId(`selected-${id}`)).toBeVisible({ timeout: 10000 });
        }
        await expect(page.getByTestId('selection-usage')).toHaveText('3 / 3 actifs');
        // At quota the browser blocks the 4th add...
        await expect(page.getByTestId(`add-selection-${fourth}`)).toBeDisabled();

        // ...and the server refuses it anyway, with the reason and fresh usage.
        const refused = await page.evaluate(async (theaterId) => {
            const csrf = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1];
            const response = await fetch(`/api/me/selection/${theaterId}`, {
                method: 'POST',
                headers: csrf ? { 'X-CSRF-Token': csrf } : {},
            });
            return { status: response.status, body: await response.json() };
        }, fourth);
        expect(refused.status).toBe(409);
        expect(refused.body.details[0]).toMatchObject({
            reason: 'quota_reached',
            usage: { offer: 'free', activeCount: 3, selectionQuota: 3 },
        });

        // Freeing a slot lets the 4th in.
        await page.getByTestId('remove-selection-C0153').click();
        await expect(page.getByTestId('selection-usage')).toHaveText('2 / 3 actifs');
        await page.getByTestId(`add-selection-${fourth}`).click();
        await expect(page.getByTestId(`selected-${fourth}`)).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('selection-usage')).toHaveText('3 / 3 actifs');
    });
});
