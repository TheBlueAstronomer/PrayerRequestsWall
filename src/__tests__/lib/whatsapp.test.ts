/**
 * WhatsAppService lifecycle tests (S2: connection and pairing on Baileys).
 *
 * Strategy: every test loads a fresh copy of the module with jest.isolateModulesAsync so
 * the globalThis.whatsappGlobal singleton is reset. Baileys, pino, fs and path are mocked;
 * the Baileys mock records every socket it hands out together with its own listener table
 * so a test can fire events at a specific socket, including one the service has already
 * let go of.
 *
 * Spec edge-case coverage (section numbers refer to s2-spec.md):
 *   3.1   logged-out vs transient close ........ describe 'spec 3.1'
 *   3.2   QR expiry and re-issue ............... describe 'spec 3.2'
 *   3.3   reconnect storms ..................... describe 'spec 3.3'
 *   3.4   concurrent initialize() .............. describe 'spec 3.4'
 *   3.5   logout racing a reconnect (A, B, C) .. describe 'spec 3.5'
 *   3.6   restart with existing creds .......... describe 'spec 3.6'
 *   3.7   restart with corrupt/partial creds ... describe 'spec 3.7'
 *   3.8   socket death without a close event ... describe 'spec 3.8'
 *   3.9   restartRequired (515) ................ describe 'spec 3.9'
 *   3.10  connectionReplaced (440) ............. describe 'spec 3.10'
 *   3.11  close from a superseded socket ....... describe 'spec 3.11'
 *   3.12  shutdown mid-connect ................. describe 'spec 3.12'
 *
 * Deliberately NOT asserted anywhere: the shape or length of a QR payload. Baileys' QR is a
 * URL today and its format is not a contract (spec 3.2). Tests only round-trip an opaque
 * string they invented.
 *
 * Harness rules learned the hard way:
 *  - jest.useFakeTimers() runs BEFORE the module loads (Jest 30 fakes Date.now(), which the
 *    backoff ladder reads).
 *  - jest.getTimerCount() includes the 90 s connect watchdog while a socket is connecting, so
 *    reconnect-timer counts are only asserted after an 'open' or a 'close' has cleared it.
 *  - After anything that re-enters initialize(), microtasks are flushed before asserting on
 *    makeWASocket, because openSocket() has two awaits.
 */

import type { WhatsAppStatus } from '@/lib/whatsapp';

// --- Constants mirrored from the spec (kept independent of the implementation on purpose) ---

const WATCHDOG_MS = 90_000;
const SOCKET_END_TIMEOUT_MS = 5_000;
const LADDER_MS = [5_000, 15_000, 60_000, 300_000, 900_000];
const DEFAULT_AUTH_DIR = '/app/.baileys_auth';
/** Raw-frame event carrying the server's ack of one of our outbound messages (S3). */
const WA_ACK_EVENT = 'CB:ack,class:message';

// --- Mock plumbing ---

type Handler = (arg: unknown) => void;
type Registry = Record<string, Handler[]>;

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
}

function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** The `sock.ws` emitter Baileys exposes; the service registers its server-ack listener here. */
interface MockWs {
    on: (evt: string, h: Handler) => void;
    /** Actually removes (matched by identity), so a leak test can prove detachment. */
    off: jest.Mock;
    removeAllListeners: jest.Mock;
}

interface MockSocket {
    /** The object handed to the service. */
    sock: {
        ev: {
            on: (evt: string, h: Handler) => void;
            off: jest.Mock;
            removeAllListeners: jest.Mock;
        };
        ws: MockWs;
        end: jest.Mock;
        logout: jest.Mock;
        sendMessage: jest.Mock;
        user: undefined;
    };
    /** Live listener table. Pruned by removeAllListeners(), like the real emitter. */
    handlers: Registry;
    /**
     * Every listener ever registered on this socket, never pruned. Lets a test deliver an
     * event the way an already-queued one would arrive after the service has detached from
     * the socket, which is what the `this.sock !== sock` identity guard exists to survive.
     */
    everRegistered: Registry;
    /** Live listener table of `sock.ws`. Pruned by off() and removeAllListeners(). */
    wsHandlers: Registry;
    /** Every listener ever registered on `sock.ws`, never pruned: the detached-socket delivery path. */
    wsEverRegistered: Registry;
    end: jest.Mock;
    logout: jest.Mock;
}

interface MockState {
    sockets: MockSocket[];
    makeOptions: Array<Record<string, unknown>>;
    /** One entry is consumed per useMultiFileAuthState() call: an Error rejects, a Deferred parks the call. */
    authPlan: Array<Error | Deferred>;
    /** One entry is consumed per makeWASocket() call: an Error is thrown. */
    makePlan: (Error | null)[];
    evOnThrows: boolean;
    /** In-memory stand-in for the auth directory's contents. creds.json present means "registered". */
    authFiles: Set<string>;
    authStates: Array<{ creds: { registered: boolean }; keys: Record<string, unknown> }>;
    /** One saveCreds mock per useMultiFileAuthState() call, so a crossed pair is detectable. */
    saveCreds: jest.Mock[];
    sockEnd: jest.Mock;
    sockLogout: jest.Mock;
    sockSend: jest.Mock;
    fsExists: jest.Mock;
    fsReaddir: jest.Mock;
    fsRm: jest.Mock;
    pino: jest.Mock;
    logger: Record<string, unknown>;
    useAuthState: jest.Mock;
    makeWASocket: jest.Mock;
}

interface LoadOptions {
    /** Default true: a box restarting with a populated auth dir is the production norm. */
    registered?: boolean;
    authPlan?: Array<Error | Deferred>;
    makePlan?: (Error | null)[];
    evOnThrows?: boolean;
    env?: Record<string, string>;
    lifecycle?: string;
}

type Svc = {
    latestQR: string | null;
    isConnected: () => boolean;
    initialize: (opts?: { force?: boolean }) => Promise<void>;
    getStatus: () => WhatsAppStatus;
    sendMessage: (chatId: string, message: string) => Promise<boolean>;
    logout: () => Promise<boolean>;
};

const join = (...parts: string[]) => parts.join('/');

function createMockState(opts: LoadOptions): MockState {
    const state: MockState = {
        sockets: [],
        makeOptions: [],
        authPlan: [...(opts.authPlan ?? [])],
        makePlan: [...(opts.makePlan ?? [])],
        evOnThrows: !!opts.evOnThrows,
        authFiles: new Set(opts.registered === false ? [] : ['creds.json', 'app-state-sync-key-1.json']),
        authStates: [],
        saveCreds: [],
        sockEnd: jest.fn().mockResolvedValue(undefined),
        sockLogout: jest.fn().mockResolvedValue(undefined),
        // Default resolves with NO message key, which exercises spec 3.14. S3 tests that expect
        // a real send set mockResolvedValue({ key: { id, remoteJid, fromMe: true } }) themselves.
        sockSend: jest.fn().mockResolvedValue(undefined),
        fsExists: jest.fn(() => true),
        fsReaddir: jest.fn(() => [...state.authFiles]),
        fsRm: jest.fn((p: string) => {
            state.authFiles.delete(p.slice(p.lastIndexOf('/') + 1));
        }),
        logger: {},
        pino: jest.fn(() => state.logger),
        useAuthState: jest.fn(async () => {
            // Snapshot at call entry: the auth state is read BEFORE any await, exactly the
            // "built on the pre-wipe auth state" hazard of spec 3.5 trigger B.
            const registered = state.authFiles.has('creds.json');
            const step = state.authPlan.shift();
            if (step instanceof Error) throw step;
            if (step) await step.promise;
            const authState = { creds: { registered }, keys: {} };
            const saveCreds = jest.fn().mockResolvedValue(undefined);
            state.authStates.push(authState);
            state.saveCreds.push(saveCreds);
            return { state: authState, saveCreds };
        }),
        makeWASocket: jest.fn((options: Record<string, unknown>) => {
            const failure = state.makePlan.shift();
            if (failure) throw failure;
            state.makeOptions.push(options);
            const handlers: Registry = {};
            const everRegistered: Registry = {};
            const wsHandlers: Registry = {};
            const wsEverRegistered: Registry = {};
            const end = jest.fn((e?: unknown) => state.sockEnd(e));
            const logout = jest.fn(() => state.sockLogout());
            const sock = {
                ev: {
                    on: (evt: string, h: Handler) => {
                        if (state.evOnThrows) throw new Error('listener registry exploded');
                        (handlers[evt] ||= []).push(h);
                        (everRegistered[evt] ||= []).push(h);
                    },
                    off: jest.fn(),
                    removeAllListeners: jest.fn((evt: string) => {
                        delete handlers[evt];
                    }),
                },
                ws: {
                    on: (evt: string, h: Handler) => {
                        (wsHandlers[evt] ||= []).push(h);
                        (wsEverRegistered[evt] ||= []).push(h);
                    },
                    off: jest.fn((evt: string, h: Handler) => {
                        const live = wsHandlers[evt];
                        if (!live) return;
                        const at = live.indexOf(h);
                        if (at >= 0) live.splice(at, 1);
                        if (live.length === 0) delete wsHandlers[evt];
                    }),
                    removeAllListeners: jest.fn((evt: string) => {
                        delete wsHandlers[evt];
                    }),
                },
                end,
                logout,
                sendMessage: state.sockSend,
                user: undefined,
            };
            state.sockets.push({ sock, handlers, everRegistered, wsHandlers, wsEverRegistered, end, logout });
            return sock;
        }),
    };
    state.logger = {
        level: 'silent',
        child: () => state.logger,
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
    };
    return state;
}

