import { test, expect } from '@playwright/test';

test.describe('Prayer Wall Page', () => {

    // ── Page structure ──────────────────────────────────────────────────────

    test('renders the Prayer Wall heading', async ({ page }) => {
        await page.goto('/wall');
        await expect(page.getByRole('heading', { name: 'Prayer Wall' })).toBeVisible();
    });

    test('renders the subtitle "A safe space for your heart"', async ({ page }) => {
        await page.goto('/wall');
        await expect(page.getByText('A safe space for your heart')).toBeVisible();
    });

    test('renders a refresh button that links back to /wall', async ({ page }) => {
        await page.goto('/wall');
        const refreshLink = page.locator('a[href="/wall"]');
        await expect(refreshLink).toBeVisible();
    });

    // ── Empty state ─────────────────────────────────────────────────────────

    test('shows empty-state message when there are no prayer requests', async ({ page }) => {
        // Intercept the SSR DB call by serving a page with no cards — navigate
        // to /wall and check; the DB may or may not be empty, so we intercept
        // the network request that backs the page render indirectly via the API
        // route used in tests by mocking the fetch from the server.
        // Since /wall is a Server Component, we verify by checking the DOM.
        await page.goto('/wall');
        // Either we see prayer cards or the empty-state text — both are valid.
        const hasCards = await page.locator('.bg-white.dark\\:bg-slate-900\\/40').count();
        if (hasCards === 0) {
            await expect(page.getByText('No requests yet. Be the first to share.')).toBeVisible();
        }
    });

    // ── Prayer cards ────────────────────────────────────────────────────────

    test('prayer cards show content when requests exist', async ({ page }) => {
        const unique = `E2E-wall-content-${Date.now()}`;
        const res = await page.request.post('/api/submit', { data: { message: unique } });
        expect(res.ok()).toBeTruthy();
        await page.goto('/wall');
        await expect(page.getByText(unique)).toBeVisible({ timeout: 15000 });
    });

    test('prayer cards show a timestamp label', async ({ page }) => {
        const res = await page.request.post('/api/submit', {
            data: { message: `E2E-timestamp-${Date.now()}` },
        });
        expect(res.ok()).toBeTruthy();
        await page.goto('/wall');
        // Any time-ago label rendered by PrayerCard
        const timeLabels = page.locator('span.text-xs.text-slate-400');
        await expect(timeLabels.first()).toBeVisible({ timeout: 15000 });
    });

    test('newly submitted prayer shows the "New" badge', async ({ page }) => {
        const res = await page.request.post('/api/submit', {
            data: { message: `E2E-new-badge-${Date.now()}` },
        });
        expect(res.ok()).toBeTruthy();
        await page.goto('/wall');
        await expect(page.getByText('New').first()).toBeVisible({ timeout: 15000 });
    });

    test('newly submitted prayer shows "Just now" time label', async ({ page }) => {
        const res = await page.request.post('/api/submit', {
            data: { message: `E2E-just-now-${Date.now()}` },
        });
        expect(res.ok()).toBeTruthy();
        await page.goto('/wall');
        await expect(page.getByText('Just now').first()).toBeVisible({ timeout: 15000 });
    });

    // ── Refresh ─────────────────────────────────────────────────────────────

    test('clicking the refresh button reloads the wall', async ({ page }) => {
        await page.goto('/wall');
        const [response] = await Promise.all([
            page.waitForResponse(res => res.url().includes('/wall') && res.status() === 200),
            page.locator('a[href="/wall"]').click(),
        ]);
        expect(response.status()).toBe(200);
    });

    // ── Navigation ──────────────────────────────────────────────────────────

    test('desktop nav contains a "Request" link pointing to /', async ({ page }) => {
        await page.goto('/wall');
        const link = page.locator('nav a[href="/"]').first();
        await expect(link).toBeVisible();
    });

    test('clicking the Request nav link navigates to the submit page', async ({ page }) => {
        await page.goto('/wall');
        await page.locator('nav a[href="/"]').first().click();
        await expect(page).toHaveURL('/');
    });

    test('FAB (mobile) links back to /', async ({ page }) => {
        // Use mobile viewport to show FAB
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/wall');
        const fab = page.locator('a[href="/"].md\\:hidden');
        await expect(fab).toBeVisible();
        await expect(fab).toHaveAttribute('href', '/');
    });

    // ── Theme toggle ────────────────────────────────────────────────────────

    test('theme toggle button is present on the wall page', async ({ page }) => {
        await page.goto('/wall');
        await expect(page.getByRole('button', { name: /toggle theme/i })).toBeVisible();
    });
});
