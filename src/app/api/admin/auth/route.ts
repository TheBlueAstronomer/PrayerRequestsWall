import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import {
    ADMIN_SESSION_COOKIE,
    createSessionToken,
    safeEqualString,
    sessionCookieMaxAge,
    verifySessionToken,
} from '@/lib/adminSession';

/**
 * POST — log in. Verifies the submitted password against ADMIN_PASSWORD in
 * constant time and, on success, sets a signed httpOnly session cookie.
 *
 * Fails closed: if ADMIN_PASSWORD or the session secret are unconfigured, no
 * password can authenticate.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const password = typeof body?.password === 'string' ? body.password : '';

        const expected = process.env.ADMIN_PASSWORD;
        if (!expected) {
            console.error('[admin:auth] ADMIN_PASSWORD is not set — refusing all logins.');
            return NextResponse.json({ error: 'Admin login is not configured' }, { status: 503 });
        }

        if (!safeEqualString(password, expected)) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const token = await createSessionToken();
        if (!token) {
            console.error('[admin:auth] ADMIN_SESSION_SECRET is not set — cannot issue a session.');
            return NextResponse.json({ error: 'Admin login is not configured' }, { status: 503 });
        }

        const store = await cookies();
        store.set(ADMIN_SESSION_COOKIE, token, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/',
            maxAge: sessionCookieMaxAge(),
        });

        return NextResponse.json({ success: true });
    } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

/**
 * GET — session check. Lets the admin page restore the logged-in view on reload
 * without forcing a re-login. Not a security control; the middleware is.
 */
export async function GET() {
    try {
        const store = await cookies();
        const token = store.get(ADMIN_SESSION_COOKIE)?.value;
        const authenticated = await verifySessionToken(token);
        return NextResponse.json({ authenticated });
    } catch {
        return NextResponse.json({ authenticated: false }, { status: 200 });
    }
}

/**
 * DELETE — log out of the admin session by clearing the cookie. Distinct from
 * POST /api/admin/logout, which logs out the WhatsApp bot.
 */
export async function DELETE() {
    const store = await cookies();
    store.delete(ADMIN_SESSION_COOKIE);
    return NextResponse.json({ success: true });
}