/** Drains pending microtasks (fake timers do not advance promises on their own). */
async function flush(times = 20) {
    for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Advances fake time, then lets any timer-triggered initialize() finish its awaits. */
async function advance(ms: number) {
    jest.advanceTimersByTime(ms);
    await flush();
}

let currentState: MockState;

async function loadService(opts: LoadOptions = {}): Promise<{ svc: Svc; state: MockState }> {
    const state = createMockState(opts);

    delete (globalThis as Record<string, unknown>).whatsappGlobal;
    delete process.env.npm_lifecycle_event;
    delete process.env.WA_AUTH_PATH;
    delete process.env.WA_DATA_PATH;
    delete process.env.WA_LOG_LEVEL;
    for (const [key, value] of Object.entries(opts.env ?? {})) process.env[key] = value;
    if (opts.lifecycle) process.env.npm_lifecycle_event = opts.lifecycle;

    let svc: Svc | undefined;
    await jest.isolateModulesAsync(async () => {
        // The factory delegates through `currentState` instead of closing over `state`.
        // openSocket() imports Baileys lazily, so on a reconnect that import runs AFTER this
        // isolation scope has ended, and Jest then serves (and caches, in its main mock
        // registry) whichever factory result it sees first. A closure over one test's state
        // would go stale and silently feed every later test the wrong sockets.
        currentState = state;
        jest.doMock('@whiskeysockets/baileys', () => ({
            makeWASocket: (options: Record<string, unknown>) => currentState.makeWASocket(options),
            useMultiFileAuthState: (dir: string) => currentState.useAuthState(dir),
        }));
        jest.doMock('pino', () => ({ __esModule: true, default: state.pino }));
        const fsMock = { existsSync: state.fsExists, readdirSync: state.fsReaddir, rmSync: state.fsRm };
        jest.doMock('fs', () => ({ __esModule: true, default: fsMock, ...fsMock }));
        jest.doMock('path', () => ({ __esModule: true, default: { join }, join }));

        const mod = await import('@/lib/whatsapp');
        svc = mod.whatsappService as unknown as Svc;
    });

    // Let the singleton's fire-and-forget bootstrap initialize() run to its first suspension.
    await flush();
    return { svc: svc as Svc, state };
}

const loadPaired = (opts: LoadOptions = {}) => loadService({ ...opts, registered: true });
const loadUnpaired = (opts: LoadOptions = {}) => loadService({ ...opts, registered: false });

// --- Event helpers ---

/** Fires an event at a socket's LIVE listeners. Throws if nothing is listening (a test bug). */
function emit(state: MockState, index: number, evt: string, payload: unknown): void {
    const live = [...(state.sockets[index].handlers[evt] ?? [])];
    if (live.length === 0) throw new Error(`test bug: socket ${index} has no live '${evt}' listener`);
    live.forEach((h) => h(payload));
}

/** Fires an event at every listener socket `index` ever registered, even detached ones. */
function emitLate(state: MockState, index: number, evt: string, payload: unknown): void {
    const all = state.sockets[index].everRegistered[evt] ?? [];
    if (all.length === 0) throw new Error(`test bug: socket ${index} never registered '${evt}'`);
    all.forEach((h) => h(payload));
}

const conn = (state: MockState, index: number, payload: unknown) =>
    emit(state, index, 'connection.update', payload);

/** Like emit(), for the `sock.ws` emitter. Throws if nothing is listening (a test bug). */
function wsEmit(state: MockState, index: number, evt: string, payload: unknown): void {
    const live = [...(state.sockets[index].wsHandlers[evt] ?? [])];
    if (live.length === 0) throw new Error(`test bug: socket ${index} has no live ws '${evt}' listener`);
    live.forEach((h) => h(payload));
}

/** Like emitLate(), for the `sock.ws` emitter: reaches listeners the service has already removed. */
function wsEmitLate(state: MockState, index: number, evt: string, payload: unknown): void {
    const all = state.sockets[index].wsEverRegistered[evt] ?? [];
    if (all.length === 0) throw new Error(`test bug: socket ${index} never registered ws '${evt}'`);
    all.forEach((h) => h(payload));
}

interface AckSpec {
    id: string;
    /** Defaults to a group jid. Baileys reads it as the chat; the service must not require it. */
    from?: string;
    /** Present only on a failure ack, as a stringified numeric code (e.g. '403'). */
    error?: string;
}

const ackNode = ({ id, from, error }: AckSpec) => ({
    tag: 'ack',
    attrs: { id, class: 'message', from: from ?? '120363000000000000@g.us', ...(error ? { error } : {}) },
});

/** The server's `<ack class="message">` for one of our sends, delivered to the LIVE ws listener. */
const serverAck = (state: MockState, index: number, spec: AckSpec) =>
    wsEmit(state, index, WA_ACK_EVENT, ackNode(spec));

/** The same ack delivered through `wsEverRegistered`: reaches a socket the service has detached. */
const lateServerAck = (state: MockState, index: number, spec: AckSpec) =>
    wsEmitLate(state, index, WA_ACK_EVENT, ackNode(spec));

/** Fires `messages.update` at a socket's live listeners. The payload is an array of { key, update }. */
const msgUpdate = (state: MockState, index: number, updates: unknown) =>
    emit(state, index, 'messages.update', updates);

/**
 * Indices of the sockets whose events actually reach the service. Probes each socket (live or
 * detached) with a harmless {qr} update and sees whether latestQR moves; restores latestQR after.
 */
function ownedSockets(svc: Svc, state: MockState): number[] {
    const owned: number[] = [];
    state.sockets.forEach((socket, i) => {
        if (!socket.everRegistered['connection.update']) return; // never attached: cannot own anything
        const before = svc.latestQR;
        emitLate(state, i, 'connection.update', { qr: `probe-${i}` });
        if (svc.latestQR === `probe-${i}`) owned.push(i);
        svc.latestQR = before;
    });
    return owned;
}

function closeWith(statusCode?: number, message = 'Connection Closed') {
    const error = Object.assign(new Error(message), { output: { statusCode } });
    return { connection: 'close', lastDisconnect: { error, date: new Date() } };
}

// --- Console capture ---

let logSpy: jest.SpiedFunction<typeof console.log>;
let warnSpy: jest.SpiedFunction<typeof console.warn>;
let errorSpy: jest.SpiedFunction<typeof console.error>;
let exitSpy: jest.SpiedFunction<typeof process.exit>;
let signalHandlers: Record<string, () => Promise<void>>;

/** Reasons carried by every `wa_session_lost` alert line emitted so far. */
function alertReasons(): string[] {
    return errorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('wa_session_lost'))
        .map((line) => (JSON.parse(line.replace('[WA:alert] ', '')) as { reason: string }).reason);
}

function logged(spy: jest.SpiedFunction<typeof console.log>, needle: string): boolean {
    return spy.mock.calls.some((call) => String(call[0]).includes(needle));
}

/** Every rmSync target must be an entry INSIDE the auth dir, never the dir itself. */
function expectContentsOnlyWiped(state: MockState, dir: string) {
    const targets = state.fsRm.mock.calls.map((call) => String(call[0]));
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
        expect(target).not.toBe(dir);
        expect(target.startsWith(dir + '/')).toBe(true);
    }
}

const IDLE_STATUS: WhatsAppStatus = {
    connected: false,
    hasQr: false,
    initializing: false,
    consecutiveInitFailures: 0,
    nextInitAllowedAt: 0,
};

