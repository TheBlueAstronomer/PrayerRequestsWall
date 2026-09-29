import fs from 'fs';
import path from 'path';

import type { ConnectionState, WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';

/**
 * Baileys disconnect status codes, mirroring DisconnectReason in
 * @whiskeysockets/baileys (lib/Types/index.d.ts). Declared locally rather than
 * imported so the values stay available even when the library is mocked.
 */
const WA_LOGGED_OUT = 401;            // DisconnectReason.loggedOut
const WA_FORBIDDEN = 403;             // DisconnectReason.forbidden
const WA_MULTIDEVICE_MISMATCH = 411;  // DisconnectReason.multideviceMismatch
const WA_CONNECTION_REPLACED = 440;   // DisconnectReason.connectionReplaced
const WA_RESTART_REQUIRED = 515;      // DisconnectReason.restartRequired

/** Close codes that mean the session is gone and a human must re-scan. */
const SESSION_LOST_CODES = new Set([WA_LOGGED_OUT, WA_FORBIDDEN, WA_MULTIDEVICE_MISMATCH]);

/**
 * Stable event token for the "session lost, a human must re-scan the QR" alert.
 * A Cloud Logging metric matches this exact string in jsonPayload.message, so it
 * must not change without updating the metric filter. Emitting a dedicated token
 * (rather than alerting on an incidental log sentence) is the whole point — the
 * alert can't silently break because someone reworded a log line.
 */
const SESSION_LOST_EVENT = 'wa_session_lost';

/**
 * Backoff ladder for consecutive failed initialize() attempts, in ms. The Nth
 * consecutive failure blocks the next non-forced attempt for INIT_BACKOFF_MS[N-1];
 * the last value repeats.
 */
const INIT_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000];

/** Auth directory default. Overridable by WA_AUTH_PATH. */
const DEFAULT_AUTH_DIR = '/app/.baileys_auth';

/**
 * How long a socket may sit in 'connecting' before we declare it dead. Baileys'
 * own connectTimeoutMs covers the TCP/noise handshake only; a socket that
 * completes the handshake and then goes silent emits nothing at all. This is the
 * Baileys equivalent of the pupBrowser disconnect watcher — without it, a dead
 * socket leaves isInitializing latched forever and a loud outage becomes a silent one.
 */
const CONNECT_WATCHDOG_MS = 90_000;

/** Ceiling on sock.logout()/sock.end() so an admin Logout can never 504 at nginx (62s). */
const SOCKET_END_TIMEOUT_MS = 5_000;

/** Device label shown in the phone's Linked Devices list. */
const WA_BROWSER: [string, string, string] = ['TribePrayer', 'Chrome', '1.0.0'];

/** Minimal shape of a Baileys close error (a @hapi/boom instance at runtime). */
type DisconnectError = Error & { output?: { statusCode?: number } };

/** Non-mutating snapshot of the client lifecycle, for routes that must report. */
export type WhatsAppStatus = {
    connected: boolean;
    hasQr: boolean;
    initializing: boolean;
    consecutiveInitFailures: number;
    /** Epoch ms; 0 when no backoff window is in effect. */
    nextInitAllowedAt: number;
};

class WhatsAppService {
    public latestQR: string | null = null;

    /** The live socket, or null when none is open. Replaces `public client`. */
    private sock: WASocket | null = null;

    private isReady: boolean = false;
    private isShuttingDown: boolean = false;

    /**
     * True from the moment initialize() commits to opening a socket until that
     * socket reaches 'open', dies, or the watchdog fires. Doubles as the
     * re-entrancy guard (see initialize()'s doc). One latch, not two: the
     * initInFlight/isInitializing pair existed only to stop two Chromiums
     * launching against one profile.
     */
    private isInitializing: boolean = false;

    /**
     * Was this socket's auth state already registered when we opened it? Captured
     * at socket creation, because on close we must distinguish "a paired session
     * dropped, reconnect" from "nobody scanned the QR, stand down".
     */
    private wasRegistered: boolean = false;

