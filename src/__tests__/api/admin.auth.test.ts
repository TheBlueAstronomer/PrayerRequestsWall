const mockCookieStore = {
    set: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
};

jest.mock('next/headers', () => ({
    cookies: jest.fn(async () => mockCookieStore),
}));

import { POST, GET, DELETE } from '@/app/api/admin/auth/route';
import { verifySessionToken, createSessionToken, ADMIN_SESSION_COOKIE } from '@/lib/adminSession';

function makeRequest(body: unknown): Request {
    return new Request('http://localhost/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/admin/auth (login)', () => {
    beforeEach(() => {
        process.env.ADMIN_PASSWORD = 'correct horse';
        process.env.ADMIN_SESSION_SECRET = 'unit-test-secret';
        mockCookieStore.set.mockClear();
    });

    afterEach(() => {
        delete process.env.ADMIN_PASSWORD;
        delete process.env.ADMIN_SESSION_SECRET;
    });

    it('sets a valid session cookie on the correct password', async () => {
        const res = await POST(makeRequest({ password: 'correct horse' }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.token).toBeUndefined(); // credential never leaves in the body

        expect(mockCookieStore.set).toHaveBeenCalledTimes(1);
        const [name, value, opts] = mockCookieStore.set.mock.calls[0];
        expect(name).toBe(ADMIN_SESSION_COOKIE);
        expect(opts).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
        // The cookie value must be a genuinely valid session token.
        await expect(verifySessionToken(value)).resolves.toBe(true);
    });

    it('rejects an incorrect password with 401 and no cookie', async () => {
        const res = await POST(makeRequest({ password: 'wrong' }));
        const json = await res.json();

        expect(res.status).toBe(401);
        expect(json.error).toBe('Unauthorized');
        expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it('rejects a missing password field', async () => {
        const res = await POST(makeRequest({}));
        expect(res.status).toBe(401);
        expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it('no longer accepts the old hardcoded password', async () => {
        const res = await POST(makeRequest({ password: 'root' }));
        expect(res.status).toBe(401);
    });

    it('fails closed with 503 when ADMIN_PASSWORD is unset', async () => {
        delete process.env.ADMIN_PASSWORD;
        const res = await POST(makeRequest({ password: 'anything' }));
        expect(res.status).toBe(503);
        expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it('fails closed with 503 when the session secret is unset', async () => {
        delete process.env.ADMIN_SESSION_SECRET;
        const res = await POST(makeRequest({ password: 'correct horse' }));
        expect(res.status).toBe(503);
        expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it('returns 500 on invalid JSON body', async () => {
        const badRequest = new Request('http://localhost/api/admin/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not-json',
        });
        const res = await POST(badRequest);
        expect(res.status).toBe(500);
    });
});

describe('GET /api/admin/auth (session check)', () => {
    beforeEach(() => {
        process.env.ADMIN_SESSION_SECRET = 'unit-test-secret';
        mockCookieStore.get.mockReset();
    });
    afterEach(() => delete process.env.ADMIN_SESSION_SECRET);

    it('reports authenticated:true for a valid cookie', async () => {
        const token = await createSessionToken();
        mockCookieStore.get.mockReturnValue({ value: token });

        const res = await GET();
        const json = await res.json();
        expect(json.authenticated).toBe(true);
    });

    it('reports authenticated:false when no cookie is present', async () => {
        mockCookieStore.get.mockReturnValue(undefined);
        const res = await GET();
        const json = await res.json();
        expect(json.authenticated).toBe(false);
    });
});

describe('DELETE /api/admin/auth (session logout)', () => {
    it('clears the session cookie', async () => {
        mockCookieStore.delete.mockClear();
        const res = await DELETE();
        const json = await res.json();

        expect(json.success).toBe(true);
        expect(mockCookieStore.delete).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE);
    });
});