const ENV_KEYS = ['WA_AUTH_PATH', 'WA_DATA_PATH', 'WA_LOG_LEVEL', 'npm_lifecycle_event'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    jest.useFakeTimers();
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    // Capture the shutdown wiring instead of registering real process listeners, and make
    // process.exit inert. Any other process.on() use is passed straight through.
    signalHandlers = {};
    const realOn = process.on.bind(process) as (event: string, listener: () => void) => NodeJS.Process;
    jest.spyOn(process, 'on').mockImplementation(((event: string, listener: () => Promise<void>) => {
        if (event === 'SIGTERM' || event === 'SIGINT') {
            signalHandlers[event] = listener;
            return process;
        }
        return realOn(event, listener);
    }) as unknown as typeof process.on);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.resetModules(); // drop any mock instance Jest cached outside the isolation scope
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

// =============================================================================================
// Happy path
// =============================================================================================

describe('happy path: cold start to a paired, persisted session', () => {
    it('cold start on an empty auth dir opens exactly one socket and the QR reaches latestQR', async () => {
        const { svc, state } = await loadUnpaired();

        expect(state.useAuthState).toHaveBeenCalledTimes(1);
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        expect(svc.latestQR).toBeNull();
        expect(svc.isConnected()).toBe(false);

        conn(state, 0, { qr: 'opaque-qr-payload-A' });

        expect(svc.latestQR).toBe('opaque-qr-payload-A');
        expect(svc.isConnected()).toBe(false);
        expect(svc.getStatus()).toEqual({ ...IDLE_STATUS, hasQr: true, initializing: true });
    });

    it('a second {qr} overwrites the first: re-issue needs no code', async () => {
        const { svc, state } = await loadUnpaired();

        conn(state, 0, { qr: 'opaque-qr-payload-A' });
        conn(state, 0, { qr: 'opaque-qr-payload-B' });

        expect(svc.latestQR).toBe('opaque-qr-payload-B');
    });

    it('a partial update without a qr leaves the current QR alone', async () => {
        const { svc, state } = await loadUnpaired();

        conn(state, 0, { qr: 'opaque-qr-payload-A' });
        conn(state, 0, { connection: 'connecting' });
        conn(state, 0, { qr: undefined });

        expect(svc.latestQR).toBe('opaque-qr-payload-A');
    });

    it('{isNewLogin:true} clears the QR without marking the service connected', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, { qr: 'opaque-qr-payload-A' });

        conn(state, 0, { isNewLogin: true, qr: undefined });

        expect(svc.latestQR).toBeNull();
        expect(svc.isConnected()).toBe(false);
    });

    it('{connection:"open"} sets connected, clears the QR, and clears initializing', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, { qr: 'opaque-qr-payload-A' });

        conn(state, 0, { connection: 'open' });

        expect(svc.isConnected()).toBe(true);
        expect(svc.latestQR).toBeNull();
        expect(svc.getStatus()).toEqual({ ...IDLE_STATUS, connected: true });
    });

    it('open is the only thing that resets the failure counter and the backoff window', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(408));
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(svc.getStatus().nextInitAllowedAt).toBeGreaterThan(0);

        await advance(LADDER_MS[0]);
        expect(state.sockets).toHaveLength(2);
        // A reconnecting socket that has not opened yet must not have cleared anything.
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);

        conn(state, 1, { connection: 'open' });

        expect(svc.getStatus()).toEqual({ ...IDLE_STATUS, connected: true });
    });

    it('creds.update persists through saveCreds every time', async () => {
        const { state } = await loadUnpaired();

        emit(state, 0, 'creds.update', {});
        emit(state, 0, 'creds.update', {});
        emit(state, 0, 'creds.update', {});
        await flush();

        expect(state.saveCreds[0]).toHaveBeenCalledTimes(3);
    });

    it('failure: a saveCreds that rejects is logged and swallowed, and the socket stays live', async () => {
        const { svc, state } = await loadUnpaired();
        state.saveCreds[0].mockRejectedValue(new Error('disk full'));

        emit(state, 0, 'creds.update', {});
        await flush();

        expect(errorSpy).toHaveBeenCalledWith('[WA:auth] Failed to persist credentials:', expect.any(Error));
        conn(state, 0, { connection: 'open' });
        expect(svc.isConnected()).toBe(true);
    });

    it('socket options: a real logger, no version pin, no printQRInTerminal, no history sync, never marks online', async () => {
        const { state } = await loadUnpaired();
        const options = state.makeOptions[0];

        // Baileys 7 crashes inside makeNoiseHandler if logger is undefined (S1 finding 1).
        expect(options.logger).toBe(state.logger);
        expect(typeof (options.logger as { child: unknown }).child).toBe('function');
        expect(state.pino).toHaveBeenCalledWith({ level: 'silent' });
        expect(options.auth).toBe(state.authStates[0]);
        expect(options).not.toHaveProperty('version');
        expect(options).not.toHaveProperty('printQRInTerminal');
        expect(options.syncFullHistory).toBe(false);
        expect((options.shouldSyncHistoryMessage as () => boolean)()).toBe(false);
        expect(options.markOnlineOnConnect).toBe(false);
        expect(options.generateHighQualityLinkPreview).toBe(false);
        expect(options.connectTimeoutMs).toBe(30_000);
        expect(options.keepAliveIntervalMs).toBe(30_000);
    });

    it('WA_LOG_LEVEL raises the pino level; the default stays silent', async () => {
        const { state } = await loadUnpaired({ env: { WA_LOG_LEVEL: 'debug' } });

        expect(state.pino).toHaveBeenCalledWith({ level: 'debug' });
    });
});

// =============================================================================================
// Frozen facade
// =============================================================================================

describe('frozen facade: getStatus()', () => {
    it('returns exactly the five documented fields', async () => {
        const { svc } = await loadPaired();

        expect(Object.keys(svc.getStatus()).sort()).toEqual(
            ['connected', 'consecutiveInitFailures', 'hasQr', 'initializing', 'nextInitAllowedAt'],
        );
    });

    it('connecting state: initializing true, everything else idle', async () => {
        const { svc } = await loadPaired();

        expect(svc.getStatus()).toEqual({ ...IDLE_STATUS, initializing: true });
    });

    it('connecting with a QR on screen: hasQr true', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, { qr: 'opaque-qr-payload-A' });

        expect(svc.getStatus()).toEqual({ ...IDLE_STATUS, initializing: true, hasQr: true });
    });

    it('connected state: connected true, no QR, not initializing', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        expect(svc.getStatus()).toEqual({ ...IDLE_STATUS, connected: true });
    });

    it('backing-off state: failure count and an absolute epoch-ms window', async () => {
        const { svc, state } = await loadPaired();
        const closedAt = Date.now();
        conn(state, 0, closeWith(408));

        expect(svc.getStatus()).toEqual({
            ...IDLE_STATUS,
            consecutiveInitFailures: 1,
            nextInitAllowedAt: closedAt + LADDER_MS[0],
        });
    });

    it('is a non-mutating snapshot: a fresh object every call, and editing it changes nothing', async () => {
        const { svc } = await loadPaired();

        const first = svc.getStatus();
        first.connected = true;
        first.consecutiveInitFailures = 99;
        const second = svc.getStatus();

        expect(second).not.toBe(first);
        expect(second.connected).toBe(false);
        expect(second.consecutiveInitFailures).toBe(0);
    });

    it('isConnected() is true only between open and the next close', async () => {
        const { svc, state } = await loadPaired();
        expect(svc.isConnected()).toBe(false);

        conn(state, 0, { connection: 'open' });
        expect(svc.isConnected()).toBe(true);

        conn(state, 0, closeWith(408));
        expect(svc.isConnected()).toBe(false);
    });
});

describe('singleton and build guard', () => {
    it('a second import of the module returns the same instance and opens no second socket', async () => {
        const { svc, state } = await loadPaired();

        await jest.isolateModulesAsync(async () => {
            const again = await import('@/lib/whatsapp');
            expect(again.whatsappService).toBe(svc);
        });
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });

    it('during `next build` the service is not created and no socket is opened', async () => {
        const { svc, state } = await loadPaired({ lifecycle: 'build' });

        expect(svc).toBeUndefined();
        expect(state.makeWASocket).not.toHaveBeenCalled();
        expect(state.useAuthState).not.toHaveBeenCalled();
    });
});

// =============================================================================================
// Spec 3.1 - logged-out vs transient close
// =============================================================================================

describe('spec 3.1: logged-out vs transient close', () => {
    it.each([401, 403, 411])(
        '3.1 close %i: wipes creds, raises wa_session_lost, stands down, does not rate-limit the re-scan',
        async (code) => {
            const { svc, state } = await loadPaired();
            conn(state, 0, { qr: 'opaque-qr-payload-A' });

            conn(state, 0, closeWith(code));
            await advance(LADDER_MS[LADDER_MS.length - 1] * 2);

            expect([...state.authFiles]).toEqual([]);
            expectContentsOnlyWiped(state, DEFAULT_AUTH_DIR);
            expect(alertReasons()).toEqual([String(code)]);
            expect(state.makeWASocket).toHaveBeenCalledTimes(1); // no auto-reconnect, even 30 min on
            expect(jest.getTimerCount()).toBe(0);
            expect(svc.latestQR).toBeNull();
            expect(svc.getStatus()).toEqual(IDLE_STATUS); // no failure recorded, no backoff window
        },
    );

    it('3.1 the alert line is byte-stable: the Cloud Logging metric matches this exact string', async () => {
        const { state } = await loadPaired();

        conn(state, 0, closeWith(401));

        expect(errorSpy).toHaveBeenCalledWith('[WA:alert] {"event":"wa_session_lost","reason":"401"}');
    });

    it('3.1 after a 401 the service is re-armable by a plain initialize() and by initialize({force:true})', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(401));

        await svc.initialize(); // plain: nothing blocks it
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);

        conn(state, 1, closeWith(401));
        await svc.initialize({ force: true });
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(3);
    });

    it('3.1 the re-armed socket after a 401 finds an empty auth dir, so it issues a QR', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(401));

        await svc.initialize();
        await flush();

        expect(state.authStates[1].creds.registered).toBe(false);
        conn(state, 1, { qr: 'opaque-qr-payload-A' });
        expect(svc.latestQR).toBe('opaque-qr-payload-A');
    });

    it.each([408, 428, 500, 503])(
        '3.1 close %i on a registered session is transient: one timer, no alert, reconnects after the first rung',
        async (code) => {
            const { svc, state } = await loadPaired();

            conn(state, 0, closeWith(code));

            expect(jest.getTimerCount()).toBe(1);
            expect(alertReasons()).toEqual([]);
            expect(state.authFiles.size).toBe(2); // creds untouched
            expect(state.fsRm).not.toHaveBeenCalled();
            expect(svc.getStatus().consecutiveInitFailures).toBe(1);
            expect(state.makeWASocket).toHaveBeenCalledTimes(1);

            await advance(LADDER_MS[0]);

            expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        },
    );

    it('3.1 a close with no statusCode at all is transient too', async () => {
        const { svc, state } = await loadPaired();

        conn(state, 0, closeWith(undefined));

        expect(alertReasons()).toEqual([]);
        expect(jest.getTimerCount()).toBe(1);
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        await advance(LADDER_MS[0]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
    });

    it('3.1 a close with no lastDisconnect is transient too', async () => {
        const { svc, state } = await loadPaired();

        conn(state, 0, { connection: 'close' });

        expect(alertReasons()).toEqual([]);
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(jest.getTimerCount()).toBe(1);
    });

    it('3.1 a transient drop of a live session flips isConnected() false and clears initializing', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        conn(state, 0, closeWith(428));

        expect(svc.isConnected()).toBe(false);
        expect(svc.getStatus().initializing).toBe(false);
    });
});

