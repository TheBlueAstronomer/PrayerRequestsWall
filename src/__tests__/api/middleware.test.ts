import { proxy as middleware } from '@/proxy';
import { createSessionToken } from '@/lib/adminSession';

/**
 * Builds a minimal NextRequest-shaped object. The middleware only touches
 * nextUrl.pathname, cookies.get(), and url — enough to fake here.
 */
function makeRequest(pathname: string, cookieValue?: string) {
    return {
        nextUrl: { pathname },
        url: `http://localhost${pathname}`,
        cookies: {
            get: (name: string) =>
                name === 'admin_session' && cookieValue ? { value: cookieValue } : undefined,
        },
    } as unknown as Parameters<typeof middleware>[0];
}

describe('admin auth middleware', () => {
    beforeEach(() => {
        process.env.ADMIN_SESSION_SECRET = 'middleware-test-secret';
    });
    afterEach(() => delete process.env.ADMIN_SESSION_SECRET);

    it('lets the login endpoint through without a session', async () => {
        const res = await middleware(makeRequest('/api/admin/auth'));
        expect(res.status).toBe(200); // NextResponse.next()
    });

    it('blocks an admin API route with no session cookie', async () => {
        const res = await middleware(makeRequest('/api/admin/prayers'));
        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
    });

    it('blocks an admin API route with a tampered cookie', async () => {
        const res = await middleware(makeRequest('/api/admin/prayers', 'forged.token'));
        expect(res.status).toBe(401);
    });

    it('allows an admin API route with a valid session cookie', async () => {
        const token = await createSessionToken();
        const res = await middleware(makeRequest('/api/admin/prayers', token!));
        expect(res.status).toBe(200); // NextResponse.next()
    });

    it('blocks the sensitive endpoints (qr, logout, settings) when unauthenticated', async () => {
        for (const path of ['/api/admin/qr', '/api/admin/logout', '/api/admin/settings', '/api/admin/prayers/resend']) {
            const res = await middleware(makeRequest(path));
            expect(res.status).toBe(401);
        }
    });

    it('fails closed: even the login endpoint aside, no route authenticates without a secret', async () => {
        delete process.env.ADMIN_SESSION_SECRET;
        const token = 'anything.anything';
        const res = await middleware(makeRequest('/api/admin/prayers', token));
        expect(res.status).toBe(401);
    });
});
