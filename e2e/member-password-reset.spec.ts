import { test, expect, request as playwrightRequest } from '@playwright/test';

const API = 'http://localhost:3000';
const API_HEADERS = { Origin: API };

type MailboxContext = Awaited<ReturnType<typeof playwrightRequest.newContext>>;

async function mailboxMessages(api: MailboxContext, email: string, minCount = 1) {
    let messages: Array<{ subject: string; text: string }> = [];
    await expect(async () => {
        const response = await api.get(`${API}/api/test/mailbox`, { params: { to: email } });
        expect(response.ok()).toBe(true);
        messages = (await response.json()).data.messages;
        expect(messages.length).toBeGreaterThanOrEqual(minCount);
    }).toPass({ timeout: 15000, intervals: [500, 1000, 2000] });
    return messages;
}

function extractResetToken(text: string): string {
    const match = text.match(/http[^\s]+\/reset-password\?token=\S+/);
    expect(match, 'password reset email should contain a reset link').not.toBeNull();
    return new URL(match![0]).searchParams.get('token')!;
}

function extractResetTokenFromMailbox(messages: Array<{ subject: string; text: string }>, index = 0): string {
    const resetMessages = messages.filter((message) => /reset/i.test(message.subject) && message.text.includes('/reset-password?token='));
    const resetMessage = resetMessages[index];
    expect(resetMessage, 'mailbox should contain a password reset email').toBeDefined();
    return extractResetToken(resetMessage!.text);
}

test.describe('Member password reset', () => {
    test('resets a Member password, revokes the old Session, and requires login', async ({ page }) => {
        const email = `e2e-reset-${Date.now()}@example.com`;
        const oldPassword = 'Str0ng!Pass';
        const newPassword = 'NewStr0ng!Pass';
        const api = await playwrightRequest.newContext({ extraHTTPHeaders: API_HEADERS });

        try {
            const signup = await api.post(`${API}/api/auth/signup`, {
                data: { email, password: oldPassword },
            });
            expect(signup.status()).toBe(201);

            const login = await api.post(`${API}/api/auth/login`, {
                data: { username: email, password: oldPassword },
            });
            expect(login.ok()).toBe(true);
            expect((await login.json()).data.token).toBeTruthy();

            await page.goto('/login');
            await page.getByRole('link', { name: /forgot your password/i }).click();
            await expect(page.locator('h2')).toContainText(/forgot your password/i);
            await page.fill('#email', email);
            await page.click('button[type="submit"]');
            await expect(page.locator('h2')).toContainText(/check your inbox/i);

            const resetToken = extractResetTokenFromMailbox(await mailboxMessages(api, email, 2));

            await page.goto(`/reset-password?token=${resetToken}`);
            await page.fill('#new-password', newPassword);
            await page.fill('#confirm-password', newPassword);
            await page.click('button[type="submit"]');
            await expect(page.locator('h2')).toContainText(/login/i);

            const oldLogin = await api.post(`${API}/api/auth/login`, {
                data: { username: email, password: oldPassword },
            });
            expect(oldLogin.status()).toBe(401);

            const revokedSession = await api.post(`${API}/api/auth/refresh`);
            expect(revokedSession.status()).toBe(401);

            const newLogin = await api.post(`${API}/api/auth/login`, {
                data: { username: email, password: newPassword },
            });
            expect(newLogin.ok()).toBe(true);

            const confirmationMessages = await mailboxMessages(api, email, 3);
            expect(confirmationMessages.some((message) => /password was changed/i.test(message.subject))).toBe(true);
        } finally {
            await api.dispose();
        }
    });

    test('rejects a reset token a second time', async () => {
        const email = `e2e-reset-reuse-${Date.now()}@example.com`;
        const api = await playwrightRequest.newContext({ extraHTTPHeaders: API_HEADERS });

        try {
            const signup = await api.post(`${API}/api/auth/signup`, {
                data: { email, password: 'Str0ng!Pass' },
            });
            expect(signup.status()).toBe(201);

            const requestReset = await api.post(`${API}/api/auth/password-reset/request`, {
                data: { email },
            });
            expect(requestReset.ok()).toBe(true);
            const token = extractResetTokenFromMailbox(await mailboxMessages(api, email, 2));

            const secondRequest = await api.post(`${API}/api/auth/password-reset/request`, {
                data: { email },
            });
            expect(secondRequest.ok()).toBe(true);
            const secondToken = extractResetTokenFromMailbox(await mailboxMessages(api, email, 3), 1);

            const superseded = await api.post(`${API}/api/auth/password-reset/confirm`, {
                data: { token, newPassword: 'NewStr0ng!Pass' },
            });
            expect(superseded.status()).toBe(400);

            const first = await api.post(`${API}/api/auth/password-reset/confirm`, {
                data: { token: secondToken, newPassword: 'NewStr0ng!Pass' },
            });
            expect(first.ok()).toBe(true);

            const reuse = await api.post(`${API}/api/auth/password-reset/confirm`, {
                data: { token: secondToken, newPassword: 'OtherStr0ng!Pass' },
            });
            expect(reuse.status()).toBe(400);
            expect((await reuse.json()).error).toMatch(/invalid or has expired/i);
        } finally {
            await api.dispose();
        }
    });
});