// =============================================================================================
// Spec 3.2 - QR expiry and re-issue
// =============================================================================================

describe('spec 3.2: QR expiry and re-issue', () => {
    it('3.2 an unscanned QR that expires (408) releases the socket quietly: no alert, no failure, no reconnect', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, { qr: 'opaque-qr-payload-A' });

        conn(state, 0, closeWith(408, 'QR refs attempts ended'));
        await advance(LADDER_MS[LADDER_MS.length - 1]);

        expect(svc.latestQR).toBeNull();
        expect(alertReasons()).toEqual([]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
        expect(svc.getStatus()).toEqual(IDLE_STATUS);
        expect(logged(logSpy, 'No scan before the QR expired')).toBe(true);
    });

    it.each([428, 500, 503])('3.2 a %i on an unpaired socket also stands down quietly', async (code) => {
        const { svc, state } = await loadUnpaired();

        conn(state, 0, closeWith(code));
        await advance(LADDER_MS[LADDER_MS.length - 1]);

        expect(alertReasons()).toEqual([]);
        expect(svc.getStatus()).toEqual(IDLE_STATUS);
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });

    it('3.2 after QR expiry a plain initialize() (the admin Reconnect) opens a socket instantly', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, closeWith(408));

        await svc.initialize();
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        conn(state, 1, { qr: 'opaque-qr-payload-B' });
        expect(svc.latestQR).toBe('opaque-qr-payload-B');
    });

    it('3.2 QR refs are re-issued as repeated {qr} events; each replaces the previous', async () => {
        const { svc, state } = await loadUnpaired();

        const seen: Array<string | null> = [];
        for (const qr of ['ref-1', 'ref-2', 'ref-3']) {
            conn(state, 0, { qr });
            seen.push(svc.latestQR);
        }

        expect(seen).toEqual(['ref-1', 'ref-2', 'ref-3']);
    });

    it('3.2 a close clears the QR even on a registered session that had one showing', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { qr: 'opaque-qr-payload-A' });

        conn(state, 0, closeWith(408));

        expect(svc.latestQR).toBeNull();
    });
});

// =============================================================================================
// Spec 3.3 - reconnect storms
// =============================================================================================

describe('spec 3.3: reconnect storms', () => {
    it('3.3 consecutive transient closes arm 5s, 15s, 60s, 5min, 15min, then 15min again, one timer at a time', async () => {
        const { svc, state } = await loadPaired();
        const expected = [...LADDER_MS, LADDER_MS[LADDER_MS.length - 1]];

        for (let n = 0; n < expected.length; n++) {
            const socketsBefore = state.sockets.length;
            conn(state, socketsBefore - 1, closeWith(408));

            expect(svc.getStatus().consecutiveInitFailures).toBe(n + 1);
            expect(jest.getTimerCount()).toBe(1); // exactly one reconnect timer, never a pile

            await advance(expected[n] - 1);
            expect(state.sockets).toHaveLength(socketsBefore); // one ms early: nothing yet
            await advance(1);
            expect(state.sockets).toHaveLength(socketsBefore + 1); // on the rung: reconnected
        }
    });

    it('3.3 a duplicate close from the same socket is dropped: no second timer, no rung consumed twice', async () => {
        const { svc, state } = await loadPaired();

        conn(state, 0, closeWith(408));
        emitLate(state, 0, 'connection.update', closeWith(408));
        emitLate(state, 0, 'connection.update', closeWith(408));

        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(jest.getTimerCount()).toBe(1);
    });

    it('3.3 a manual initialize() supersedes the pending scheduled reconnect (the timer is cleared)', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(408));
        expect(jest.getTimerCount()).toBe(1);

        await svc.initialize({ force: true });
        await flush();

        expect(state.sockets).toHaveLength(2);
        // Only the new socket's watchdog remains. A leftover reconnect timer would make this 2.
        expect(jest.getTimerCount()).toBe(1);
    });

    it('3.3 a late close from a discarded socket cannot arm a timer or burn a rung', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(408));
        await advance(LADDER_MS[0]); // socket 1 is now current
        conn(state, 1, { connection: 'open' });
        expect(jest.getTimerCount()).toBe(0);

        emitLate(state, 0, 'connection.update', closeWith(408));

        expect(jest.getTimerCount()).toBe(0);
        expect(svc.isConnected()).toBe(true);
        expect(svc.getStatus().consecutiveInitFailures).toBe(0);
    });

    it('3.3 the scheduled reconnect bypasses the backoff window it just opened, even with a millisecond of timer skew', async () => {
        const { state } = await loadPaired();
        const timerClockNow = Date.now.bind(Date);
        conn(state, 0, closeWith(408));
        // Node timers can fire a millisecond "early" against Date.now(). Make Date.now() lag the
        // timer clock by 1ms so that, when the 5s timer fires, the window has NOT quite elapsed.
        // A non-forced initialize() would then be a silent no-op that nothing ever retries.
        jest.spyOn(Date, 'now').mockImplementation(() => timerClockNow() - 1);

        await advance(LADDER_MS[0]);

        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
    });

    it('3.3 a reconnect that succeeds resets the ladder: the next drop starts at 5s again', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(408));
        await advance(LADDER_MS[0]);
        conn(state, 1, closeWith(408));
        await advance(LADDER_MS[1]);
        conn(state, 2, { connection: 'open' });
        expect(svc.getStatus().consecutiveInitFailures).toBe(0);

        conn(state, 2, closeWith(408));
        await advance(LADDER_MS[0] - 1);
        expect(state.sockets).toHaveLength(3);
        await advance(1);

        expect(state.sockets).toHaveLength(4);
    });

    it('3.3 the reconnect timer and the connect watchdog are unref()ed so they cannot hold the process open', async () => {
        const handles: Array<{ ms: number; unref: jest.Mock }> = [];
        const realSetTimeout = global.setTimeout;
        jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
            const handle = realSetTimeout(fn, ms) as unknown as { unref: () => unknown };
            const unref = jest.fn(() => handle);
            handle.unref = unref;
            handles.push({ ms: ms ?? 0, unref });
            return handle;
        }) as unknown as typeof setTimeout);

        const { state } = await loadPaired();
        conn(state, 0, closeWith(408));

        const watchdog = handles.find((h) => h.ms === WATCHDOG_MS);
        const reconnect = handles.find((h) => h.ms === LADDER_MS[0]);
        expect(watchdog?.unref).toHaveBeenCalled();
        expect(reconnect?.unref).toHaveBeenCalled();
    });
});

// =============================================================================================
// Spec 3.4 - concurrent initialize() calls (and the backoff gate)
// =============================================================================================

describe('spec 3.4: concurrent initialize() calls', () => {
    it('3.4 three concurrent calls, one forced, while the first is parked in useMultiFileAuthState, open one socket', async () => {
        const gate = deferred();
        const { svc, state } = await loadPaired({ authPlan: [gate] });
        expect(state.makeWASocket).not.toHaveBeenCalled(); // bootstrap parked at the only await

        await Promise.all([svc.initialize(), svc.initialize({ force: true }), svc.initialize()]);
        expect(state.useAuthState).toHaveBeenCalledTimes(1); // none of them started a second attempt

        gate.resolve();
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });

    it('3.4 three concurrent calls from an idle (stood-down) service open exactly one socket', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(401));
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);

        await Promise.all([svc.initialize(), svc.initialize({ force: true }), svc.initialize()]);
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
    });

    it('3.4 force:true does not bypass the already-connecting guard', async () => {
        const { svc, state } = await loadPaired(); // socket 0 is connecting

        await svc.initialize({ force: true });
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });

    it('3.4 force:true does not bypass the already-connected guard', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        await svc.initialize({ force: true });
        await svc.initialize();
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        expect(svc.isConnected()).toBe(true);
    });

    it('3.4 a plain initialize() inside the backoff window is a silent no-op until the window elapses', async () => {
        const { svc, state } = await loadPaired({ authPlan: [new Error('EACCES: permission denied')] });
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(state.useAuthState).toHaveBeenCalledTimes(1);
        const logLinesBefore = logSpy.mock.calls.length;

        await svc.initialize();
        await advance(LADDER_MS[0] - 1);
        await svc.initialize();

        expect(state.useAuthState).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls.length).toBe(logLinesBefore); // silent: no per-attempt log noise

        await advance(1);
        await svc.initialize();
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });

    it('3.4 initialize({force:true}) proceeds inside a backoff window', async () => {
        const { svc, state } = await loadPaired({ authPlan: [new Error('EACCES: permission denied')] });
        expect(svc.getStatus().nextInitAllowedAt).toBeGreaterThan(Date.now());

        await svc.initialize({ force: true });
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });
});