    /**
     * Set while an admin-initiated logout() is in flight, so the loggedOut close
     * it causes is recognised as intentional and does NOT raise the session-lost
     * alert. Consumed (reset) by logout() after the socket is detached.
     */
    private intentionalLogout: boolean = false;

    /** At most one scheduled auto-reconnect is ever armed. This is the storm guard. */
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /** Armed at socket creation, disarmed on 'open' or 'close'. See CONNECT_WATCHDOG_MS. */
    private connectWatchdog: ReturnType<typeof setTimeout> | null = null;

    /** Consecutive failed connection attempts. Reset only by a successful 'open'. */
    private consecutiveInitFailures: number = 0;

    /** Epoch ms before which a non-forced initialize() is refused. 0 = no backoff. */
    private nextInitAllowedAt: number = 0;

    /** Resolved once in the constructor so tests can set WA_AUTH_PATH before import. */
    private readonly authDir: string;

    /**
     * Baileys 7 requires a real logger: passing `logger: undefined` overrides
     * DEFAULT_CONNECTION_CONFIG's own and throws
     * "Cannot read properties of undefined (reading 'child')" inside
     * makeNoiseHandler (S1 finding 1). Level 'silent' because Baileys' debug
     * output is very chatty and this container's stdout ships to Cloud Logging,
     * which is billed.
     */
    private readonly logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

    constructor() {
        console.log('[WA:init] Constructing WhatsAppService singleton...');

        this.authDir = process.env.WA_AUTH_PATH || DEFAULT_AUTH_DIR;

        this.setupGracefulShutdown();
    }

    /**
     * Builds one Baileys socket from the on-disk auth state and wires it to this
     * service. Rejections (an unreadable auth dir, a non-directory at the path) are
     * real init failures and are caught by initialize(), not here.
     */
    private async openSocket(): Promise<void> {
        // Dynamic import, NOT a top-level import. Baileys 7 is ESM-only, and one of its
        // own dependencies (whatsapp-rust-bridge) exports only an "import" condition.
        // Production starts under `tsx server.ts`, which compiles this file to CJS, so a
        // static import becomes require() and tsx's CJS resolver rejects that dependency
        // with ERR_PACKAGE_PATH_NOT_EXPORTED at module load, taking the whole server
        // down, not just WhatsApp. A dynamic import() goes through the ESM loader and
        // resolves it correctly. The type-only import above is erased, so it is safe.
        const { makeWASocket, useMultiFileAuthState } = await import('@whiskeysockets/baileys');

        // Not a React hook: Baileys' name merely starts with `use`, which trips
        // react-hooks/rules-of-hooks inside a class.
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        // Local, not `this.wasRegistered`, until we know this socket is the one that
        // gets installed: a socket we go on to discard must not leave its own
        // registration state behind on the service (see the first-wins guard below).
        const registered = !!state.creds?.registered;

        const sock = makeWASocket({
            auth: state,
            logger: this.logger,
            browser: WA_BROWSER,
            // Send-only bot: never pull chat history, never mark the account online
            // (the phone must keep getting notifications), never build link previews.
            // Baileys' defaults are syncFullHistory: true and markOnlineOnConnect: true,
            // both of which cost real memory on a 2 GB box.
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 30_000,
            keepAliveIntervalMs: 30_000,
        });

        // First wins. A logout() landing while this call is parked on either await
        // above re-arms initialize({ force: true }), and that re-arm can finish first
        // (the auth dir it reads is now empty, so it has less to do). By the time we
        // reach here, a socket may already be installed.
        //
        // Discard ours rather than overwrite it. The incumbent was built against the
        // auth dir as it exists NOW, post-wipe, so it is the one that can issue the
        // fresh QR the admin is waiting for; ours still holds the pre-wipe credentials
        // they just asked us to destroy. Overwriting would report connected as the very
        // account that was logged out, and strand the incumbent — never ended, every
        // event it emits dropped by the identity guard in attach().
        //
        // graceful: false is deliberate. This socket is being thrown away, not logged
        // out, and sock.logout() here would unlink the device from the phone.
        if (this.sock) {
            console.warn('[WA:init] Another socket was installed while this launch was in flight; discarding this one.');
            await this.endSocket(sock, false);
            return;
        }

        this.wasRegistered = registered;
        this.sock = sock;
        this.attach(sock, saveCreds);
        this.armConnectWatchdog(sock);
    }

