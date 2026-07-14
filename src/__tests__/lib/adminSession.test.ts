import {
    ADMIN_SESSION_COOKIE,
    createSessionToken,
    safeEqualString,
    sessionCookieMaxAge,
    verifySessionToken,
} from '@/lib/adminSession';

const SECRET = 'test-secret-value-abc123';

describe('adminSession — token sign/verify', () => {
    beforeEach(() => {
        process.env.ADMIN_SESSION_SECRET = SECRET;
        delete process.env.ADMIN_SESSION_TTL_SECONDS;
    });

    afterEach(() => {
        delete process.env.ADMIN_SESSION_SECRET;
        delete process.env.ADMIN_SESSION_TTL_SECONDS;
    });

    it('round-trips a freshly signed token', async () => {
        const token = await createSessionToken();
        expect(token).toBeTruthy();
        await expect(verifySessionToken(token)).resolves.toBe(true);
    });

    it('rejects a token whose payload was tampered with', async () => {
        const token = await createSessionToken();
        const [, sig] = token!.split('.');
        // Forge a far-future expiry but keep the original signature.
        const forgedPayload = Buffer.from(JSON.stringify({ exp: 9999999999 }))
            .toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await expect(verifySessionToken(`${forgedPayload}.${sig}`)).resolves.toBe(false);
    });

    it('rejects a token whose signature was tampered with', async () => {
        const token = await createSessionToken();
        const [payload] = token!.split('.');
        await expect(verifySessionToken(`${payload}.abcdef`)).resolves.toBe(false);
    });

    it('rejects an expired token', async () => {
        process.env.ADMIN_SESSION_TTL_SECONDS = '1';
        const issuedAt = 1_000_000_000_000; // fixed ms
        const token = await createSessionToken(issuedAt);
        // 2s later the 1s TTL has passed.
        await expect(verifySessionToken(token, issuedAt + 2000)).resolves.toBe(false);
        // ...but it is valid before expiry.
        await expect(verifySessionToken(token, issuedAt + 500)).resolves.toBe(true);
    });

    it('rejects a token signed with a different secret', async () => {
        const token = await createSessionToken();
        process.env.ADMIN_SESSION_SECRET = 'a-different-secret';
        await expect(verifySessionToken(token)).resolves.toBe(false);
    });

    it('rejects malformed tokens', async () => {
        await expect(verifySessionToken('')).resolves.toBe(false);
        await expect(verifySessionToken('no-dot')).resolves.toBe(false);
        await expect(verifySessionToken('.only-sig')).resolves.toBe(false);
        await expect(verifySessionToken('only-payload.')).resolves.toBe(false);
        await expect(verifySessionToken(undefined)).resolves.toBe(false);
    });

    it('fails closed when no secret is configured', async () => {
        delete process.env.ADMIN_SESSION_SECRET;
        await expect(createSessionToken()).resolves.toBeNull();
        await expect(verifySessionToken('anything.anything')).resolves.toBe(false);
    });
});

describe('adminSession — helpers', () => {
    it('safeEqualString compares by content', () => {
        expect(safeEqualString('hunter2', 'hunter2')).toBe(true);
        expect(safeEqualString('hunter2', 'hunter3')).toBe(false);
        expect(safeEqualString('short', 'longer-value')).toBe(false);
        expect(safeEqualString('', '')).toBe(true);
    });

    it('exposes the cookie name and a positive max-age', () => {
        expect(ADMIN_SESSION_COOKIE).toBe('admin_session');
        expect(sessionCookieMaxAge()).toBeGreaterThan(0);
    });

    it('honours ADMIN_SESSION_TTL_SECONDS for max-age', () => {
        process.env.ADMIN_SESSION_TTL_SECONDS = '3600';
        expect(sessionCookieMaxAge()).toBe(3600);
        delete process.env.ADMIN_SESSION_TTL_SECONDS;
    });
});