// =============================================================================================
// Spec 3.5 - logout racing a reconnect, plus the #16/#17 logout contract
// =============================================================================================

describe('spec 3.5: logout', () => {
    it('3.5 trigger A: logout with a reconnect pending cancels it and opens exactly one socket (its own re-arm)', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(408));
        expect(jest.getTimerCount()).toBe(1); // the pending reconnect

        const result = await svc.logout();
        await flush();

        expect(result).toBe(true);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(1); // only the re-armed socket's watchdog
        expect(logged(logSpy, 'connection attempt was in flight')).toBe(false);

        await advance(LADDER_MS[LADDER_MS.length - 1]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2); // the old reconnect never fired
        expect(alertReasons()).toEqual([]);
        expect([...state.authFiles]).toEqual([]);
    });

    it('3.5 logout empties the auth dir contents, never the directory, and re-arms against the empty dir', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        await svc.logout();
        await flush();

        expect([...state.authFiles]).toEqual([]);
        expectContentsOnlyWiped(state, DEFAULT_AUTH_DIR);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        expect(state.authStates[1].creds.registered).toBe(false);
        conn(state, 1, { qr: 'opaque-qr-payload-A' });
        expect(svc.latestQR).toBe('opaque-qr-payload-A');
    });

    it('3.5 a connected logout uses sock.logout() (unlinks the device); it does not settle for end()', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        await svc.logout();

        expect(state.sockets[0].logout).toHaveBeenCalledTimes(1);
        expect(state.sockets[0].end).not.toHaveBeenCalled();
        expect(svc.isConnected()).toBe(false);
        expect(svc.latestQR).toBeNull();
        // The old socket is cut loose: nothing of ours listens to it any more.
        expect(state.sockets[0].handlers['connection.update']).toBeUndefined();
        expect(state.sockets[0].handlers['creds.update']).toBeUndefined();
    });

    it('3.5 logout clears a QR that was on screen straight away (the old code is unscannable)', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, { qr: 'opaque-qr-payload-A' });
        expect(svc.getStatus().hasQr).toBe(true);

        await svc.logout();

        expect(svc.latestQR).toBeNull();
        expect(svc.getStatus().hasQr).toBe(false);
    });

    it('3.5 a logout while connecting still unlinks when the socket holds valid creds', async () => {
        // graceful is `isReady || wasRegistered`, not `isReady` alone. A socket built from
        // real credentials already has an entry in the phone's Linked Devices even before it
        // reaches 'open'; end()ing it would wipe our copy and strand that entry, burning a
        // companion slot with a zombie the admin cannot tell from a live one. The trigger is
        // ordinary: clicking Logout while a reconnect is in flight.
        const { svc, state } = await loadPaired();

        await svc.logout();

        expect(state.sockets[0].logout).toHaveBeenCalled();
        expect(state.sockets[0].end).not.toHaveBeenCalled();
    });

    it('3.5 a logout with no credentials to unlink just end()s the socket', async () => {
        // The other half of `isReady || wasRegistered`: an unpaired socket has no device
        // entry to remove, so sock.logout() would be a pointless round trip.
        const { svc, state } = await loadUnpaired();

        await svc.logout();

        expect(state.sockets[0].logout).not.toHaveBeenCalled();
        expect(state.sockets[0].end).toHaveBeenCalledWith(undefined);
    });

    it('3.5 logout resets the failure counter and the backoff window before the forced re-arm', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(408));
        await advance(LADDER_MS[0]);
        conn(state, 1, closeWith(408));
        expect(svc.getStatus().consecutiveInitFailures).toBe(2);
        expect(svc.getStatus().nextInitAllowedAt).toBeGreaterThan(Date.now());

        await svc.logout();
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(3);
        expect(svc.getStatus()).toEqual({ ...IDLE_STATUS, initializing: true });
    });

    it('3.5 #17 logout still resolves true when sock.logout() rejects, and still wipes and re-arms', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        state.sockLogout.mockRejectedValue(new Error('socket already gone'));

        const result = await svc.logout();
        await flush();

        expect(result).toBe(true);
        expect([...state.authFiles]).toEqual([]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalledWith(
            '[WA:logout] Socket teardown did not complete cleanly:',
            expect.any(Error),
        );
    });

    it('3.5 logout is bounded: a sock.logout() that never settles still resolves true after 5s, not before', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        state.sockLogout.mockReturnValue(new Promise(() => undefined));

        let settled = false;
        const pending = svc.logout().then((v) => {
            settled = true;
            return v;
        });
        await advance(SOCKET_END_TIMEOUT_MS - 1);
        expect(settled).toBe(false);

        await advance(1);

        expect(await pending).toBe(true);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
    });

    it('3.5 logout resolves true when the auth dir cannot be cleared (EBUSY), and says so', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        state.fsRm.mockImplementation(() => {
            throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        });

        const result = await svc.logout();

        expect(result).toBe(true);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to clear credentials'),
            expect.any(Error),
        );
    });

    it('3.5 logout when the auth dir does not exist reads nothing, removes nothing, and logs no failure', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        state.fsExists.mockReturnValue(false);

        const result = await svc.logout();

        expect(result).toBe(true);
        expect(state.fsReaddir).not.toHaveBeenCalled();
        expect(state.fsRm).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalledWith(
            expect.stringContaining('Failed to clear credentials'),
            expect.anything(),
        );
    });

    it('3.5 logout with no socket and nothing in flight still resolves true and re-arms once', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(401)); // stood down, no socket

        const result = await svc.logout();
        await flush();

        expect(result).toBe(true);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
    });

    it('3.5 trigger B: logout mid-useMultiFileAuthState logs the supersede line, wipes, and raises no alert', async () => {
        const gate = deferred();
        const { svc, state } = await loadPaired({ authPlan: [gate] });
        expect(state.sockets).toHaveLength(0);
        expect(svc.getStatus().initializing).toBe(true);

        const result = await svc.logout();
        await flush();

        expect(result).toBe(true);
        expect(logged(logSpy, 'A connection attempt was in flight; it will be superseded.')).toBe(true);
        expect([...state.authFiles]).toEqual([]);
        expect(alertReasons()).toEqual([]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(1); // logout's own forced re-arm, on the empty dir
    });

    it('3.5 trigger B: the in-flight openSocket() still completes, one socket ends up owned, and its close is handled normally', async () => {
        const gate = deferred();
        const { svc, state } = await loadPaired({ authPlan: [gate] });
        await svc.logout();
        await flush();

        gate.resolve();
        await flush();

        // Socket 0 was built by logout's re-arm (empty dir); socket 1 by the in-flight call,
        // on the PRE-wipe state, which the spec accepts. Which of them the service ends up
        // owning is not asserted here (the next test pins the leak); that exactly one is, is.
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        expect(state.authStates[0].creds.registered).toBe(false);
        expect(state.authStates[1].creds.registered).toBe(true);
        const owned = ownedSockets(svc, state);
        expect(owned).toHaveLength(1);

        emitLate(state, owned[0], 'connection.update', closeWith(408));

        expect(alertReasons()).toEqual([]);
        expect(svc.getStatus().initializing).toBe(false);
        expect(svc.isConnected()).toBe(false);
        // The owned socket is UNREGISTERED, so its close must take the quiet
        // unpaired stand-down: no rung burnt, no reconnect armed. Without these two the
        // transient branch satisfies the three assertions above just as well, and the
        // wasRegistered relocation in openSocket() would be unpinned (review F5).
        expect(svc.getStatus().consecutiveInitFailures).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('3.5 trigger B: after the race settles, no socket is left running with nothing owning it', async () => {
        const gate = deferred();
        const { svc, state } = await loadPaired({ authPlan: [gate] });
        await svc.logout();
        await flush();
        gate.resolve();
        await flush();
        expect(state.sockets).toHaveLength(2);

        // Exactly one socket is svc's live one. Any other must have been ended or logged out;
        // an un-ended, un-owned socket keeps a WhatsApp connection nobody can ever close.
        const untouched = state.sockets.filter(
            (s) => s.end.mock.calls.length === 0 && s.logout.mock.calls.length === 0,
        );
        expect(untouched.length).toBeLessThanOrEqual(1);
    });

    // Added by the pipeline LEAD while fixing defect D1, not by the tester stage. The two
    // tests above are satisfied by either resolution of this race, but the two resolutions
    // are NOT behaviourally equivalent, so the choice needs pinning. Under "last wins" the
    // service ends up owning the socket built from the PRE-wipe credentials: it reports
    // itself connected as the very account the admin just logged out, and no QR is ever
    // shown. This test fails under "last wins".
    it('3.5 trigger B: first wins — the service keeps the post-wipe socket, so logout really logs out', async () => {
        const gate = deferred();
        const { svc, state } = await loadPaired({ authPlan: [gate] });
        await svc.logout();
        await flush();
        gate.resolve();
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        // Socket 0: logout's re-arm, built on the emptied auth dir. Socket 1: the in-flight
        // launch, still holding the credentials logout was supposed to destroy.
        expect(state.authStates[0].creds.registered).toBe(false);
        expect(state.authStates[1].creds.registered).toBe(true);

        // The incumbent is kept and the newcomer discarded. Socket 1 is never attached, so
        // ownedSockets() cannot see it at all; it must have been ended.
        expect(ownedSockets(svc, state)).toEqual([0]);
        expect(state.sockets[1].end).toHaveBeenCalledTimes(1);
        // Discarded, not logged out: throwing away our own socket must never unlink the
        // device from the phone.
        expect(state.sockets[1].logout).not.toHaveBeenCalled();

        // The consequence that actually matters to the admin: a fresh QR can still reach
        // the page, because the socket the service owns is the one with no credentials.
        emitLate(state, 0, 'connection.update', { qr: 'post-wipe-qr' });
        expect(svc.latestQR).toBe('post-wipe-qr');
        expect(svc.isConnected()).toBe(false);
    });

    it('3.5 trigger B: a pre-wipe socket is discarded even when it reaches the guard first (auth epoch)', async () => {
        // The ordering the review identified as the dangerous one, and the reason the guard
        // cannot rely on who finishes first. Here the in-flight launch — the one holding the
        // credentials logout is about to delete — reaches the install point BEFORE logout's
        // re-arm does, with this.sock still null, so a purely order-based "first wins" would
        // install it. It would then reach 'open', report isConnected() as the very account
        // the admin just logged out, never show a QR, and its own saveCreds would rewrite the
        // credentials that were just deleted. The epoch makes the decision causal.
        const inflight = deferred();
        const rearm = deferred();
        const { svc, state } = await loadPaired({ authPlan: [inflight, rearm] });

        await svc.logout(); // wipes the creds (bumping the epoch) and starts the re-arm
        await flush();

        inflight.resolve(); // the PRE-wipe launch gets to the guard first
        await flush();

        expect(state.authStates[0].creds.registered).toBe(true); // it was built pre-wipe
        expect(state.sockets[0].end).toHaveBeenCalledWith(undefined); // discarded regardless
        expect(state.sockets[0].logout).not.toHaveBeenCalled(); // discarded, not unlinked
        expect(ownedSockets(svc, state)).toEqual([]); // nothing installed yet
        expect(svc.isConnected()).toBe(false);

        rearm.resolve(); // now the post-wipe launch installs
        await flush();

        expect(state.authStates[1].creds.registered).toBe(false);
        expect(ownedSockets(svc, state)).toEqual([1]);
        emitLate(state, 1, 'connection.update', { qr: 'fresh-qr' });
        expect(svc.latestQR).toBe('fresh-qr');
    });

    it('3.5 trigger C: the loggedOut close from sock.logout() landing AFTER logout() finished is dropped', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        await svc.logout();
        await flush();
        // The re-armed socket pairs and writes fresh creds, as Baileys would.
        state.authFiles.add('creds.json');
        const rmBefore = state.fsRm.mock.calls.length;

        emitLate(state, 0, 'connection.update', closeWith(401));

        expect(alertReasons()).toEqual([]);
        expect(state.authFiles.has('creds.json')).toBe(true); // the guard saved the new session's creds
        expect(state.fsRm.mock.calls.length).toBe(rmBefore);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(1); // only the re-armed socket's watchdog
    });

    it('3.5 #7 a 401 close landing INSIDE logout() (before the detach) is recognised as intentional: no alert', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        state.sockLogout.mockImplementation(async () => {
            // Real Baileys ends the socket right after the iq, so the close can land first.
            conn(state, 0, closeWith(401, 'Intentional Logout'));
        });

        await svc.logout();
        await flush();

        expect(alertReasons()).toEqual([]);
        expect(logged(logSpy, 'Intentional admin logout')).toBe(true);
        expect([...state.authFiles]).toEqual([]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2); // one re-arm, not two
    });

    it('3.5 #8 the intentional flag is one-shot: a genuine 401 after a completed logout alerts again', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        await svc.logout(); // sock.logout() resolves without ever emitting a close
        await flush();
        expect(alertReasons()).toEqual([]);

        conn(state, 1, closeWith(401)); // WhatsApp unlinks the device from the phone

        expect(alertReasons()).toEqual(['401']);
    });

    it('3.5 #8 the flag is consumed by the close that uses it: a second 401 alerts', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        state.sockLogout.mockImplementation(async () => {
            conn(state, 0, closeWith(401, 'Intentional Logout'));
        });
        await svc.logout();
        await flush();
        expect(alertReasons()).toEqual([]);

        conn(state, 1, closeWith(401));

        expect(alertReasons()).toEqual(['401']);
    });

    it('3.5 a close emitted by end() inside logout() (registered, still connecting) neither alerts nor leaves a reconnect or a rung behind', async () => {
        const { svc, state } = await loadPaired(); // connecting, never reached open
        state.sockEnd.mockImplementation(async () => {
            // Real Baileys: end(undefined) emits a status-less close before it resolves.
            conn(state, 0, closeWith(undefined));
        });

        await svc.logout();
        await flush();

        expect(alertReasons()).toEqual([]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        expect(svc.getStatus().consecutiveInitFailures).toBe(0);
        expect(svc.getStatus().nextInitAllowedAt).toBe(0);
        expect(jest.getTimerCount()).toBe(1); // only the re-armed socket's watchdog
        await advance(LADDER_MS[0]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
    });
});

