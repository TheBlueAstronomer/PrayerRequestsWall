import { test, expect } from '@playwright/test';
import {
    mockAuthApi,
    mockQrApi,
    mockSettingsGetApi,
    mockSettingsPostApi,
    mockResendApi,
    mockLogoutApi,
    stubAdminApis,
    loginAdmin,
} from './helpers';

// ── Shared sample data ────────────────────────────────────────────────────────

const SAMPLE_PRAYERS = [
    { id: 1, content: 'Pray for my healing', createdAt: new Date().toISOString(), whatsappSent: true },
    { id: 2, content: 'Guidance for my family', createdAt: new Date().toISOString(), whatsappSent: false },
];

// ─────────────────────────────────────────────────────────────────────────────
// Login screen
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Admin — Login Screen', () => {

    test('renders the Admin Access heading', async ({ page }) => {
        await page.goto('/admin');
        await expect(page.getByRole('heading', { name: 'Admin Access' })).toBeVisible();
    });

    test('renders password input and Login button', async ({ page }) => {
        await page.goto('/admin');
        await expect(page.getByPlaceholder('Password')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
    });

    test('renders "Back to Home" link pointing to /', async ({ page }) => {
        await page.goto('/admin');
        const link = page.getByRole('link', { name: /back to home/i });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('href', '/');
    });

    test('shows error message for wrong password', async ({ page }) => {
        await mockAuthApi(page, { error: 'Unauthorized' }, 401);
        await page.goto('/admin');
        await page.getByPlaceholder('Password').fill('wrongpass');
        await page.getByRole('button', { name: 'Login' }).click();
        await expect(page.getByText('Invalid password')).toBeVisible();
    });

    test('does not show error message before first submit attempt', async ({ page }) => {
        await page.goto('/admin');
        await expect(page.getByText('Invalid password')).not.toBeVisible();
    });

    test('navigates to dashboard after correct password', async ({ page }) => {
        await stubAdminApis(page);
        await page.goto('/admin');
        await page.getByPlaceholder('Password').fill('root');
        await page.getByRole('button', { name: 'Login' }).click();
        await expect(page.getByRole('heading', { name: 'Admin Dashboard' })).toBeVisible();
    });

    test('password field masks input', async ({ page }) => {
        await page.goto('/admin');
        await expect(page.getByPlaceholder('Password')).toHaveAttribute('type', 'password');
    });

    test('"Back to Home" link navigates to the submit page', async ({ page }) => {
        await page.goto('/admin');
        await page.getByRole('link', { name: /back to home/i }).click();
        await expect(page).toHaveURL('/');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — structure
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Admin — Dashboard Structure', () => {

    test.beforeEach(async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await loginAdmin(page);
    });

    test('renders Admin Dashboard heading', async ({ page }) => {
        await expect(page.getByRole('heading', { name: 'Admin Dashboard' })).toBeVisible();
    });

    test('renders WhatsApp Configuration section', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /whatsapp configuration/i })).toBeVisible();
    });

    test('renders WhatsApp Authentication section', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /whatsapp authentication/i })).toBeVisible();
    });

    test('renders Prayer Requests section', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /prayer requests/i })).toBeVisible();
    });

    test('shows correct prayer count in section heading', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /prayer requests \(2\)/i })).toBeVisible();
    });

    test('"Exit Admin" link navigates to /', async ({ page }) => {
        const link = page.getByRole('link', { name: /exit admin/i });
        await expect(link).toBeVisible();
        await link.click();
        await expect(page).toHaveURL('/');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — WhatsApp Configuration (settings)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Admin — WhatsApp Configuration', () => {

    test('group ID input is pre-filled from API', async ({ page }) => {
        await stubAdminApis(page, { groupIds: '123@g.us,456@g.us' });
        await loginAdmin(page);
        await expect(page.locator('input[placeholder*="12036312345678"]')).toHaveValue('123@g.us,456@g.us');
    });

    test('group ID input is empty when no setting is configured', async ({ page }) => {
        await stubAdminApis(page, { groupIds: '' });
        await loginAdmin(page);
        await expect(page.locator('input[placeholder*="12036312345678"]')).toHaveValue('');
    });

    test('shows "Save Settings" button', async ({ page }) => {
        await stubAdminApis(page);
        await loginAdmin(page);
        await expect(page.getByRole('button', { name: /save settings/i })).toBeVisible();
    });

    test('clicking Save Settings calls POST /api/admin/settings', async ({ page }) => {
        await stubAdminApis(page, { groupIds: '' });
        await mockSettingsPostApi(page);
        await loginAdmin(page);

        const input = page.locator('input[placeholder*="12036312345678"]');
        await input.fill('newgroup@g.us');
        await page.getByRole('button', { name: /save settings/i }).click();
        await expect(page.getByText(/settings saved/i)).toBeVisible();
    });

    test('shows "Saving..." while save is in flight', async ({ page }) => {
        await stubAdminApis(page, { groupIds: '' });
        await page.route('**/api/admin/settings', async route => {
            if (route.request().method() === 'POST') {
                await page.waitForTimeout(300);
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
            } else {
                await route.continue();
            }
        });
        await loginAdmin(page);

        await page.locator('input[placeholder*="12036312345678"]').fill('group@g.us');
        await page.getByRole('button', { name: /save settings/i }).click();
        await expect(page.getByText('Saving...')).toBeVisible();
        await expect(page.getByText(/settings saved/i)).toBeVisible();
    });

    test('shows "Failed to save." when POST /api/admin/settings returns error', async ({ page }) => {
        await stubAdminApis(page, { groupIds: '' });
        await mockSettingsPostApi(page, 500);
        await loginAdmin(page);

        await page.getByRole('button', { name: /save settings/i }).click();
        await expect(page.getByText(/failed to save/i)).toBeVisible();
    });

    test('displays configured group IDs as a list', async ({ page }) => {
        await stubAdminApis(page, { groupIds: '111@g.us,222@g.us' });
        await loginAdmin(page);
        await expect(page.getByText('111@g.us')).toBeVisible();
        await expect(page.getByText('222@g.us')).toBeVisible();
    });

    test('each configured group ID has a delete button', async ({ page }) => {
        await stubAdminApis(page, { groupIds: '111@g.us' });
        await loginAdmin(page);
        await expect(page.locator('button[title="Remove ID"]')).toBeVisible();
    });

    test('clicking remove ID button calls POST /api/admin/settings and removes from list', async ({ page }) => {
        await stubAdminApis(page, { groupIds: '111@g.us,222@g.us' });
        // The second POST (removal) should succeed
        await page.route('**/api/admin/settings', route => {
            if (route.request().method() === 'POST') {
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
            }
            return route.continue();
        });
        await loginAdmin(page);

        await page.locator('button[title="Remove ID"]').first().click();
        await expect(page.getByText(/id removed/i)).toBeVisible();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — QR Code / WhatsApp Authentication
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Admin — WhatsApp Authentication Panel', () => {

    test('shows "WhatsApp is connected" when QR is null', async ({ page }) => {
        await stubAdminApis(page, { qr: null });
        await loginAdmin(page);
        await expect(page.getByText('WhatsApp is connected.')).toBeVisible();
    });

    test('shows QR code SVG when QR data is present', async ({ page }) => {
        await stubAdminApis(page, { qr: '2@mock-qr-data-string' });
        await loginAdmin(page);
        // Locate the QR SVG rendered by qrcode.react (has role="img" inside the white box)
        await expect(page.getByRole('img').first()).toBeVisible();
        await expect(page.getByText(/scan to connect whatsapp bot/i)).toBeVisible();
    });

    test('shows "Logout WhatsApp Session" button when connected (no QR)', async ({ page }) => {
        await stubAdminApis(page, { qr: null });
        await loginAdmin(page);
        await expect(page.getByRole('button', { name: /logout whatsapp session/i })).toBeVisible();
    });

    test('does not show logout button when QR code is being displayed', async ({ page }) => {
        await stubAdminApis(page, { qr: '2@some-qr-string' });
        await loginAdmin(page);
        await expect(page.getByRole('button', { name: /logout whatsapp session/i })).not.toBeVisible();
    });

    test('clicking Logout WhatsApp Session opens a confirm dialog', async ({ page }) => {
        await stubAdminApis(page, { qr: null });
        await loginAdmin(page);

        let dialogMessage = '';
        page.on('dialog', async dialog => {
            dialogMessage = dialog.message();
            await dialog.dismiss();
        });

        await page.getByRole('button', { name: /logout whatsapp session/i }).click();
        expect(dialogMessage).toMatch(/are you sure you want to logout/i);
    });

    test('confirms logout and calls POST /api/admin/logout', async ({ page }) => {
        await stubAdminApis(page, { qr: null });
        await mockLogoutApi(page, true);
        await loginAdmin(page);

        page.on('dialog', dialog => dialog.accept());

        let logoutCalled = false;
        page.on('request', req => {
            if (req.url().includes('/api/admin/logout') && req.method() === 'POST') {
                logoutCalled = true;
            }
        });

        await page.getByRole('button', { name: /logout whatsapp session/i }).click();
        await page.waitForTimeout(500);
        expect(logoutCalled).toBe(true);
    });

    test('dismissing the logout confirm dialog does not call the API', async ({ page }) => {
        await stubAdminApis(page, { qr: null });
        await loginAdmin(page);

        page.on('dialog', dialog => dialog.dismiss());

        let logoutCalled = false;
        page.on('request', req => {
            if (req.url().includes('/api/admin/logout')) logoutCalled = true;
        });

        await page.getByRole('button', { name: /logout whatsapp session/i }).click();
        await page.waitForTimeout(300);
        expect(logoutCalled).toBe(false);
    });

    test('logout button shows "Logging out..." while request is in flight', async ({ page }) => {
        await stubAdminApis(page, { qr: null });
        await page.route('**/api/admin/logout', async route => {
            await page.waitForTimeout(400);
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        });
        await loginAdmin(page);

        page.on('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: /logout whatsapp session/i }).click();
        await expect(page.getByRole('button', { name: /logging out/i })).toBeVisible();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — Prayer Requests list
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Admin — Prayer Requests List', () => {

    test('shows "No prayer requests found." when list is empty', async ({ page }) => {
        await stubAdminApis(page, { prayers: [] });
        await loginAdmin(page);
        await expect(page.getByText('No prayer requests found.')).toBeVisible();
    });

    test('renders each prayer content', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await loginAdmin(page);
        await expect(page.getByText('Pray for my healing')).toBeVisible();
        await expect(page.getByText('Guidance for my family')).toBeVisible();
    });

    test('shows "Sent" badge for prayers where whatsappSent is true', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await loginAdmin(page);
        await expect(page.getByText('Sent').first()).toBeVisible();
    });

    test('shows "Not sent" badge for prayers where whatsappSent is false', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await loginAdmin(page);
        await expect(page.getByText('Not sent').first()).toBeVisible();
    });

    test('each prayer row has a delete button', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await loginAdmin(page);
        const deleteButtons = page.locator('button[title="Delete Prayer"]');
        await expect(deleteButtons).toHaveCount(SAMPLE_PRAYERS.length);
    });

    test('each prayer row has a resend button', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await loginAdmin(page);
        const resendButtons = page.locator('button[title="Resend to WhatsApp"]');
        await expect(resendButtons).toHaveCount(SAMPLE_PRAYERS.length);
    });

    // ── Delete prayer ───────────────────────────────────────────────────────

    test('clicking Delete opens a confirm dialog', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await loginAdmin(page);

        let dialogShown = false;
        page.on('dialog', async dialog => {
            dialogShown = true;
            await dialog.dismiss();
        });

        await page.locator('button[title="Delete Prayer"]').first().click();
        expect(dialogShown).toBe(true);
    });

    test('confirming delete removes the prayer from the list', async ({ page }) => {
        // Single route handler owns both GET and DELETE so real DB is never hit
        let prayers = [...SAMPLE_PRAYERS];
        await mockAuthApi(page, { success: true, token: 'admin_token_temp' });
        await mockQrApi(page, null);
        await mockSettingsGetApi(page, '');
        await page.route('**/api/admin/prayers**', route => {
            const method = route.request().method();
            if (method === 'GET') {
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, prayers }) });
            }
            if (method === 'DELETE') {
                const url = new URL(route.request().url());
                const id = parseInt(url.searchParams.get('id') ?? '0', 10);
                prayers = prayers.filter(p => p.id !== id);
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
            }
            return route.continue();
        });
        await loginAdmin(page);

        page.on('dialog', dialog => dialog.accept());
        await page.locator('button[title="Delete Prayer"]').first().click();
        await expect(page.locator('button[title="Delete Prayer"]')).toHaveCount(SAMPLE_PRAYERS.length - 1);
    });

    test('dismissing the delete confirm dialog keeps the prayer in the list', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await loginAdmin(page);

        page.on('dialog', dialog => dialog.dismiss());
        await page.locator('button[title="Delete Prayer"]').first().click();
        await page.waitForTimeout(200);

        const remaining = await page.locator('button[title="Delete Prayer"]').count();
        expect(remaining).toBe(SAMPLE_PRAYERS.length);
    });

    // ── Resend prayer ───────────────────────────────────────────────────────

    test('clicking Resend calls POST /api/admin/prayers/resend', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await mockResendApi(page, { success: true, partialFailure: false });
        await loginAdmin(page);

        let resendCalled = false;
        page.on('request', req => {
            if (req.url().includes('/api/admin/prayers/resend') && req.method() === 'POST') {
                resendCalled = true;
            }
        });

        await page.locator('button[title="Resend to WhatsApp"]').first().click();
        await page.waitForTimeout(400);
        expect(resendCalled).toBe(true);
    });

    test('successful resend updates the badge from "Not sent" to "Sent"', async ({ page }) => {
        const unsent = [{ id: 10, content: 'Please resend me', createdAt: new Date().toISOString(), whatsappSent: false }];
        await stubAdminApis(page, { prayers: unsent });
        await mockResendApi(page, { success: true, partialFailure: false });
        await loginAdmin(page);

        await expect(page.getByText('Not sent')).toBeVisible();
        await page.locator('button[title="Resend to WhatsApp"]').click();
        await expect(page.getByText('Sent')).toBeVisible();
        await expect(page.getByText('Not sent')).not.toBeVisible();
    });

    test('resend button is disabled while resend is in flight', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await page.route('**/api/admin/prayers/resend', async route => {
            await page.waitForTimeout(400);
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, partialFailure: false }) });
        });
        await loginAdmin(page);

        const resendBtn = page.locator('button[title="Resend to WhatsApp"]').first();
        await resendBtn.click();
        await expect(resendBtn).toBeDisabled();
    });

    test('shows an alert when resend fails', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await mockResendApi(page, { success: false, error: 'WhatsApp not connected' });
        await loginAdmin(page);

        let alertMessage = '';
        page.on('dialog', async dialog => {
            alertMessage = dialog.message();
            await dialog.accept();
        });

        await page.locator('button[title="Resend to WhatsApp"]').first().click();
        await page.waitForTimeout(400);
        expect(alertMessage).toMatch(/whatsapp not connected|failed to resend/i);
    });

    test('renders prayer creation timestamp', async ({ page }) => {
        await stubAdminApis(page, { prayers: SAMPLE_PRAYERS });
        await loginAdmin(page);
        // Each prayer row should contain a locale timestamp string
        const timestamps = page.locator('p.text-sm.text-slate-500');
        await expect(timestamps.first()).toBeVisible();
    });
});
