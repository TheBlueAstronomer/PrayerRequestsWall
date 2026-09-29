import fs from 'fs';
import path from 'path';

import { Client, LocalAuth } from 'whatsapp-web.js';

/**
 * Delivery acknowledgement levels reported by WhatsApp for an outgoing message.
 * Mirrors whatsapp-web.js's MessageAck enum. Declared locally rather than
 * imported so the values stay available even when the library is mocked.
 */
const ACK_ERROR = -1;
const ACK_PENDING = 0;
const ACK_SERVER = 1;

const DEFAULT_ACK_TIMEOUT_MS = 30000;
const MAX_EARLY_ACKS = 200;

/** How many unscanned QR codes to offer before giving up and releasing Chromium. */
const QR_MAX_RETRIES = Number(process.env.WA_QR_MAX_RETRIES) || 5;

/** Emitted by whatsapp-web.js as the disconnect reason once qrMaxRetries is hit. */
const MAX_QR_RETRIES_REASON = 'max qrcode retries';

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
 * the last value repeats. Before this existed, a failing client was relaunched
 * every 5s for as long as an admin page was open, leaking a Chromium per attempt.
 */
const INIT_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000];

/**
 * Ceiling on client.destroy() when discarding a dead client. destroy() drives a
 * browser that may already be wedged; unbounded, cleanup becomes the new hang.
 */
const DESTROY_TIMEOUT_MS = 15_000;

/**
 * Stable event token for "teardown of a discarded client's browser failed or timed
 * out". Mirrors SESSION_LOST_EVENT's contract — a Cloud Logging metric can match
 * this exact string — so a Chromium orphan is alertable as soon as cleanup starts
 * failing, rather than only once it shows up as memory pressure.
 */
const CLEANUP_FAILED_EVENT = 'wa_cleanup_failed';