// =============================================================================================
// Spec 3.6 - restart with existing creds
// =============================================================================================

describe('spec 3.6: restart with existing creds', () => {
    it('3.6 a populated auth dir goes straight to open: no QR, no human, creds read from the configured dir', async () => {
        const { svc, state } = await loadPaired();

        expect(state.useAuthState).toHaveBeenCalledWith(DEFAULT_AUTH_DIR);
        expect(state.authStates[0].creds.registered).toBe(true);
        expect(svc.latestQR).toBeNull();

        conn(state, 0, { connection: 'connecting' });
        expect(svc.latestQR).toBeNull();
        conn(state, 0, { connection: 'open' });

        expect(svc.isConnected()).toBe(true);
        expect(svc.latestQR).toBeNull();
        expect(state.fsRm).not.toHaveBeenCalled(); // restart reads creds, never wipes them
        expect(alertReasons()).toEqual([]);
    });

    it('3.6 key rotation during the session is persisted: every creds.update reaches saveCreds', async () => {
        const { state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        emit(state, 0, 'creds.update', { noiseKey: 'rotated-1' });
        emit(state, 0, 'creds.update', { noiseKey: 'rotated-2' });
        await flush();

        expect(state.saveCreds[0]).toHaveBeenCalledTimes(2);
    });

    it('3.6 WA_AUTH_PATH is honoured for reads and for the logout wipe', async () => {
        const { svc, state } = await loadPaired({ env: { WA_AUTH_PATH: '/data/wa-auth' } });
        expect(state.useAuthState).toHaveBeenCalledWith('/data/wa-auth');
        conn(state, 0, { connection: 'open' });

        await svc.logout();

        expectContentsOnlyWiped(state, '/data/wa-auth');
        expect(state.fsReaddir).toHaveBeenCalledWith('/data/wa-auth');
    });

    it('3.6 without WA_AUTH_PATH the default is /app/.baileys_auth, and the old WA_DATA_PATH is ignored', async () => {
        const { state } = await loadPaired({ env: { WA_DATA_PATH: '/app/.wwebjs_auth' } });

        expect(state.useAuthState).toHaveBeenCalledWith('/app/.baileys_auth');
    });

    it('3.6 an empty WA_AUTH_PATH falls back to the default', async () => {
        const { state } = await loadPaired({ env: { WA_AUTH_PATH: '' } });

        expect(state.useAuthState).toHaveBeenCalledWith('/app/.baileys_auth');
    });
});

// =============================================================================================
// Spec 3.7 - restart with corrupt or partial creds
// =============================================================================================

describe('spec 3.7: restart with corrupt or partial creds', () => {
    it('3.7 creds Baileys could not read arrive as an unregistered state: a QR is issued, no special handling', async () => {
        // useMultiFileAuthState swallows the parse error and returns initAuthCreds(); to us that
        // is just an unregistered state. The fs mock has no readFileSync, so any pre-flight read
        // in our code would have thrown and failed this test.
        const { svc, state } = await loadUnpaired();
        state.authFiles.add('creds.json.corrupt');

        conn(state, 0, { qr: 'opaque-qr-payload-A' });

        expect(svc.latestQR).toBe('opaque-qr-payload-A');
        expect(alertReasons()).toEqual([]);
        expect(svc.getStatus().consecutiveInitFailures).toBe(0);
    });

    it('3.7 creds that parse but that WhatsApp revokes: a 500 retries under backoff, then the 401 wipes and alerts', async () => {
        const { state } = await loadPaired();

        conn(state, 0, closeWith(500, 'Bad Session'));
        expect(alertReasons()).toEqual([]);
        expect(state.authFiles.size).toBe(2);
        await advance(LADDER_MS[0]);
        expect(state.sockets).toHaveLength(2);

        conn(state, 1, closeWith(401));

        expect([...state.authFiles]).toEqual([]);
        expect(alertReasons()).toEqual(['401']);
        await advance(LADDER_MS[LADDER_MS.length - 1]);
        expect(state.sockets).toHaveLength(2); // stood down
    });

    it('3.7 fatal: an auth path that is a file makes useMultiFileAuthState throw; recorded as a failure, service stays usable', async () => {
        const fatal = new Error('found something that is not a directory at /app/.baileys_auth');
        const { svc, state } = await loadPaired({ authPlan: [fatal] });

        expect(state.makeWASocket).not.toHaveBeenCalled();
        expect(svc.getStatus()).toEqual({
            ...IDLE_STATUS,
            consecutiveInitFailures: 1,
            nextInitAllowedAt: Date.now() + LADDER_MS[0],
        });
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Socket initialization failed'),
            fatal,
        );
        // One timer: the retry the failure armed. Even a genuinely fatal cause (a file
        // where the auth directory should be) must keep retrying — the ladder tops out at
        // 15 min repeating, and those log lines are the only signal anyone gets that
        // WhatsApp is down. The alternative is an indefinite outage nothing recovers from.
        expect(jest.getTimerCount()).toBe(1);

        state.authPlan.length = 0; // let the retry succeed
        await advance(LADDER_MS[0]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });
});

// =============================================================================================
// Genuine failures during init
// =============================================================================================

describe('failure handling in initialize()', () => {
    it('useMultiFileAuthState rejects twice: the ladder advances 5s then 15s, then a good attempt connects', async () => {
        const { svc, state } = await loadPaired({
            authPlan: [new Error('EACCES: permission denied'), new Error('EACCES: permission denied')],
        });
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);

        await advance(LADDER_MS[0]);
        await svc.initialize(); // window elapsed: the plain call is allowed and fails again
        expect(svc.getStatus().consecutiveInitFailures).toBe(2);
        expect(svc.getStatus().nextInitAllowedAt).toBe(Date.now() + LADDER_MS[1]);
        expect(svc.getStatus().initializing).toBe(false);

        await advance(LADDER_MS[1]);
        await svc.initialize();
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        conn(state, 0, { connection: 'open' });

        expect(svc.getStatus()).toEqual({ ...IDLE_STATUS, connected: true });
    });

    it('makeWASocket throwing is an init failure: recorded, nothing latched, no watchdog leaked', async () => {
        const { svc, state } = await loadPaired({ makePlan: [new Error('makeNoiseHandler exploded')] });

        expect(state.sockets).toHaveLength(0);
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(svc.getStatus().initializing).toBe(false);
        expect(svc.isConnected()).toBe(false);
        expect(jest.getTimerCount()).toBe(1); // the retry armed by the failure

        await svc.initialize({ force: true });
        await flush();
        expect(state.sockets).toHaveLength(1);
    });

    it('a throw after the socket exists (listener registration) ends and releases that socket', async () => {
        const { svc, state } = await loadPaired({ evOnThrows: true });

        expect(state.sockets).toHaveLength(1);
        expect(state.sockets[0].end).toHaveBeenCalledWith(undefined);
        expect(svc.getStatus().initializing).toBe(false);
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(svc.isConnected()).toBe(false);
        expect(jest.getTimerCount()).toBe(1); // the retry armed by the failure
    });

    it('a launch that throws before installing must not tear down the socket another launch installed', async () => {
        // Review F4. Every throw site in openSocket() is before `this.sock = sock`, so at
        // the moment initialize()'s catch runs, this.sock — if set at all — belongs to a
        // DIFFERENT launch. Calling teardownSocket() there would destroy a healthy socket
        // because an unrelated, already-doomed launch failed, and (with no retry armed for
        // the victim) leave WhatsApp down until an admin clicks Reconnect. openSocket() now
        // cleans up only a socket it installed itself.
        const gate = deferred();
        const { svc, state } = await loadPaired({
            authPlan: [gate],
            makePlan: [null, new Error('makeNoiseHandler exploded')],
        });

        // logout() clears the latch while the bootstrap launch is parked, so its re-arm
        // installs a socket of its own.
        await svc.logout();
        await flush();
        expect(ownedSockets(svc, state)).toEqual([0]);

        gate.resolve(); // the parked launch resumes and throws at makeWASocket
        await flush();

        // The failure is recorded against the service, but the healthy socket survives.
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(ownedSockets(svc, state)).toEqual([0]);
        expect(state.sockets[0].end).not.toHaveBeenCalled();
        expect(state.sockets[0].logout).not.toHaveBeenCalled();
    });

    it('a failed init does not raise the session-lost alert (nothing was lost)', async () => {
        await loadPaired({ authPlan: [new Error('EACCES')] });

        expect(alertReasons()).toEqual([]);
    });
});