    /**
     * Subscribes to one socket's events. `sock` and `saveCreds` are closed over,
     * never re-read from `this`: each initialize() produces a fresh
     * { state, saveCreds } pair and they must not be crossed.
     *
     * The `this.sock !== sock` guard on both handlers is the backstop for a socket
     * that has been replaced or discarded. On creds.update it is not cosmetic: a
     * discarded socket flushing stale creds into the shared auth directory would
     * corrupt the live session's keys.
     */
    private attach(sock: WASocket, saveCreds: () => Promise<void>): void {
        sock.ev.on('creds.update', () => {
            if (this.sock !== sock) return;
            void saveCreds().catch((err) => console.error('[WA:auth] Failed to persist credentials:', err));
        });
        sock.ev.on('connection.update', (u) => this.onConnectionUpdate(sock, u));
    }

    /**
     * connection.update is emitted with partial payloads: a QR arrives as { qr }
     * alone, pairing success as { isNewLogin: true, qr: undefined }, open as
     * { connection: 'open' }, close as { connection: 'close', lastDisconnect }.
     * Hence the independent ifs, and `if (qr)` rather than `'qr' in u` — a
     * `qr: undefined` must not be mistaken for a new code.
     *
     * The identity guard on the first line is the single most important invariant
     * in this file. A superseded socket's late event, applied to shared state, once
     * put a dead client's QR into latestQR, so the code shown in the admin UI was
     * frequently unscannable.
     */
    private onConnectionUpdate(sock: WASocket, u: Partial<ConnectionState>): void {
        if (this.sock !== sock) return;

        const { connection, qr, lastDisconnect, isNewLogin } = u;

        if (qr) {
            console.log(`[WA:qr] New QR code received (length: ${qr.length}). Awaiting scan.`);
            this.latestQR = qr;
        }

        if (isNewLogin) {
            console.log('[WA:auth] Pairing accepted. Session established.');
            this.latestQR = null;
        }

        if (connection === 'open') {
            this.clearConnectWatchdog();
            console.log('[WA:ready] Socket open. Session established.');
            this.isReady = true;
            this.isInitializing = false;
            this.latestQR = null;
            this.consecutiveInitFailures = 0;
            this.nextInitAllowedAt = 0;
            return;
        }

        if (connection === 'close') {
            this.onClose(sock, lastDisconnect);
        }
    }

