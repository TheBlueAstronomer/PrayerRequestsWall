import { test, expect } from '@playwright/test';
import { mockSubmitApi } from './helpers';

test.describe('Submit Page — Prayer Request Form', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    // ── Page structure ──────────────────────────────────────────────────────

    test('renders the page heading and anonymous label', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /you are not alone/i })).toBeVisible();
        await expect(page.getByText(/completely anonymous/i)).toBeVisible();
    });

    test('renders the prayer textarea with correct placeholder', async ({ page }) => {
        await expect(page.getByPlaceholder('Type your prayer here...')).toBeVisible();
    });

    test('renders the submit button', async ({ page }) => {
        await expect(page.getByRole('button', { name: /send prayer request/i })).toBeVisible();
    });

    test('shows character counter starting at 0 / 1000', async ({ page }) => {
        await expect(page.getByText('0 / 1000')).toBeVisible();
    });

    test('renders the 100% Anonymous & Private label', async ({ page }) => {
        await expect(page.getByText(/100% anonymous/i)).toBeVisible();
    });

    // ── Textarea interaction ────────────────────────────────────────────────

    test('typing updates the character counter', async ({ page }) => {
        const textarea = page.getByPlaceholder('Type your prayer here...');
        await textarea.fill('Hello');
        await expect(page.getByText('5 / 1000')).toBeVisible();
    });

    test('submit button is disabled when textarea is empty', async ({ page }) => {
        await expect(page.getByRole('button', { name: /send prayer request/i })).toBeDisabled();
    });

    test('submit button is disabled when textarea contains only whitespace', async ({ page }) => {
        await page.getByPlaceholder('Type your prayer here...').fill('   ');
        await expect(page.getByRole('button', { name: /send prayer request/i })).toBeDisabled();
    });

    test('submit button becomes enabled when text is entered', async ({ page }) => {
        await page.getByPlaceholder('Type your prayer here...').fill('Please pray for me');
        await expect(page.getByRole('button', { name: /send prayer request/i })).toBeEnabled();
    });

    test('character counter updates live as user types', async ({ page }) => {
        const textarea = page.getByPlaceholder('Type your prayer here...');
        await textarea.fill('abc');
        await expect(page.getByText('3 / 1000')).toBeVisible();
        await textarea.fill('abcde');
        await expect(page.getByText('5 / 1000')).toBeVisible();
    });

    test('textarea enforces maxLength of 1000', async ({ page }) => {
        const longText = 'a'.repeat(1100);
        const textarea = page.getByPlaceholder('Type your prayer here...');
        await textarea.fill(longText);
        const value = await textarea.inputValue();
        expect(value.length).toBeLessThanOrEqual(1000);
    });

    // ── Successful submission ───────────────────────────────────────────────

    test('shows success state after successful submission', async ({ page }) => {
        await mockSubmitApi(page, { success: true });
        await page.getByPlaceholder('Type your prayer here...').fill('Lord, please help me.');
        await page.getByRole('button', { name: /send prayer request/i }).click();
        await expect(page.getByText('Prayer Request Sent')).toBeVisible();
        await expect(page.getByText(/your request has been shared anonymously/i)).toBeVisible();
    });

    test('clears the textarea after successful submission', async ({ page }) => {
        await mockSubmitApi(page, { success: true });
        const textarea = page.getByPlaceholder('Type your prayer here...');
        await textarea.fill('Heal my family.');
        await page.getByRole('button', { name: /send prayer request/i }).click();
        await page.waitForSelector('text=Prayer Request Sent');
        // After coming back, textarea should be empty
        await page.getByRole('button', { name: /send another request/i }).click();
        await expect(textarea).toHaveValue('');
    });

    test('shows "Send another request" link on success screen', async ({ page }) => {
        await mockSubmitApi(page, { success: true });
        await page.getByPlaceholder('Type your prayer here...').fill('Thank you, Lord.');
        await page.getByRole('button', { name: /send prayer request/i }).click();
        await expect(page.getByRole('button', { name: /send another request/i })).toBeVisible();
    });

    test('"Send another request" resets back to the form', async ({ page }) => {
        await mockSubmitApi(page, { success: true });
        await page.getByPlaceholder('Type your prayer here...').fill('Guide me.');
        await page.getByRole('button', { name: /send prayer request/i }).click();
        await page.getByRole('button', { name: /send another request/i }).click();
        await expect(page.getByPlaceholder('Type your prayer here...')).toBeVisible();
        await expect(page.getByRole('button', { name: /send prayer request/i })).toBeVisible();
    });

    // ── Error state ─────────────────────────────────────────────────────────

    test('shows error message when API returns non-OK response', async ({ page }) => {
        await mockSubmitApi(page, { error: 'Internal Server Error' }, 500);
        await page.getByPlaceholder('Type your prayer here...').fill('Please help.');
        await page.getByRole('button', { name: /send prayer request/i }).click();
        await expect(page.getByText(/something went wrong/i)).toBeVisible();
    });

    test('form stays visible after error (does not navigate away)', async ({ page }) => {
        await mockSubmitApi(page, { error: 'Bad Request' }, 400);
        await page.getByPlaceholder('Type your prayer here...').fill('Help me.');
        await page.getByRole('button', { name: /send prayer request/i }).click();
        await expect(page.getByPlaceholder('Type your prayer here...')).toBeVisible();
    });

    test('submit button shows "Sending..." while request is in flight', async ({ page }) => {
        // Use a slow route to capture the in-flight state
        await page.route('**/api/submit', async route => {
            await page.waitForTimeout(300);
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        });
        await page.getByPlaceholder('Type your prayer here...').fill('Be with me.');
        await page.getByRole('button', { name: /send prayer request/i }).click();
        await expect(page.getByRole('button', { name: /sending/i })).toBeVisible();
        await page.waitForSelector('text=Prayer Request Sent');
    });

    // ── Navigation ──────────────────────────────────────────────────────────

    test('navigation bar contains "Wall" link pointing to /wall', async ({ page }) => {
        const wallLink = page.getByRole('link', { name: /wall/i }).first();
        await expect(wallLink).toBeVisible();
        await expect(wallLink).toHaveAttribute('href', '/wall');
    });

    test('clicking Wall nav link navigates to /wall', async ({ page }) => {
        await page.getByRole('link', { name: /wall/i }).first().click();
        await expect(page).toHaveURL('/wall');
    });

    // ── Theme toggle ────────────────────────────────────────────────────────

    test('theme toggle button is present on the page', async ({ page }) => {
        await expect(page.getByRole('button', { name: /toggle theme/i })).toBeVisible();
    });

    test('clicking theme toggle switches between light and dark mode', async ({ page }) => {
        const html = page.locator('html');
        const toggle = page.getByRole('button', { name: /toggle theme/i });
        const initialClass = await html.getAttribute('class') ?? '';
        await toggle.click();
        const newClass = await html.getAttribute('class') ?? '';
        expect(newClass).not.toBe(initialClass);
    });
});
