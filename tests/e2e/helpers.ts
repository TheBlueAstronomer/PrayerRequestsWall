import { Page } from '@playwright/test';

/** Intercept POST /api/submit with a given JSON response and status. */
export function mockSubmitApi(page: Page, body: object, status = 200) {
    return page.route('**/api/submit', route =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    );
}

/** Intercept POST /api/admin/auth */
export function mockAuthApi(page: Page, body: object, status = 200) {
    return page.route('**/api/admin/auth', route =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    );
}

/** Intercept GET /api/admin/prayers */
export function mockPrayersApi(page: Page, prayers: object[]) {
    return page.route('**/api/admin/prayers', route => {
        if (route.request().method() === 'GET') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ success: true, prayers }),
            });
        }
        return route.continue();
    });
}

/** Intercept DELETE /api/admin/prayers */
export function mockDeletePrayerApi(page: Page, status = 200) {
    return page.route('**/api/admin/prayers**', route => {
        if (route.request().method() === 'DELETE') {
            return route.fulfill({
                status,
                contentType: 'application/json',
                body: JSON.stringify({ success: status === 200 }),
            });
        }
        return route.continue();
    });
}

/** Intercept GET /api/admin/qr */
export function mockQrApi(page: Page, qr: string | null) {
    return page.route('**/api/admin/qr', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, qr }),
        })
    );
}

/** Intercept GET /api/admin/settings */
export function mockSettingsGetApi(page: Page, groupIds = '') {
    return page.route('**/api/admin/settings', route => {
        if (route.request().method() === 'GET') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ success: true, whatsapp_group_ids: groupIds }),
            });
        }
        return route.continue();
    });
}

/** Intercept POST /api/admin/settings */
export function mockSettingsPostApi(page: Page, status = 200) {
    return page.route('**/api/admin/settings', route => {
        if (route.request().method() === 'POST') {
            return route.fulfill({
                status,
                contentType: 'application/json',
                body: JSON.stringify({ success: status === 200 }),
            });
        }
        return route.continue();
    });
}

/** Intercept POST /api/admin/logout */
export function mockLogoutApi(page: Page, success = true) {
    return page.route('**/api/admin/logout', route =>
        route.fulfill({
            status: success ? 200 : 500,
            contentType: 'application/json',
            body: JSON.stringify({ success }),
        })
    );
}

/** Intercept POST /api/admin/prayers/resend */
export function mockResendApi(page: Page, body: object, status = 200) {
    return page.route('**/api/admin/prayers/resend', route =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    );
}

/** Log in to the admin panel by submitting the login form. */
export async function loginAdmin(page: Page, password = 'root') {
    await page.goto('/admin');
    await page.getByPlaceholder('Password').fill(password);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForSelector('text=Admin Dashboard');
}

/** Stub all admin data-fetch APIs so the dashboard renders cleanly. */
export async function stubAdminApis(
    page: Page,
    opts: { prayers?: object[]; qr?: string | null; groupIds?: string } = {}
) {
    const { prayers = [], qr = null, groupIds = '' } = opts;
    await mockAuthApi(page, { success: true, token: 'admin_token_temp' });
    await mockPrayersApi(page, prayers);
    await mockQrApi(page, qr);
    await mockSettingsGetApi(page, groupIds);
}
