import { test, expect, request as playwrightRequest } from '@playwright/test';

/**
 * Admin Member management (issue #65): the suspend → login-blocked →
 * reinstate loop, driven through the admin Members tab and the login page.
 *
 * Needs the E2E stack (in-memory mailer + `/api/test/mailbox` seam):
 *
 *   docker compose -f compose.yaml -f compose.e2e.yaml up -d --build
 *
 * The member must be `active` before suspension (suspending an unverified
 * member is rejected — reinstatement must not bypass email verification),
 * hence the mailbox-driven verification leg. Like `user-management.spec.ts`,
 * the admin leg assumes the local admin account accepts admin/admin.
 *
 * Rate-limit budget: one signup (register arm) — see ADR 0006.
 */

const API = 'http://localhost:3000';
const API_HEADERS = { Origin: API };

// The admin leg follows the user-management.spec.ts convention (admin/admin
// on a locally provisioned database). Override for databases whose bootstrap
// password was not set to admin/admin.
const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin';

async function mailboxMessages(
    api: ReturnType<Awaited<ReturnType<typeof playwrightRequest.newContext>>>,
    email: string,
): Promise<Array<{ text: string }>> {
    let messages: Array<{ text: string }> = [];
    await expect(async () => {
        const res = await api.get(`${API}/api/test/mailbox`, {
            params: { to: email },
        });
        expect(res.ok()).toBe(true);
        const body = await res.json();
        messages = body.data.messages as Array<{ text: string }>;
        expect(messages.length).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 15000, intervals: [500, 1000, 2000] });
    return messages;
}

function extractVerifyLink(text: string): string {
    const match = text.match(/http[^\s]+\/verify\?token=\S+/);
    expect(match, 'verification email should contain a /verify link').not.toBeNull();
    return match![0];
}

test.describe('Admin Member management', () => {
    test('suspend blocks login, reinstate restores it (Members tab)', async ({ page }) => {
        const email = `e2e-member-admin-${Date.now()}@example.com`;
        const password = 'Str0ng!Pass';

        // ── Member signup + email verification (active members can be suspended)
        await page.goto('/signup');
        await page.fill('#email', email);
        await page.fill('#password', password);
        await page.fill('#confirm-password', password);
        await page.click('button[type="submit"]');
        await expect(page.locator('h2').filter({ hasText: /account created/i })).toBeVisible({ timeout: 10000 });

        const api = await playwrightRequest.newContext({ extraHTTPHeaders: API_HEADERS });
        try {
            const verifyLink = extractVerifyLink((await mailboxMessages(api, email))[0].text);
            await page.goto(verifyLink);
            await expect(page.locator('h2').filter({ hasText: /email verified/i })).toBeVisible({ timeout: 10000 });
        } finally {
            await api.dispose();
        }

        // ── Admin suspends the Member from the Members tab
        await page.goto('/login');
        await page.fill('#username', ADMIN_USERNAME);
        await page.fill('#password', ADMIN_PASSWORD);
        await page.getByTestId('login-submit').click();
        await expect(page.getByTestId('user-menu-button')).toBeVisible({ timeout: 10000 });

        await page.goto('/admin?tab=members');
        await expect(page.getByTestId('members-table')).toBeVisible({ timeout: 10000 });

        const row = page.locator('tr', { hasText: email });
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: 'Suspend' }).click();
        await page.getByTestId('confirm-suspend-member').click();
        await expect(row.getByTestId('member-status-suspended')).toBeVisible({ timeout: 10000 });

        // ── The suspended Member cannot log in
        await page.getByTestId('user-menu-button').click();
        await page.getByTestId('logout-button').click();
        await page.waitForLoadState('networkidle');

        await page.goto('/login');
        await page.fill('#username', email);
        await page.fill('#password', password);
        await page.getByTestId('login-submit').click();
        await expect(page.getByRole('alert')).toContainText(/account suspended/i, { timeout: 10000 });

        // ── Admin reinstates; the Member logs in again
        await page.goto('/login');
        await page.fill('#username', ADMIN_USERNAME);
        await page.fill('#password', ADMIN_PASSWORD);
        await page.getByTestId('login-submit').click();
        await expect(page.getByTestId('user-menu-button')).toBeVisible({ timeout: 10000 });

        await page.goto('/admin?tab=members');
        await expect(page.getByTestId('members-table')).toBeVisible({ timeout: 10000 });

        const suspendedRow = page.locator('tr', { hasText: email });
        await suspendedRow.getByRole('button', { name: 'Reinstate' }).click();
        await expect(suspendedRow.getByTestId('member-status-active')).toBeVisible({ timeout: 10000 });

        await page.getByTestId('user-menu-button').click();
        await page.getByTestId('logout-button').click();
        await page.waitForLoadState('networkidle');

        await page.goto('/login');
        await page.fill('#username', email);
        await page.fill('#password', password);
        await page.getByTestId('login-submit').click();
        await expect(page.getByTestId('user-menu-button')).toBeVisible({ timeout: 10000 });
    });
});