    /**
     * Handles a close on the current socket. The socket is single-use: end() removes
     * its own listeners and destroys its emitter, and `closed` is latched, so a
     * closed socket can never reconnect. Every reconnect path therefore goes through
     * initialize() and makeWASocket — never sock.ws.connect().
     */
    private onClose(sock: WASocket, lastDisconnect: ConnectionState['lastDisconnect']): void {
        const statusCode = (lastDisconnect?.error as DisconnectError | undefined)?.output?.statusCode;
        const reason = lastDisconnect?.error?.message ?? 'unknown';
        const wasReady = this.isReady;
        const wasRegistered = this.wasRegistered;

        this.clearConnectWatchdog();
        this.isReady = false;
        this.isInitializing = false;
        this.latestQR = null;
        this.detachSocket(sock);
        this.sock = null;

        console.warn(`[WA:conn] Socket closed. statusCode=${statusCode ?? 'none'} reason=${reason}`);

        if (statusCode === WA_RESTART_REQUIRED) {
            // The normal, expected path right after a successful first pairing: the
            // preceding creds.update has been persisted and the server now asks for a
            // restart. Not a failure — no backoff rung, no delay, no alert. Routing
            // this through the transient branch would insert a 5s delay and burn a
            // rung on a success; routing it through the terminal branch would delete
            // the credentials the admin just created.
            console.log('[WA:conn] Restart required after pairing; reconnecting immediately.');
            void this.initialize({ force: true }).catch((err) =>
                console.error('[WA:conn] Restart-required reconnect failed:', err),
            );
            return;
        }

        if (statusCode !== undefined && SESSION_LOST_CODES.has(statusCode)) {
            // The session is gone. Wipe the credentials so the next socket issues a
            // fresh QR, and stand down: no auto-reconnect, and no recordInitFailure()
            // — a re-scan must not be rate-limited.
            this.clearAuthDir();
            if (this.intentionalLogout) {
                console.log('[WA:conn] Intentional admin logout — alert suppressed.');
            } else {
                // Involuntary logout: the phone unlinked the device, or WhatsApp
                // forced it. The bot cannot send until someone re-scans the QR.
                this.emitSessionLostAlert(String(statusCode));
            }
            this.intentionalLogout = false; // one-shot; consume it
            return;
        }

        if (statusCode === WA_CONNECTION_REPLACED) {
            // Another socket connected with the same credentials. The creds are valid
            // (the other session owns them), so do not wipe them, and do not
            // auto-reconnect: reconnecting would evict the other session, which would
            // reconnect and evict us — an unbounded ping-pong against WhatsApp.
            console.warn('[WA:conn] Connection replaced by another session; standing down.');
            this.emitSessionLostAlert('connection_replaced');
            return;
        }

        if (!wasRegistered) {
            // Nobody scanned the QR (Baileys ran out of QR refs and closed with 408),
            // or the network dropped before pairing. Nothing was lost, so no alert and
            // no failure. Release the socket and wait for a human: an admin tab left
            // open overnight must not hold a connection to WhatsApp forever.
            console.log('[WA:qr] No scan before the QR expired. Socket released; re-arm from the admin Reconnect button.');
            return;
        }

        // Transient: a registered session dropped (408, 428, 500, 503, unknown). It
        // self-heals, so no wa_session_lost — alerting here would page a human for
        // every WhatsApp server blip. The /api/health/whatsapp uptime check is the
        // detector for a transient that never heals.
        const backoffMs = this.recordInitFailure();
        console.warn(
            `[WA:conn] ${wasReady ? 'Session dropped' : 'Connect attempt failed'} (consecutive failure ${this.consecutiveInitFailures}; next attempt allowed in ${backoffMs}ms).`,
        );
        this.scheduleReconnect(backoffMs);
    }

