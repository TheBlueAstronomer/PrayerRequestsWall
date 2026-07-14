import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { ADMIN_SESSION_COOKIE, verifySessionToken } from '@/lib/adminSession';

/**
 * Single choke point for admin auth. Every `/api/admin/*` route except the login
 * endpoint requires a valid signed session cookie. Enforcing here rather than
 * per-route means a newly added admin route is protected by default instead of
 * relying on the author to remember.
 *
 * The `/admin` *page* is intentionally not gated here: it is itself the login
 * screen, and every piece of data it shows comes from `/api/admin/*`, which this
 * middleware protects. Redirecting the login page to itself would loop.
 */
export async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // The login/session endpoint must stay reachable so a user can obtain a session.
    if (pathname === '/api/admin/auth') {
        return NextResponse.next();
    }

    const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    if (await verifySessionToken(token)) {
        return NextResponse.next();
    }

    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export const config = {
    matcher: ['/api/admin/:path*'],
};
