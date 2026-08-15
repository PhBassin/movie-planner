import { test, expect, request as playwrightRequest } from '@playwright/test';

/**
 * Member email-verification flow (issue #57). Drives the in-memory mailer
 * transport through the test-only `/api/test/mailbox` seam — no real SMTP in
 * CI (ADR 0005). The seam is exposed by layering `compose.e2e.yaml` over the
 * dev stack:
 *
 *   docker compose -f compose.yaml -f compose.e2e.yaml up -d --build
 *
 * Rate-limit budget: the register arm (3 signups/hour per IP) and the
 * dedicated verification arm (3 verify/resend requests/hour per IP, ADR
 * 0006 §6) cap how much this suite may do against one web instance. This
 * suite registers two Members (one signup each) and performs several
 * verify/resend calls, so a full run can exceed a limiter window on a shared
 * local instance — restart the stack (`docker compose restart web`) or wait
 * out the window between runs. The limiters are deliberate abuse controls;
 * the suite does not bypass them.
 */

const API = 'http://localhost:3000';

// The /api/auth routes enforce strict CORS (a real browser always sends an
// Origin header); the raw API client must send one too.
const API_HEADERS = { Origin: API };

async function mailboxMessages(
    api: ReturnType<typeof playwrightRequest.newContext> extends Promise<infer C> ? C : never,
    email: string,
    minCount = 1,
): Promise<Array<{ text: string }>> {
    // The signup/resend send is fire-and-forget — poll until the mail lands
    // in the in-memory mailbox.
    let messages: Array<{ text: string }> = [];
    await expect(async () => {
        const res = await api.get(`${API}/api/test/mailbox`, {
            params: { to: email },
        });
        expect(res.ok()).toBe(true);
        const body = await res.json();
        messages = body.data.messages as Array<{ text: string }>;
        expect(
            messages.length,
            `expected at least ${minCount} verification email(s) for ${email}`,
        ).toBeGreaterThanOrEqual(minCount);
    }).toPass({ timeout: 15000, intervals: [500, 1000, 2000] });
    return messages;
}

function extractVerifyLink(text: string): string {
    const match = text.match(/http[^\s]+\/verify\?token=\S+/);
    expect(match, 'verification email should contain a /verify link').not.toBeNull();
    return match![0];
}

function extractToken(link: string): string {
    return new URL(link).searchParams.get('token')!;
}

test.describe('Member email verification', () => {

    test('full flow: signup emails a link that activates the Member; tokens are single-use and superseding', async ({ page }) => {
        const email = `e2e-verify-${Date.now()}@example.com`;
        const password = 'Str0ng!Pass';

        // Register through the UI — the verification email is dispatched
        // fire-and-forget after the 201.
        await page.goto('/signup');
        await page.fill('#email', email);
        await page.fill('#password', password);
        await page.fill('#confirm-password', password);
        await page.click('button[type="submit"]');
        await expect(page.locator('h2').filter({ hasText: /account created/i })).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/check your inbox/i)).toBeVisible();

        const api = await playwrightRequest.newContext({ extraHTTPHeaders: API_HEADERS });
        try {
            // The Member starts unverified.
            const loginRes = await api.post(`${API}/api/auth/login`, {
                data: { username: email, password },
            });
            expect(loginRes.ok()).toBe(true);
            const { token } = (await loginRes.json()).data;
            const meBefore = await api.get(`${API}/api/me`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const before = (await meBefore.json()).data.user;
            expect(before.status).toBe('unverified');
            expect(before.email_verified).toBe(false);

            // Follow the link from the mailbox — the Member becomes active.
            const firstLink = extractVerifyLink((await mailboxMessages(api, email))[0].text);
            await page.goto(firstLink);
            await expect(page.locator('h2').filter({ hasText: /email verified/i })).toBeVisible({ timeout: 10000 });

            const meAfter = await api.get(`${API}/api/me`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const after = (await meAfter.json()).data.user;
            expect(after.status).toBe('active');
            expect(after.email_verified).toBe(true);

            // Single-use: re-consuming the same token is rejected.
            const reuse = await api.post(`${API}/api/auth/verify-email`, {
                data: { token: extractToken(firstLink) },
            });
            expect(reuse.status()).toBe(400);

            // Resend on an already-verified Member is a no-op (still 200 —
            // enumeration-safe) and sends no new mail.
            const resendRes = await api.post(`${API}/api/auth/resend-verification`, {
                data: { email },
            });
            expect(resendRes.ok()).toBe(true);
            // Allow any (unexpected) send to land before counting.
            await page.waitForTimeout(1000);
            expect(await mailboxMessages(api, email)).toHaveLength(1);
        } finally {
            await api.dispose();
        }
    });

    test('an unknown token is rejected and the resend form is offered', async ({ page }) => {
        await page.goto('/verify?token=bogus-token-value');

        await expect(page.locator('h2').filter({ hasText: /verification failed/i })).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole('alert')).toContainText(/invalid or has expired/i);
        await expect(page.locator('#resend-email')).toBeVisible();
    });

    test('resend is enumeration-safe (same body for unknown emails)', async () => {
        const api = await playwrightRequest.newContext({ extraHTTPHeaders: API_HEADERS });
        try {
            // First call may consume the tail of a previous run's bucket —
            // retry once on a 429 so only a *sustained* rejection fails.
            const send = () => api.post(`${API}/api/auth/resend-verification`, {
                data: { email: `e2e-nobody-${Date.now()}@example.com` },
            });
            let res = await send();
            if (res.status() === 429) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
                res = await send();
            }
            expect(res.status(), 'resend may be rate-limited by a recent run — restart the web container to reset the window').toBe(200);
            const body = await res.json();
            expect(body.data.message).toMatch(/verification link/i);
        } finally {
            await api.dispose();
        }
    });

    test('a resend supersedes the outstanding link — only the newest activates', async ({ page }) => {
        const email = `e2e-resend-${Date.now()}@example.com`;
        const password = 'Str0ng!Pass';
        const api = await playwrightRequest.newContext({ extraHTTPHeaders: API_HEADERS });
        try {
            // Sign up over the API (the UI signup path is covered above) and
            // wait for the first verification link.
            const signupRes = await api.post(`${API}/api/auth/signup`, {
                data: { email, password },
            });
            expect(signupRes.status()).toBe(201);
            const firstLink = extractVerifyLink((await mailboxMessages(api, email))[0].text);

            // Resend: a fresh token is issued and the outstanding one is
            // superseded (ADR 0006 sub-decision 2).
            const resendRes = await api.post(`${API}/api/auth/resend-verification`, {
                data: { email },
            });
            expect(resendRes.ok()).toBe(true);
            const messages = await mailboxMessages(api, email, 2);
            const secondLink = extractVerifyLink(messages[1].text);
            expect(secondLink).not.toBe(firstLink);

            // The superseded (first) link no longer verifies.
            const stale = await api.post(`${API}/api/auth/verify-email`, {
                data: { token: extractToken(firstLink) },
            });
            expect(stale.status()).toBe(400);

            // The newest link activates the Member end-to-end.
            await page.goto(secondLink);
            await expect(page.locator('h2').filter({ hasText: /email verified/i })).toBeVisible({ timeout: 10000 });

            const loginRes = await api.post(`${API}/api/auth/login`, {
                data: { username: email, password },
            });
            expect(loginRes.ok()).toBe(true);
            const { token } = (await loginRes.json()).data;
            const me = await api.get(`${API}/api/me`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const user = (await me.json()).data.user;
            expect(user.status).toBe('active');
            expect(user.email_verified).toBe(true);
        } finally {
            await api.dispose();
        }
    });
});