    /** Cuts a socket loose from this service. Synchronous, never throws. */
    private detachSocket(sock: WASocket): void {
        // Belt and braces alongside the identity guard: end() removes connection.update
        // itself, but a socket discarded WITHOUT end() completing (a throw in
        // openSocket() after attach()) would otherwise keep listeners into `this`.
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
        } catch { /* a socket already ev.destroy()'d throws nothing useful */ }
    }

    /**
     * Synchronously discards the current socket. Never throws. Used by initialize()'s
     * catch and by the connect watchdog.
     */
    private teardownSocket(): void {
        const sock = this.sock;
        this.sock = null;
        this.isReady = false;
        this.latestQR = null;
        this.clearConnectWatchdog();
        if (sock) {
            this.detachSocket(sock);
            // sock.end takes `Error | undefined`, so undefined must be passed explicitly.
            void sock.end(undefined).catch(() => { /* already dead; nothing to reclaim */ });
        }
    }

    /**
     * Bounded, never-throwing socket shutdown. `graceful` → sock.logout() (tells
     * WhatsApp to unlink the device); otherwise sock.end() (drops the connection and
     * leaves the device linked).
     *
     * 5s: there is no browser to coax shut — sock.logout() is one iq write plus a
     * WebSocket close, and POST /api/admin/logout is awaited by a request that nginx
     * abandons at 62s. A call that settles after the race loses is absorbed by the
     * race's own handlers, so a late rejection cannot become an unhandledRejection —
     * no extra .catch() is needed.
     */
    private async endSocket(sock: WASocket, graceful: boolean): Promise<void> {
        const op = graceful ? () => sock.logout() : () => sock.end(undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                op(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`socket teardown timed out after ${SOCKET_END_TIMEOUT_MS}ms`)),
                        SOCKET_END_TIMEOUT_MS,
                    );
                }),
            ]);
        } catch (err) {
            console.warn('[WA:logout] Socket teardown did not complete cleanly:', err);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * Arms the connecting-phase watchdog for `sock` (see CONNECT_WATCHDOG_MS). An
     * unpaired socket that stalls does NOT auto-reconnect (nobody is waiting to
     * scan) and does not alert (nothing was lost) — it still burns a backoff rung so
     * a stuck admin tab cannot drive a loop.
     *
     * Covers the connecting phase only. A socket that reaches 'open' and then dies
     * silently is caught by Baileys' own keep-alive, which emits a 408 close.
     */
    private armConnectWatchdog(sock: WASocket): void {
        this.clearConnectWatchdog();
        this.connectWatchdog = setTimeout(() => {
            this.connectWatchdog = null;
            if (this.sock !== sock || this.isShuttingDown) return;
            console.error(`[WA:conn] Socket never reached 'open' within ${CONNECT_WATCHDOG_MS}ms. Treating as dead.`);
            const wasRegistered = this.wasRegistered;
            this.teardownSocket();
            this.isInitializing = false;
            const backoffMs = this.recordInitFailure();
            if (wasRegistered) {
                this.emitSessionLostAlert('connect_watchdog');
                this.scheduleReconnect(backoffMs);
            }
        }, CONNECT_WATCHDOG_MS);
        this.connectWatchdog.unref?.();
    }

    private clearConnectWatchdog(): void {
        if (this.connectWatchdog) {
            clearTimeout(this.connectWatchdog);
            this.connectWatchdog = null;
        }
    }

    /**
     * Arms the single auto-reconnect timer. `force: true` is deliberate: the timer IS
     * the backoff. Without it, the nextInitAllowedAt window recordInitFailure() just
     * opened would race the timer it scheduled, and a millisecond of skew turns a
     * reconnect into a silent no-op that nothing ever retries.
     *
     * clearReconnectTimer() here plus the same call at the top of initialize()
     * guarantee at most one armed timer — the anti-storm invariant.
     *
     * `.unref?.()`: a pending reconnect must not hold the Node event loop open during
     * a shutdown, and unref is absent on Jest's fake timer handles, hence the `?.`.
     */
    private scheduleReconnect(delayMs: number): void {
        if (this.isShuttingDown) return;
        this.clearReconnectTimer();
        console.log(`[WA:conn] Reconnecting in ${delayMs}ms.`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.initialize({ force: true }).catch((err) =>
                console.error('[WA:conn] Scheduled reconnect failed:', err),
            );
        }, delayMs);
        this.reconnectTimer.unref?.();
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /**
     * Advances the failure backoff ladder by one rung and returns the new gap in
     * ms. Shared by initialize() rejecting, by the connect watchdog, and by a
     * transient close — a socket that dies after a successful start is a failure
     * like any other; without this, connect, drop, reconnect runs completely
     * unrate-limited.
     */
    private recordInitFailure(): number {
        const i = Math.min(this.consecutiveInitFailures, INIT_BACKOFF_MS.length - 1);
        const backoffMs = INIT_BACKOFF_MS[i];
        this.nextInitAllowedAt = Date.now() + backoffMs;
        this.consecutiveInitFailures++;
        return backoffMs;
    }

    /**
     * Empties the auth directory so the next socket issues a fresh QR.
     *
     * Deletes the directory's CONTENTS, never the directory itself. In production
     * /app/.baileys_auth is a Docker bind mount, and rmSync on a mount point fails
     * with EBUSY on Linux, so a logout would silently leave the old credentials in
     * place and log nothing out. Emptying it is equivalent for our purposes:
     * useMultiFileAuthState falls back to initAuthCreds() whenever creds.json is
     * unreadable.
     *
     * Never throws — a logout that cannot clear the directory is still a logout, and
     * the socket is already gone.
     */
    private clearAuthDir(): void {
        try {
            if (!fs.existsSync(this.authDir)) return;
            for (const entry of fs.readdirSync(this.authDir)) {
                fs.rmSync(path.join(this.authDir, entry), { recursive: true, force: true });
            }
            console.log(`[WA:auth] Credentials cleared at ${this.authDir}.`);
        } catch (err) {
            console.error(`[WA:auth] Failed to clear credentials at ${this.authDir}:`, err);
        }
    }

    /**
     * Emits the stable, greppable alert line that a Cloud Logging metric watches.
     * The JSON carries the reason for humans reading the log; the metric only
     * needs the SESSION_LOST_EVENT token.
     */
    private emitSessionLostAlert(reason: string) {
        console.error(`[WA:alert] ${JSON.stringify({ event: SESSION_LOST_EVENT, reason })}`);
    }

    /** Whether the socket is open and able to send — the health signal. */
    public isConnected(): boolean {
        return this.isReady;
    }

    /**
     * Opens the Baileys socket: at most one attempt at a time, at most one per backoff
     * window.
     *
     * `force: true` skips the backoff window ONLY. It never starts a second
     * concurrent attempt — the isInitializing/isReady guard below is not bypassed, so
     * two Reconnect clicks in a second still open exactly one socket.
     *
     * One latch is sufficient: the guard is synchronous, and the only await before
     * `this.sock` is assigned is useMultiFileAuthState(). No event handler exists yet
     * during that await — there is no socket — so nothing can clear isInitializing
     * from inside the call.
     *
     * Resolving does NOT mean connected: openSocket() returns once the socket is
     * created, which for an unpaired session is before the QR is even issued.
     * isInitializing therefore stays set (no `finally` clears it) until 'open' / a
     * close / the connect watchdog clears it. That is what makes
     * getStatus().initializing truthful for the reconnect route.
     */
    public async initialize({ force = false }: { force?: boolean } = {}): Promise<void> {
        if (this.isShuttingDown) return;

        if (this.isInitializing || this.isReady) {
            console.log('[WA:init] Skipping initialize — already ' + (this.isReady ? 'connected' : 'connecting') + '.');
            return;
        }

        if (!force && Date.now() < this.nextInitAllowedAt) {
            // Silent on purpose: every send attempt while the socket is down lands
            // here, and a line per suppressed attempt is the noise backoff removes.
            return;
        }

        // A manual Reconnect supersedes any pending scheduled one.
        this.clearReconnectTimer();
        this.isInitializing = true;
        console.log('[WA:init] Opening Baileys socket...');

        try {
            await this.openSocket();
        } catch (err) {
            const backoffMs = this.recordInitFailure();
            console.error(
                `[WA:init] Socket initialization failed (consecutive failure ${this.consecutiveInitFailures}; next attempt allowed in ${backoffMs}ms):`,
                err,
            );
            this.teardownSocket();
            this.isInitializing = false;
        }
    }

    /** Non-mutating snapshot of the client lifecycle, for routes that must report. */
    public getStatus(): WhatsAppStatus {
        return {
            connected: this.isReady,
            hasQr: this.latestQR !== null,
            initializing: this.isInitializing,
            consecutiveInitFailures: this.consecutiveInitFailures,
            nextInitAllowedAt: this.nextInitAllowedAt,
        };
    }

    private setupGracefulShutdown() {
        const shutdown = async (signal: string) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            console.log(`[WA:shutdown] ${signal} received. Closing WhatsApp socket...`);

            this.clearReconnectTimer();
            this.clearConnectWatchdog();
            const sock = this.sock;
            this.sock = null;
            if (sock) {
                // Detach BEFORE ending so the resulting close event cannot re-enter and
                // schedule a reconnect on the way out (isShuttingDown is a second guard
                // on the same thing). end(), never logout(): a container restart must
                // not unlink the device.
                this.detachSocket(sock);
                await this.endSocket(sock, false);
            }

            console.log('[WA:shutdown] Socket closed. Exiting.');
            process.exit(0);
        };

        if (typeof process !== 'undefined') {
            process.on('SIGTERM', () => shutdown('SIGTERM'));
            process.on('SIGINT', () => shutdown('SIGINT'));
        }
    }

    /**
     * S2 stub: correct signature, no behaviour. Sending and delivery-ack tracking
     * arrive in S3, built on Baileys' messages.update. Returning false (never true)
     * means callers record whatsappSent = false rather than claiming a delivery that
     * did not happen.
     */
    public async sendMessage(chatId: string, message: string): Promise<boolean> {
        console.warn(
            `[WA:send] sendMessage() is not implemented until S3 — dropping ${message.length} chars for ${chatId}.`,
        );
        return false;
    }

    public async logout(): Promise<boolean> {
        console.log(`[WA:logout] Logout requested — isReady: ${this.isReady}`);

        // Mark this as intentional so the loggedOut close it triggers does not raise
        // the session-lost alert. The close consumes this flag.
        this.intentionalLogout = true;
        // A pending scheduled reconnect must never fire after an admin logout — the
        // forced re-init at the end of this method is the only thing that reopens a
        // socket.
        this.clearReconnectTimer();
        this.clearConnectWatchdog();

        const sock = this.sock;
        if (!sock && this.isInitializing) {
            // The in-flight openSocket() (suspended in useMultiFileAuthState) cannot be
            // cancelled; it will complete and assign this.sock later. Accepted, not
            // prevented — the socket it builds either reaches 'open' on the now-deleted
            // creds (the admin's next Logout catches it) or closes and is handled
            // normally.
            console.log('[WA:logout] A connection attempt was in flight; it will be superseded.');
        }

        if (sock) {
            // Bounded and never throws (see endSocket()). sock.logout() sends a
            // remove-companion-device iq and then ends the socket WITHOUT awaiting the
            // close, so this resolves before the loggedOut close fires. Both orderings
            // are handled: if the close lands first, intentionalLogout is still true
            // and the alert is suppressed; if it lands after the detach below, the
            // identity guard drops it.
            await this.endSocket(sock, this.isReady);
        }

        this.sock = null;
        if (sock) this.detachSocket(sock);

        this.isReady = false;
        this.isInitializing = false;
        this.latestQR = null;

        // Wipe credentials so the next socket issues a fresh QR.
        this.clearAuthDir();

        // An admin logout is not a failure, and must not leave the re-arm sitting
        // inside a 15-minute backoff window.
        this.consecutiveInitFailures = 0;
        this.nextInitAllowedAt = 0;

        // Belt-and-braces, deliberately placed AFTER the detach above: the loggedOut
        // close normally consumes this flag, but if sock.logout() threw or timed out,
        // that close may never fire. Resetting it any earlier would leave a window
        // where a late loggedOut-shaped close from the still-attached old socket reads
        // the flag as already false and raises a false alert. By here the old
        // listeners are gone, so it's safe.
        this.intentionalLogout = false;

        // Floating promise: initialize() can reject, and there is no process-wide
        // unhandledRejection handler — an unswallowed rejection here would crash the
        // whole server. It opens one socket against the now-empty auth dir, which
        // produces a fresh QR.
        void this.initialize({ force: true }).catch((err) => {
            console.error('[WA:logout] Re-arm after logout failed:', err);
        });
        return true;
    }
}

// Singleton pattern for Next.js
const isBuild = process.env.npm_lifecycle_event === 'build' || process.argv.includes('build');
const globalForWhatsApp = globalThis as unknown as { whatsappGlobal: WhatsAppService | undefined };

if (!globalForWhatsApp.whatsappGlobal && !isBuild) {
    globalForWhatsApp.whatsappGlobal = new WhatsAppService();
    // Initialize asynchronously without blocking exports
    globalForWhatsApp.whatsappGlobal.initialize().catch(err => {
        console.error('[WA:init] Failed to initialize WhatsApp service:', err);
    });
}

const whatsappService = globalForWhatsApp.whatsappGlobal!;

export { whatsappService };
