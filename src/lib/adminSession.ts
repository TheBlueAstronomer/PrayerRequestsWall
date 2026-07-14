/**
 * Admin session tokens: HMAC-SHA256 signed, stateless, verified in both the
 * Edge middleware and Node route handlers.
 *
 * Uses only Web Crypto (`crypto.subtle`) and TextEncoder so this module stays
 * Edge-safe — it must NOT import anything Node-only, or `middleware.ts` will
 * fail to bundle. There is deliberately no server-side session store: on a small
 * host, a signed cookie is cheaper and has nothing to leak or run out of.
 *
 * Token layout:  base64url(payloadJSON) "." base64url(HMAC(payloadJSON))
 * Payload:       { "exp": <unix seconds> }
 */

export const ADMIN_SESSION_COOKIE = 'admin_session';

/** Default session lifetime if ADMIN_SESSION_TTL_SECONDS is unset. */
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

interface SessionPayload {
    exp: number; // unix seconds
}

function getTtlSeconds(): number {
    const configured = Number(process.env.ADMIN_SESSION_TTL_SECONDS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_SECONDS;
}

/**
 * The signing secret. Returns null when unset so callers fail closed rather
 * than signing/verifying with a predictable key.
 */
function getSecret(): string | null {
    const secret = process.env.ADMIN_SESSION_SECRET;
    return secret && secret.length > 0 ? secret : null;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    // btoa exists in both Edge and Node 18+ globals.
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function hmac(payloadB64: string, secret: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
    return new Uint8Array(sig);
}

/** Length-constant byte comparison — avoids leaking the signature via timing. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

/**
 * Constant-time string comparison for the password. Compares over a fixed
 * transform so length differences don't short-circuit the loop.
 */
export function safeEqualString(a: string, b: string): boolean {
    return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/**
 * Creates a signed session token valid for the configured TTL. Returns null if
 * no signing secret is configured (fail closed).
 */
export async function createSessionToken(now: number = Date.now()): Promise<string | null> {
    const secret = getSecret();
    if (!secret) return null;

    const payload: SessionPayload = { exp: Math.floor(now / 1000) + getTtlSeconds() };
    const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(payload)));
    const sigB64 = toBase64Url(await hmac(payloadB64, secret));
    return `${payloadB64}.${sigB64}`;
}

/**
 * Verifies a session token's signature and expiry. Returns true only for an
 * untampered, unexpired token signed with the configured secret.
 */
export async function verifySessionToken(token: string | undefined | null, now: number = Date.now()): Promise<boolean> {
    const secret = getSecret();
    if (!secret || !token) return false;

    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return false;

    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    let providedSig: Uint8Array;
    try {
        providedSig = fromBase64Url(sigB64);
    } catch {
        return false;
    }

    const expectedSig = await hmac(payloadB64, secret);
    if (!timingSafeEqual(providedSig, expectedSig)) return false;

    let payload: SessionPayload;
    try {
        payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
    } catch {
        return false;
    }

    if (typeof payload.exp !== 'number') return false;
    return Math.floor(now / 1000) < payload.exp;
}

/** Cookie Max-Age in seconds, matching the token TTL. */
export function sessionCookieMaxAge(): number {
    return getTtlSeconds();
}