// =============================================================================================
// Spec 3.8 - socket death without a close event
// =============================================================================================

describe('spec 3.8: socket death without a close event (connect watchdog)', () => {
    it('3.8 a connecting socket has exactly one timer armed: the watchdog', async () => {
        await loadPaired();

        expect(jest.getTimerCount()).toBe(1);
    });

    it('3.8 an unpaired socket that goes silent for 90s: not ready, not initializing, one failure, no alert, no reconnect', async () => {
        const { svc, state } = await loadUnpaired();

        await advance(WATCHDOG_MS);

        expect(svc.isConnected()).toBe(false);
        expect(svc.getStatus().initializing).toBe(false);
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(alertReasons()).toEqual([]);
        expect(jest.getTimerCount()).toBe(0);
        expect(state.sockets[0].end).toHaveBeenCalledWith(undefined); // the dead socket is released
        await advance(LADDER_MS[LADDER_MS.length - 1]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });

    it('3.8 a registered socket that goes silent: alert connect_watchdog AND a scheduled reconnect', async () => {
        const { svc, state } = await loadPaired();

        await advance(WATCHDOG_MS);

        expect(alertReasons()).toEqual(['connect_watchdog']);
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(svc.getStatus().initializing).toBe(false);
        expect(jest.getTimerCount()).toBe(1); // the reconnect timer

        await advance(LADDER_MS[0]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
    });

    it('3.8 the watchdog waits the full 90s: one millisecond early, nothing has happened', async () => {
        const { svc, state } = await loadPaired();

        await advance(WATCHDOG_MS - 1);

        expect(svc.getStatus().initializing).toBe(true);
        expect(svc.getStatus().consecutiveInitFailures).toBe(0);
        expect(state.sockets[0].end).not.toHaveBeenCalled();
    });

    it('3.8 reaching open disarms the watchdog: 90s+ later the session is still connected', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        expect(jest.getTimerCount()).toBe(0);

        await advance(WATCHDOG_MS * 2);

        expect(svc.isConnected()).toBe(true);
        expect(svc.getStatus().consecutiveInitFailures).toBe(0);
        expect(alertReasons()).toEqual([]);
        expect(state.sockets[0].end).not.toHaveBeenCalled();
    });

    it('3.8 a close disarms the watchdog: it cannot fire a second failure on top of the close', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(408));
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(jest.getTimerCount()).toBe(1); // the reconnect timer alone: the watchdog went with the close

        await advance(WATCHDOG_MS - 1); // the reconnect (5s) has fired; its own watchdog is 85s from done

        expect(alertReasons()).toEqual([]);
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
    });

    it('3.8 a torn-down socket cannot leave a watchdog behind to fire against its successor', async () => {
        const { svc, state } = await loadUnpaired();
        await svc.logout();
        await flush();
        expect(state.sockets).toHaveLength(2);

        await advance(WATCHDOG_MS - 1); // the ORIGINAL watchdog would have fired 1ms from now

        expect(svc.getStatus().initializing).toBe(true); // successor still connecting, untouched
        expect(state.sockets[1].end).not.toHaveBeenCalled();
    });
});

// =============================================================================================
// Spec 3.9 - restartRequired (515)
// =============================================================================================

describe('spec 3.9: restartRequired (515), the first-pairing handshake', () => {
    it('3.9 first pairing end to end: qr, isNewLogin, creds.update, 515 then an immediate reconnect that opens', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, { qr: 'opaque-qr-payload-A' });
        expect(svc.latestQR).toBe('opaque-qr-payload-A');

        // The admin scans. Baileys persists registered creds, announces the login, then the
        // server demands a restart. That is the NORMAL path, on the one scan the migration exists for.
        state.authFiles.add('creds.json');
        conn(state, 0, { isNewLogin: true, qr: undefined });
        emit(state, 0, 'creds.update', {});
        await flush();
        expect(state.saveCreds[0]).toHaveBeenCalledTimes(1);
        expect(svc.latestQR).toBeNull();

        conn(state, 0, closeWith(515, 'Stream Errored (restart required)'));
        await flush(); // NO timer advance: the reconnect is immediate

        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        expect(svc.getStatus()).toEqual({ ...IDLE_STATUS, initializing: true });
        expect(alertReasons()).toEqual([]);
        expect(state.fsRm).not.toHaveBeenCalled(); // the creds the admin just created survive
        expect(state.authFiles.has('creds.json')).toBe(true);
        expect(state.authStates[1].creds.registered).toBe(true); // the restart sees the new creds

        conn(state, 1, { connection: 'open' });
        expect(svc.isConnected()).toBe(true);
        expect(svc.latestQR).toBeNull();
    });

    it('3.9 a 515 leaves the failure counter at 0 and arms no reconnect timer', async () => {
        const { svc, state } = await loadUnpaired();

        conn(state, 0, closeWith(515));
        await flush();

        expect(svc.getStatus().consecutiveInitFailures).toBe(0);
        expect(svc.getStatus().nextInitAllowedAt).toBe(0);
        expect(jest.getTimerCount()).toBe(1); // only the new socket's watchdog, no reconnect timer
    });

    it('3.9 a 515 reconnects immediately even inside a backoff window (it is forced)', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(408)); // opens a 5s window
        await svc.initialize({ force: true }); // socket 1, created INSIDE the window
        await flush();
        expect(state.sockets).toHaveLength(2);
        expect(svc.getStatus().nextInitAllowedAt).toBeGreaterThan(Date.now());
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);

        conn(state, 1, closeWith(515));
        await flush();

        expect(state.sockets).toHaveLength(3);
        expect(svc.getStatus().consecutiveInitFailures).toBe(1); // unchanged: 515 is not a failure
    });

    it('3.9 a 515 on a registered session is not routed through the terminal branch: creds kept, no alert', async () => {
        const { state } = await loadPaired();

        conn(state, 0, closeWith(515));
        await flush();

        expect(state.authFiles.size).toBe(2);
        expect(alertReasons()).toEqual([]);
    });

    it('3.9 a rejected re-init after a 515 is caught and logged, not thrown', async () => {
        const { svc, state } = await loadPaired();
        state.authPlan.push(new Error('EACCES: permission denied'));

        conn(state, 0, closeWith(515));
        await flush();

        expect(svc.getStatus().consecutiveInitFailures).toBe(1); // the init failure, recorded normally
        expect(svc.getStatus().initializing).toBe(false);
    });
});