/** Minimal shape of the Message returned by client.sendMessage(). */
type SentMessage = { id?: { _serialized?: string }; ack?: number };

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
    public client: Client;
    private isReady: boolean = false;
    public latestQR: string | null = null;
    private isShuttingDown: boolean = false;
    private isInitializing: boolean = false;

    /**
     * True for the exact span of one client.initialize() call. isInitializing is a
     * coarser "a browser is running" latch that AUTHENTICATION_FAILURE and
     * disconnected handlers can clear from *inside* that call (both are wired up
     * during inject(), which client.initialize() awaits) — if a Reconnect or
     * sendMessage() re-entered on that window, it would call client.initialize()
     * a second time on the same live Client. This flag is set only around the
     * await itself and cannot be cleared by an event handler, so the re-entry
     * window is fully closed regardless of what fires mid-launch.
     */
    private initInFlight: boolean = false;

    /**
     * The browser-crash watcher registered in initialize() (F1), plus the browser
     * it's attached to, so it can be explicitly detached. It lives on the
     * Puppeteer Browser EventEmitter, not the Client EventEmitter, so
     * dead.removeAllListeners() does NOT reach it on its own — every intentional
     * teardown must disarm this via disarmBrowserWatch() or the watcher survives
     * the discard and fires a false wa_session_lost on the next browser close (B1).
     * At most one is ever armed, matching every other piece of this-scoped client
     * state (isReady, latestQR, …) that tracks the current client only.
     */
    private browserWatch: { browser: NonNullable<Client['pupBrowser']>; handler: () => void } | null = null;

    /**
     * Set while an admin-initiated logout() is in flight, so the LOGOUT
     * `disconnected` event it causes is recognised as intentional and does NOT
     * raise the session-lost alert. Consumed (reset) by that event.
     */
    private intentionalLogout: boolean = false;

    /** Outgoing messages awaiting a server ack, keyed by serialized message id. */
    private pendingAcks: Map<string, (ack: number) => void> = new Map();

    /**
     * Acks that arrived before sendMessage() had registered its waiter. Bounded,
     * because an unbounded cache on a long-lived singleton is a slow memory leak.
     */
    private earlyAcks: Map<string, number> = new Map();

    private ackTimeoutMs: number = Number(process.env.WA_ACK_TIMEOUT_MS) || DEFAULT_ACK_TIMEOUT_MS;

    /** Consecutive failed initialize() attempts. Reset only by a successful launch. */
    private consecutiveInitFailures: number = 0;

    /** Epoch ms before which a non-forced initialize() is refused. 0 = no backoff. */
    private nextInitAllowedAt: number = 0;

    constructor() {
        console.log('[WA:init] Constructing WhatsAppService singleton...');

        this.client = this.createClient();

        this.setupGracefulShutdown();
    }

    private createClient(): Client {
        console.log('[WA:init] Creating new Client instance...');

        const client = new Client({
            authStrategy: new LocalAuth({
                dataPath: process.env.WA_DATA_PATH || './.wwebjs_auth',
            }),
            authTimeoutMs: 60000,
            // Finite on purpose. 0 means *unlimited* in whatsapp-web.js: an
            // unauthenticated client regenerates a QR every ~20s forever, and each
            // cycle keeps Chromium resident. Left unbounded this pins the CPU and
            // fills the disk. Give up instead, and re-arm on demand (see initialize()).
            qrMaxRetries: QR_MAX_RETRIES,
            puppeteer: {
                handleSIGINT: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ],
                protocolTimeout: 120000,
            },
        });

        client.on('qr', (qr) => {
            console.log(`[WA:qr] New QR code received (length: ${qr.length}). Awaiting scan.`);
            this.latestQR = qr;
        });

        client.on('ready', () => {
            console.log('[WA:ready] Client is ready. Session established.');
            this.isReady = true;
            this.latestQR = null;
            this.isInitializing = false;
        });

        client.on('authenticated', () => {
            console.log('[WA:auth] Authenticated successfully. Loading session...');
            this.latestQR = null;
        });

        client.on('auth_failure', (msg) => {
            console.error(`[WA:auth] Authentication failed: ${msg}`);
            this.isInitializing = false;
            // Auth failure is always involuntary — the session was rejected and a
            // human must re-scan. Alert regardless of the intentional-logout flag.
            this.emitSessionLostAlert(`auth_failure: ${msg}`);
        });

        client.on('disconnected', (reason) => {
            console.warn(`[WA:disconnect] Client disconnected. Reason: ${reason}. isReady reset to false.`);
            this.isReady = false;
            this.isInitializing = false;
            this.settleAllPendingAcks(ACK_PENDING);

            const isLogout = String(reason).toUpperCase().includes('LOGOUT');
            if (isLogout) {
                if (this.intentionalLogout) {
                    console.log('[WA:disconnect] Intentional admin logout — alert suppressed.');
                } else {
                    // Involuntary logout: the phone unlinked the device, or WhatsApp
                    // forced it. The bot cannot send until someone re-scans the QR.
                    this.emitSessionLostAlert(String(reason));
                }
                this.intentionalLogout = false; // one-shot; consume it
            }

            if (String(reason).toLowerCase().includes(MAX_QR_RETRIES_REASON)) {
                // whatsapp-web.js has destroyed the client and released Chromium.
                // Drop the expired QR and swap in a fresh, un-initialized client so
                // the next initialize() starts cleanly rather than reusing a corpse.
                console.warn(`[WA:qr] No scan after ${QR_MAX_RETRIES} QR codes. Released Chromium; will re-arm on the next initialize().`);
                this.latestQR = null;
                this.replaceClient();
            }
        });

        client.on('message_ack', (msg: unknown, ack: number) => {
            const id = (msg as SentMessage)?.id?._serialized;
            if (!id) return;

            // Intermediate acks (still queued) are not decisive — keep waiting.
            if (ack !== ACK_ERROR && ack < ACK_SERVER) return;

            const settle = this.pendingAcks.get(id);
            if (settle) {
                settle(ack);
                return;
            }

            // The ack beat sendMessage()'s waiter registration — hold it so the
            // waiter can pick it up instead of timing out on a delivered message.
            if (this.earlyAcks.size >= MAX_EARLY_ACKS) {
                const oldest = this.earlyAcks.keys().next().value;
                if (oldest !== undefined) this.earlyAcks.delete(oldest);
            }
            this.earlyAcks.set(id, ack);
        });

        return client;
    }

    /**
     * Resolves once WhatsApp reports a decisive acknowledgement for the message
     * (reached the server, or was rejected). Resolves with ACK_PENDING if no
     * decisive ack arrives before the timeout.
     */
    private waitForAck(messageId: string, timeoutMs: number): Promise<number> {
        const early = this.earlyAcks.get(messageId);
        if (early !== undefined) {
            this.earlyAcks.delete(messageId);
            return Promise.resolve(early);
        }

        return new Promise((resolve) => {
            const settle = (ack: number) => {
                clearTimeout(timer);
                this.pendingAcks.delete(messageId);
                resolve(ack);
            };

            const timer = setTimeout(() => settle(ACK_PENDING), timeoutMs);
            this.pendingAcks.set(messageId, settle);
        });
    }

    /** Cuts a client loose from every piece of shared service state. Synchronous. */
    private detachClient(dead: Client) {
        // Detach FIRST. destroy() can make the dying client emit 'disconnected',
        // and a LOGOUT-shaped reason from a client we are deliberately discarding
        // would raise a false wa_session_lost alert and page a human.
        dead.removeAllListeners();
        // removeAllListeners() above only reaches the Client EventEmitter — the
        // browser-crash watcher (F1) lives on a different one (B1). Unconditional:
        // the watch (if any) is always for the current client, never `dead`
        // specifically by this point (S1) — see disarmBrowserWatch()'s doc.
        this.disarmBrowserWatch();
        this.isReady = false;
        this.latestQR = null;
        // A send waiting on an ack from a browser that is going away must fail now,
        // not in 30s. settleAllPendingAcks also clears earlyAcks.
        this.settleAllPendingAcks(ACK_PENDING);
    }

    /**
     * Detaches the browser-crash watcher (see the `browserWatch` field), if one is
     * armed, and nulls the field. Safe to call unconditionally — a no-op when
     * nothing is armed.
     *
     * Deliberately takes no `dead` client to compare against: the watch is only
     * ever armed for `this.client`'s current browser (there is at most one), so an
     * identity check against a specific client is unnecessary and was actively
     * wrong (S1) — a plain 'disconnected' or auth_failure can clear isInitializing
     * without replacing the client, and the next initialize() then overwrites
     * `browserWatch` with a new {browser, handler} pair while the *old* one either
     * never got disarmed (nothing compared equal) or, worse, gets silently
     * abandoned still-armed on the old browser. Unconditional disarm avoids both.
     */
    private disarmBrowserWatch() {
        if (!this.browserWatch) return;
        // Real puppeteer.Browser has .off(); guard it anyway — the handler's own
        // `this.client !== watchedClient` check is the actual backstop if a stub
        // browser (or a real one mid-teardown) doesn't.
        this.browserWatch.browser.off?.('disconnected', this.browserWatch.handler);
        this.browserWatch = null;
    }

    /**
     * Advances the failure backoff ladder by one rung and returns the new gap in
     * ms. Shared by client.initialize() rejecting (in the catch below) and by the
     * post-launch browser-crash watcher (S3) — a browser that dies after a
     * successful launch is a failure like any other; without this, launch ->
     * crash -> relaunch runs completely unrate-limited, which is exactly the
     * crash loop docker-compose.prod.yml's mem_limit can trigger.
     */
    private recordInitFailure(): number {
        const i = Math.min(this.consecutiveInitFailures, INIT_BACKOFF_MS.length - 1);
        const backoffMs = INIT_BACKOFF_MS[i];
        this.nextInitAllowedAt = Date.now() + backoffMs;
        this.consecutiveInitFailures++;
        return backoffMs;
    }

    /**
     * Bounds a call that drives a puppeteer page/browser which may already be
     * wedged — an unbounded await on one becomes the new hang. Never throws and
     * never hangs past DESTROY_TIMEOUT_MS. A call that settles after the race
     * loses is absorbed by the race's own handlers, so a late rejection cannot
     * become an unhandledRejection — no extra .catch() is needed.
     *
     * Shared by destroyClient() (client.destroy() on a browser we're discarding)
     * and logout()'s client.logout() call: logout() is, since round 5, the
     * primary control an admin has for clearing a wedged/stuck-initializing
     * client (the disconnected-branch Logout button), so it is exactly the path
     * most likely to hit a browser that is already unresponsive. Unbounded,
     * client.logout()'s pupPage.evaluate() can block for the full
     * protocolTimeout (120s) — well past nginx's 62s proxy_read_timeout, turning
     * "recover the wedge" into a 504 with the recovery attempt still silently
     * running behind it (round 6).
     */
    private async withTeardownTimeout(label: string, op: () => Promise<unknown>): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                op(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`${label} timed out after ${DESTROY_TIMEOUT_MS}ms`)),
                        DESTROY_TIMEOUT_MS,
                    );
                }),
            ]);
        } catch (err) {
            console.error(`[WA:cleanup] ${JSON.stringify({ event: CLEANUP_FAILED_EVENT, reason: String(err) })}`);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * Best-effort browser teardown for a client we are throwing away. Never
     * throws and never hangs (see withTeardownTimeout()).
     *
     * If the timeout wins, the orphan still holds the profile lock, so the next
     * initialize() fails fast with "browser is already running" and is absorbed by
     * the backoff. Bounded, not a relaunch loop.
     */
    private async destroyClient(client: Client): Promise<void> {
        return this.withTeardownTimeout('destroy()', () => client.destroy());
    }

    /**
     * Swaps in a fresh client, detaching the outgoing one's listeners first.
     *
     * Every handler registered in createClient() closes over `this`, so a client
     * that is replaced without being unsubscribed keeps mutating shared service
     * state long after it is supposed to be dead. In production that meant a
     * replaced client carried on emitting 'qr' into this.latestQR alongside its
     * replacement — two QR codes, milliseconds apart, overwriting each other —
     * so the QR shown in the admin UI was frequently the dead client's, and
     * scanning it did nothing. A late 'disconnected' from the old client could
     * also clear isReady on a perfectly healthy new session.
     */
    private replaceClient() {
        const dead = this.client;
        this.detachClient(dead);
        // Swap synchronously: this runs from sync event handlers, so this.client
        // must never be observable as a corpse.
        this.client = this.createClient();
        // Unconditional orphan cleanup (A-FIX-2/A3). Fire-and-forget, and safe on
        // paths where whatsapp-web.js already destroyed the client: destroy() is
        // `if (browser?.isConnected()) close()` in 1.34.6 — a quiet no-op.
        void this.destroyClient(dead);
    }

    /**
     * Awaitable variant for the initialize() failure path: the old browser must be
     * gone *before* the next attempt, or Chromium refuses the profile with
     * "The browser is already running for <userDataDir>".
     */
    private async discardBrowser(): Promise<void> {
        const dead = this.client;
        this.detachClient(dead);
        await this.destroyClient(dead);
        this.client = this.createClient();
    }

    /** Releases every in-flight ack wait, e.g. when the client dies mid-send. */
    private settleAllPendingAcks(ack: number) {
        for (const settle of [...this.pendingAcks.values()]) {
            settle(ack);
        }
        this.pendingAcks.clear();
        this.earlyAcks.clear();
    }

    /**
     * Emits the stable, greppable alert line that a Cloud Logging metric watches.
     * The JSON carries the reason for humans reading the log; the metric only
     * needs the SESSION_LOST_EVENT token.
     */
    private emitSessionLostAlert(reason: string) {
        console.error(`[WA:alert] ${JSON.stringify({ event: SESSION_LOST_EVENT, reason })}`);
    }

    /** Whether the client is connected and able to send — the health signal. */
    public isConnected(): boolean {
        return this.isReady;
    }

    private getLockFilePath(): string {
        const dataPath = process.env.WA_DATA_PATH || './.wwebjs_auth';
        return path.join(dataPath, 'session', 'SingletonLock');
    }

    private clearStaleLock() {
        const lockFile = this.getLockFilePath();
        if (fs.existsSync(lockFile)) {
            console.warn(`[WA:lock] Stale SingletonLock detected at ${lockFile}. Removing...`);
            fs.rmSync(lockFile);
            console.log('[WA:lock] Stale lock removed.');
        } else {
            console.log('[WA:lock] No stale lock found. Proceeding.');
        }
    }

    private waitForLockRelease(timeoutMs = 10000): Promise<void> {
        const lockFile = this.getLockFilePath();
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                if (!fs.existsSync(lockFile)) {
                    console.log(`[WA:lock] Lock released after ${Date.now() - start}ms.`);
                    return resolve();
                }
                if (Date.now() - start > timeoutMs) {
                    console.warn(`[WA:lock] Lock not released after ${timeoutMs}ms timeout. Removing forcefully...`);
                    try { fs.rmSync(lockFile); } catch { }
                    return resolve();
                }
                setTimeout(check, 200);
            };
            check();
        });
    }

    /**
     * Launches the client: at most one attempt at a time, at most one per backoff
     * window.
     *
     * `force: true` skips the backoff window ONLY. It never starts a second
     * concurrent attempt — two overlapping client.initialize() calls launch two
     * Chromiums against one profile, which is the failure this fix exists to remove.
     * That guarantee rests on `initInFlight`, not `isInitializing`: AUTHENTICATION_
     * FAILURE and the AppState-changed disconnect route are wired up during
     * inject(), which client.initialize() awaits, so both can clear isInitializing
     * from *inside* this call, before it resolves. `initInFlight` is set only
     * around the awaited call itself and no event handler can clear it, so a
     * concurrent Reconnect/sendMessage() re-entering mid-launch is refused
     * regardless of what the browser does while injecting.
     *
     * Resolving does NOT mean connected: whatsapp-web.js resolves initialize() once
     * the page is injected, which for an unpaired session is while the QR is on
     * screen and the browser is very much alive. isInitializing therefore stays set
     * until 'ready' / 'disconnected' / 'auth_failure' clears it. It is an
     * "a browser is running" latch, not an "a call is in flight" latch.
     */
    public async initialize({ force = false }: { force?: boolean } = {}): Promise<void> {
        if (this.isShuttingDown) return;

        if (this.initInFlight || this.isInitializing || this.isReady) {
            console.log(`[WA:init] Skipping initialize — already ${this.isReady ? 'ready' : 'initializing'}.`);
            return;
        }

        if (!force && Date.now() < this.nextInitAllowedAt) {
            // Silent on purpose: every send attempt while the client is down lands
            // here, and a line per suppressed attempt is the noise backoff removes.
            return;
        }

        this.isInitializing = true;
        this.initInFlight = true;
        console.log('[WA:init] Starting client initialization...');

        try {
            // Disarm whatever crash watch is still armed BEFORE the launch, not
            // after: an involuntary LOGOUT via Client.js's framenavigated route
            // clears isReady/isInitializing WITHOUT destroying the browser or
            // replacing the Client, so the watch from the previous successful
            // launch stays armed on that still-live browser. If this attempt
            // relaunches on the same Client and that old browser dies mid-launch,
            // a disarm still sitting after the await would be too late — the
            // stale handler already fired (this.client === watchedClient the
            // whole time, since nothing replaced it) for a duplicate alert, an
            // extra backoff rung, and isInitializing cleared mid-launch. Disarming
            // here is a no-op whenever nothing is armed.
            this.disarmBrowserWatch();

            // Inside the try: an fs failure here is a real init failure and should
            // be counted and backed off, not thrown at the caller.
            this.clearStaleLock();
            // Capture BEFORE the await, not just for the call itself: a concurrent
            // logout() can swap this.client out from under us while we're
            // suspended here (round 6 finding — e.g. admin clicks Reconnect, then
            // Logout within a second or two, before this client's browser is even
            // assigned). Everything below that needs "the client we actually
            // launched" must use this captured reference, not a fresh this.client
            // read, or it ends up asserting state against — and arming a watch on
            // — an unrelated, never-launched replacement client instead.
            const client = this.client;
            await client.initialize();
            this.consecutiveInitFailures = 0;
            this.nextInitAllowedAt = 0;
            // isInitializing intentionally left set — see the doc comment above.
            // Defensive re-assert, guarded by `this.client === client`: without
            // that guard, a concurrent logout() (see the capture comment above)
            // would have this line latch isInitializing against a fresh,
            // never-launched replacement client — a permanent wedge, since
            // nothing else would ever clear it for that client.
            if (!this.isReady && this.client === client) this.isInitializing = true;

            // whatsapp-web.js registers no listener on the underlying Puppeteer
            // browser process itself — its DISCONNECTED emit sites are all in-page
            // events that cannot fire when the browser process is killed outright
            // (e.g. OOM-killed by the memory cap in docker-compose.prod.yml).
            // Without this, isReady stays latched true forever: health checks stay
            // green, the admin UI hides Reconnect, and sendMessage() never re-arms
            // — a loud outage becomes a silent one.
            //
            // Note: this only covers the *browser process* dying outright. A
            // renderer-only OOM-kill leaves pupBrowser connected — Puppeteer's
            // 'disconnected' never fires — so isReady stays latched true in that
            // narrower case too. Not covered here; see the PR body.
            const watchedClient = client;
            const browser = watchedClient.pupBrowser;
            if (browser) {
                const handler = () => {
                    // A browser we discarded/replaced on purpose, or shutdown
                    // tearing down its own client, is not an alertable session
                    // loss. Every intentional teardown disarms this explicitly
                    // (B1); this check is the backstop for anything that fires
                    // before the disarm lands.
                    if (this.client !== watchedClient || this.isShuttingDown) return;
                    // Not always a crash: Client.js's AppState-changed route can
                    // reach here on a CONFLICT/UNPAIRED with the browser otherwise
                    // fine, alongside genuine process death (OOM-kill, segfault).
                    console.warn('[WA:browser] Puppeteer browser disconnected.');
                    this.isReady = false;
                    this.isInitializing = false;
                    // Explicit off(), not just nulling the field: makes the
                    // one-shot property a fact about this handler rather than
                    // something only true because Browser happens to emit
                    // 'disconnected' once (verified, but incidental to rely on).
                    browser.off('disconnected', handler);
                    this.browserWatch = null;
                    const backoffMs = this.recordInitFailure();
                    console.warn(
                        `[WA:browser] Treating as init failure ${this.consecutiveInitFailures}; next attempt allowed in ${backoffMs}ms.`,
                    );
                    this.emitSessionLostAlert('browser_disconnected');
                };
                // `on`, not `once`: Puppeteer's once() stores an internal wrapper
                // as the actual listener, so a later off(handler) can't find it —
                // handlers.lastIndexOf(handler) is -1 and nothing is removed
                // (verified against puppeteer-core's EventEmitter). The handler is
                // already effectively one-shot: it nulls browserWatch itself, and
                // a given Browser instance only ever emits 'disconnected' once.
                browser.on('disconnected', handler);
                this.browserWatch = { browser, handler };
            }
        } catch (err) {
            // Hold the guard closed across cleanup: an event handler may already
            // have cleared it (including the browser-crash handler above, which
            // clears isInitializing mid-teardown on a live browser death) — any
            // initialize() slipping in during the awaited teardown below would
            // run against the client we are about to destroy. Re-entry stays
            // refused regardless, via initInFlight rather than this flag.
            this.isInitializing = true;

            const backoffMs = this.recordInitFailure();
            console.error(
                `[WA:init] Client initialization failed (consecutive failure ${this.consecutiveInitFailures}; next attempt allowed in ${backoffMs}ms):`,
                err,
            );

            // discardBrowser()'s client swap runs outside any try of its own; if
            // it throws, isInitializing must still clear or the service is wedged
            // permanently (S2) — a container restart would be the only way out.
            try {
                await this.discardBrowser();
            } finally {
                this.isInitializing = false;
            }
        } finally {
            this.initInFlight = false;
        }
    }

    /** Non-mutating snapshot of the client lifecycle, for routes that must report. */
    public getStatus(): WhatsAppStatus {
        return {
            connected: this.isReady,
            hasQr: this.latestQR !== null,
            // initInFlight closes a narrower window than isInitializing (see its
            // field doc) but a caller asking "is a launch in progress?" needs
            // both — otherwise the reconnect route can report 202 "starting" for
            // a call that immediately no-ops at the initInFlight guard.
            initializing: this.isInitializing || this.initInFlight,
            consecutiveInitFailures: this.consecutiveInitFailures,
            nextInitAllowedAt: this.nextInitAllowedAt,
        };
    }

    private setupGracefulShutdown() {
        const shutdown = async (signal: string) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            console.log(`[WA:shutdown] ${signal} received. Destroying client gracefully...`);

            const client = this.client; // a concurrent discardBrowser() may replace this.client
            try {
                await client.destroy();
                console.log('[WA:shutdown] Client destroyed. Exiting.');
            } catch (err) {
                console.error('[WA:shutdown] Error during client destroy:', err);
            }

            process.exit(0);
        };

        if (typeof process !== 'undefined') {
            process.on('SIGTERM', () => shutdown('SIGTERM'));
            process.on('SIGINT', () => shutdown('SIGINT'));
        }
    }

    public async sendMessage(chatId: string, message: string): Promise<boolean> {
        console.log(`[WA:send] sendMessage called — isReady: ${this.isReady}, isInitializing: ${this.isInitializing}, chatId: ${chatId}`);
        if (!this.isReady) {
            console.warn('[WA:send] Client not ready. Message will not be sent.');
            if (!this.isInitializing) {
                console.log('[WA:send] Triggering re-initialization...');
                // Floating promise: initialize() can reject (discardBrowser()'s
                // this.client = this.createClient() runs outside any try), and
                // there is no process-wide unhandledRejection handler — an
                // unswallowed rejection here would crash the whole server.
                this.initialize().catch((err) => {
                    console.error('[WA:send] Re-initialization failed:', err);
                });
            }
            return false;
        }

        try {
            // sendMessage() resolving only means WhatsApp Web accepted the message
            // into its outbound queue — not that WhatsApp delivered it. A wrong chat
            // id, or an account that is no longer in the group, resolves here and is
            // then dropped server-side. Wait for the ack before reporting success.
            const sent = await this.client.sendMessage(chatId, message) as SentMessage | undefined;

            if (typeof sent?.ack === 'number' && sent.ack >= ACK_SERVER) {
                console.log(`[WA:send] Message delivered to ${chatId} (ack: ${sent.ack}).`);
                return true;
            }

            const messageId = sent?.id?._serialized;
            if (!messageId) {
                console.error(`[WA:send] No message id returned for ${chatId}; cannot confirm delivery.`);
                return false;
            }

            const ack = await this.waitForAck(messageId, this.ackTimeoutMs);

            if (ack >= ACK_SERVER) {
                console.log(`[WA:send] Message delivered to ${chatId} (ack: ${ack}).`);
                return true;
            }

            if (ack === ACK_ERROR) {
                console.error(`[WA:send] WhatsApp rejected the message to ${chatId} (ack: ${ack}). Check the chat id is valid and the account is a participant.`);
            } else {
                console.error(`[WA:send] No delivery ack from WhatsApp for ${chatId} within ${this.ackTimeoutMs}ms. Treating as not sent.`);
            }
            return false;
        } catch (error) {
            console.error(`[WA:send] Failed to send message to ${chatId}:`, error);
            return false;
        }
    }

    public async logout(): Promise<boolean> {
        console.log(`[WA:logout] Logout requested — isReady: ${this.isReady}`);

        // Mark this as intentional so the LOGOUT `disconnected` event it triggers
        // does not raise the session-lost alert. The event consumes this flag.
        this.intentionalLogout = true;
        // The browser-crash watcher (F1) lives on the Puppeteer Browser, not the
        // Client, so it survives both client.logout() and client.destroy() below
        // — either can close the browser and fire 'disconnected' on it, and at
        // that point this.client hasn't been swapped yet (replaceClient() is far
        // below), so the watcher's own guard hasn't engaged either. Disarm up
        // front, before either call can trigger it (B1).
        this.disarmBrowserWatch();

        if (this.isReady) {
            // Bounded (round 6 finding 2): an unbounded client.logout() against a
            // wedged page is the exact "cleanup becomes the new hang" scenario
            // DESTROY_TIMEOUT_MS exists to prevent — see withTeardownTimeout()'s
            // doc comment. Never throws, so no try/catch needed here any more.
            await this.withTeardownTimeout('logout()', () => this.client.logout());
            console.log('[WA:logout] logout() attempt complete.');
        } else {
            console.log('[WA:logout] Client not in ready state — skipping logout() call, proceeding to destroy.');
        }

        // Same bounded, never-throwing teardown every other discard path uses
        // (replaceClient()/discardBrowser()) — an unbounded destroy() here would
        // undo the whole point of giving the admin a Logout button as a wedge
        // escape hatch (round 6 finding 2).
        await this.destroyClient(this.client);
        console.log('[WA:logout] destroy() attempt complete.');

        this.isReady = false;
        this.latestQR = null;
        this.isInitializing = false;
        this.settleAllPendingAcks(ACK_PENDING);

        console.log('[WA:logout] Waiting for Chromium to release browser lock...');
        await this.waitForLockRelease();

        console.log('[WA:logout] Re-creating client for new session...');
        this.replaceClient();
        // Belt-and-braces, deliberately placed AFTER replaceClient(): the LOGOUT
        // `disconnected` event normally consumes this flag (line ~167), but if
        // client.logout() threw above, that event may never fire. Resetting it
        // any earlier — e.g. right after destroy(), ~10s before replaceClient()
        // detaches the old client's listeners via waitForLockRelease() — would
        // leave a window where a late LOGOUT-shaped disconnect from the
        // still-attached old client reads the flag as already false and raises a
        // false alert. By here the old listeners are gone, so it's safe.
        this.intentionalLogout = false;
        // Floating promise: see the comment on the sendMessage() re-arm call —
        // a rejection here must not be allowed to reach the process as unhandled.
        // Does not check initInFlight first: if a launch is already running (e.g.
        // an admin hit Logout from the disconnected/wedged branch while an earlier
        // Reconnect was still mid-launch on the client this logout() just replaced
        // via replaceClient()), initialize() itself no-ops at its own guard rather
        // than erroring. NOT fully self-healing in that case, though: the
        // still-running launch resumes later holding its own captured client
        // reference (see initialize()'s `client` capture comment), not
        // this.client — which by then is this logout()'s fresh replacement. Its
        // own state updates are guarded so they can't corrupt the replacement's
        // state, but the browser that launch produces is left unreferenced by
        // anything this.client points to: an orphaned Chromium, cleared only by
        // a container restart. A second Reconnect click on the (correct) new
        // client works normally; it just doesn't retroactively adopt the first.
        this.initialize({ force: true }).catch((err) => {
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