// =============================================================================================
// Spec 3.10 - connectionReplaced (440)
// =============================================================================================

describe('spec 3.10: connectionReplaced (440)', () => {
    it('3.10 alerts with reason connection_replaced, keeps the creds, arms nothing, records no failure', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        conn(state, 0, closeWith(440, 'Stream Errored (conflict)'));
        await advance(LADDER_MS[LADDER_MS.length - 1]);

        expect(alertReasons()).toEqual(['connection_replaced']);
        expect(state.authFiles.size).toBe(2);
        expect(state.fsRm).not.toHaveBeenCalled();
        expect(state.makeWASocket).toHaveBeenCalledTimes(1); // no reconnect: that would start a ping-pong
        expect(jest.getTimerCount()).toBe(0);
        expect(svc.getStatus()).toEqual(IDLE_STATUS);
        expect(svc.isConnected()).toBe(false);
    });

    it('3.10 the service is re-armable from the admin Reconnect after standing down', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(440));

        await svc.initialize();
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        expect(state.authStates[1].creds.registered).toBe(true); // creds still there to reuse
    });

    it('3.10 a 440 on an unpaired socket still takes the 440 branch (checked before the unregistered stand-down)', async () => {
        const { state } = await loadUnpaired();

        conn(state, 0, closeWith(440));

        expect(alertReasons()).toEqual(['connection_replaced']);
    });
});

// =============================================================================================
// Spec 3.11 - close (and other events) from a superseded socket
// =============================================================================================

describe('spec 3.11: events from a superseded socket', () => {
    async function twoSockets() {
        // Socket 0 dies quietly (QR expiry), the admin Reconnects, socket 1 becomes current.
        const loaded = await loadUnpaired();
        conn(loaded.state, 0, closeWith(408));
        await loaded.svc.initialize();
        await flush();
        expect(loaded.state.sockets).toHaveLength(2);
        return loaded;
    }

    it('3.11 #18 a superseded socket cannot overwrite latestQR', async () => {
        const { svc, state } = await twoSockets();
        conn(state, 1, { qr: 'fresh-qr-from-current-socket' });

        emitLate(state, 0, 'connection.update', { qr: 'stale-qr-from-dead-socket' });

        expect(svc.latestQR).toBe('fresh-qr-from-current-socket');
    });

    it('3.11 a superseded socket cannot flip the service to connected', async () => {
        const { svc, state } = await twoSockets();

        emitLate(state, 0, 'connection.update', { connection: 'open' });

        expect(svc.isConnected()).toBe(false);
        expect(svc.getStatus().initializing).toBe(true); // socket 1 is still connecting
    });

    it('3.11 a superseded socket cannot clear the QR through isNewLogin', async () => {
        const { svc, state } = await twoSockets();
        conn(state, 1, { qr: 'fresh-qr-from-current-socket' });

        emitLate(state, 0, 'connection.update', { isNewLogin: true, qr: undefined });

        expect(svc.latestQR).toBe('fresh-qr-from-current-socket');
    });

    it('3.11 a superseded socket cannot knock a live session off: no wipe, no alert, no timer', async () => {
        const { svc, state } = await twoSockets();
        conn(state, 1, { connection: 'open' });
        state.authFiles.add('creds.json'); // the live session's creds

        emitLate(state, 0, 'connection.update', closeWith(401));

        expect(svc.isConnected()).toBe(true);
        expect(state.authFiles.has('creds.json')).toBe(true);
        expect(alertReasons()).toEqual([]);
        expect(jest.getTimerCount()).toBe(0);
        expect(svc.getStatus().consecutiveInitFailures).toBe(0);
    });

    it('3.11 #5 creds.update from a superseded socket does not call saveCreds; the current socket still does', async () => {
        const { state } = await twoSockets();
        // saveCreds[0] belongs to socket 0's useMultiFileAuthState(), saveCreds[1] to socket 1's.

        emitLate(state, 0, 'creds.update', {});
        await flush();
        expect(state.saveCreds[0]).not.toHaveBeenCalled();
        expect(state.saveCreds[1]).not.toHaveBeenCalled();

        emit(state, 1, 'creds.update', {});
        await flush();
        expect(state.saveCreds[1]).toHaveBeenCalledTimes(1); // its OWN pair, never crossed
        expect(state.saveCreds[0]).not.toHaveBeenCalled();
    });

    it('3.11 closing detaches both listeners from the closed socket', async () => {
        const { state } = await loadUnpaired();

        conn(state, 0, closeWith(408));

        expect(state.sockets[0].handlers['connection.update']).toBeUndefined();
        expect(state.sockets[0].handlers['creds.update']).toBeUndefined();
    });

    it('3.11 the watchdog teardown detaches too: a late event from that socket is inert', async () => {
        const { svc, state } = await loadUnpaired();
        await advance(WATCHDOG_MS);
        expect(state.sockets[0].handlers['connection.update']).toBeUndefined();

        emitLate(state, 0, 'connection.update', { qr: 'stale-qr-from-dead-socket' });

        expect(svc.latestQR).toBeNull();
    });
});

// =============================================================================================
// Spec 3.12 - shutdown mid-connect
// =============================================================================================

describe('spec 3.12: shutdown', () => {
    it('3.12 SIGTERM while connecting: end() (never logout()), timers cleared, exit(0), nothing re-arms', async () => {
        const { svc, state } = await loadPaired();
        expect(svc.getStatus().initializing).toBe(true);

        await signalHandlers.SIGTERM();

        expect(state.sockets[0].end).toHaveBeenCalledWith(undefined);
        expect(state.sockets[0].logout).not.toHaveBeenCalled(); // a redeploy must not unlink the device
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(jest.getTimerCount()).toBe(0); // watchdog and end-timeout both cleared
        expect(state.authFiles.size).toBe(2); // creds untouched

        await svc.initialize({ force: true });
        await advance(WATCHDOG_MS * 2);
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        expect(alertReasons()).toEqual([]); // the cleared watchdog did not fire
    });

    it('3.12 SIGTERM with a reconnect timer pending clears it: no reconnect happens on the way out', async () => {
        const { state } = await loadPaired();
        conn(state, 0, closeWith(408));
        expect(jest.getTimerCount()).toBe(1);

        await signalHandlers.SIGTERM();
        expect(jest.getTimerCount()).toBe(0); // cleared by the shutdown itself, not merely expired

        await advance(LADDER_MS[LADDER_MS.length - 1]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('3.12 SIGTERM on a connected session ends the socket and leaves the device linked', async () => {
        const { state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        await signalHandlers.SIGTERM();

        expect(state.sockets[0].end).toHaveBeenCalledTimes(1);
        expect(state.sockets[0].logout).not.toHaveBeenCalled();
        expect(state.authFiles.size).toBe(2);
        expect(alertReasons()).toEqual([]);
    });

    it('3.12 the close event the shutdown provokes cannot schedule a reconnect (detach first)', async () => {
        const { state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        await signalHandlers.SIGTERM();
        emitLate(state, 0, 'connection.update', closeWith(408));

        expect(jest.getTimerCount()).toBe(0);
        expect(state.sockets[0].handlers['connection.update']).toBeUndefined();
    });

    it('3.12 shutdown is bounded: an end() that never settles still reaches exit(0) after 5s', async () => {
        const { state } = await loadPaired();
        conn(state, 0, { connection: 'open' });
        state.sockEnd.mockReturnValue(new Promise(() => undefined));

        const pending = signalHandlers.SIGTERM();
        await advance(SOCKET_END_TIMEOUT_MS - 1);
        expect(exitSpy).not.toHaveBeenCalled();

        await advance(1);
        await pending;

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('3.12 a second signal during shutdown is ignored: one end(), one exit', async () => {
        const { state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        await Promise.all([signalHandlers.SIGTERM(), signalHandlers.SIGINT(), signalHandlers.SIGTERM()]);

        expect(state.sockets[0].end).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    it('3.12 SIGINT is wired like SIGTERM', async () => {
        const { state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        await signalHandlers.SIGINT();

        expect(state.sockets[0].end).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('3.12 shutdown with no socket at all still exits cleanly', async () => {
        await loadPaired({ authPlan: [new Error('EACCES')] });

        await signalHandlers.SIGTERM();

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('3.12 once shutdown has begun, initialize() is refused at the front door even when forced', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(401)); // stood down: the only thing that could open a socket is initialize()
        await signalHandlers.SIGTERM();

        await svc.initialize();
        await svc.initialize({ force: true });
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });
});
