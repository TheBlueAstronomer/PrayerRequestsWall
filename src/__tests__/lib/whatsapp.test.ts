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
 * S3 spec coverage (section numbers refer to s3-spec.md; describe titles are 'spec 3.N: ...'):
 *   3.1   send while disconnected .............. describe 'spec 3.1: send while disconnected'
 *   3.2   send while connecting ................ describe 'spec 3.2: send while connecting'
 *   3.3   ack before the key (early-ack race) .. describe 'spec 3.3: the ack arrives before the key'
 *   3.4   ack never arrives .................... describe 'spec 3.4: the ack never arrives'
 *   3.5   ERROR status is 0, not "absent" ..... describe 'spec 3.5: an ERROR outcome'
 *   3.6   disconnect mid-send .................. describe 'spec 3.6: disconnect mid-send'
 *   3.7   logout mid-send ...................... describe 'spec 3.7: logout mid-send'
 *   3.8   shutdown mid-send .................... describe 'spec 3.8: shutdown mid-send'
 *   3.9   two concurrent sends ................. describe 'spec 3.9: two concurrent sends'
 *   3.10  the same id acked twice .............. describe 'spec 3.10: the same id acked twice'
 *   3.11  events about messages we never sent .. describe 'spec 3.11: events about messages we never sent'
 *   3.12  group vs direct jid .................. describe 'spec 3.12: group and direct chats'
 *   3.13  listener hygiene, identity guard ..... describe 'spec 3.13: listener hygiene and the identity guard'
 *   3.14  no usable message key ................ describe 'spec 3.14: no usable message key'
 *   3.15  relay rejects / relay deadline ....... describe 'spec 3.15: sock.sendMessage() rejects, and the relay deadline'
 *   3.16  env overrides and content shape ...... describe 'spec 3.16: env overrides and content shape'
 *   facade  sendMessage() arity/Promise/boolean  describe 'frozen facade: sendMessage()'
 *
 * The S3 group-ack finding the whole story turns on (s3-spec.md section 0): for a group jid Baileys
 * never emits a positive `messages.update`, so a send is confirmed by the server's raw
 * `CB:ack,class:message` frame on `sock.ws` alone. Spec 3.12's first test fires no `messages.update`
 * at all; do not "helpfully" add one.
 *
 * Three tests are deliberately white-box (they plant a waiter in the private `pendingSends` map or
 * call the private `teardownSocket()`): the unconditional settle in logout() and shutdown, and the
 * teardownSocket() wiring, guard states the public API cannot construct. Each says so in place.
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
/** How long a send waits for a decisive ack once it has a message id (WA_ACK_TIMEOUT_MS default). */
const ACK_TIMEOUT_MS = 20_000;
/** Ceiling on sock.sendMessage() itself (WA_SEND_RELAY_TIMEOUT_MS default). */
const RELAY_TIMEOUT_MS = 10_000;
/** FIFO bound on outcomes that beat their waiter. */
const MAX_EARLY_ACKS = 200;
/** Backstop on concurrent ack waiters. */
const MAX_PENDING_SENDS = 100;
/** Floor between two send-triggered re-arms. */
const SEND_REARM_MIN_INTERVAL_MS = 60_000;
/** A WhatsApp group jid, the production target. */
const GROUP = '120363000000000000@g.us';
/** A direct chat jid, the resend route's `test` target. */
const DIRECT = '27821234567@s.whatsapp.net';

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
    // Read once at construction, so a stale value from an earlier test would silently retime every send.
    delete process.env.WA_ACK_TIMEOUT_MS;
    delete process.env.WA_SEND_RELAY_TIMEOUT_MS;
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

// --- S3 send helpers ---

/** The WAMessage `sock.sendMessage()` resolves with: the id lives at key.id (a string). */
const sentKey = (id: string, jid: string = GROUP) => ({ key: { id, remoteJid: jid, fromMe: true } });

/** A paired session that has reached 'open', with `sock.sendMessage()` resolving id MSGID1. */
async function loadOpen(opts: LoadOptions = {}) {
    const loaded = await loadPaired(opts);
    conn(loaded.state, 0, { connection: 'open' });
    loaded.state.sockSend.mockResolvedValue(sentKey('MSGID1'));
    return loaded;
}

/** A promise's settlement, observable without awaiting it: `done` flips the moment it settles. */
interface Tracked<T> {
    promise: Promise<T>;
    done: boolean;
    value: T | undefined;
    error: unknown;
}

function track<T>(promise: Promise<T>): Tracked<T> {
    const t: Tracked<T> = { promise, done: false, value: undefined, error: undefined };
    promise.then(
        (v) => {
            t.done = true;
            t.value = v;
        },
        (e: unknown) => {
            t.done = true;
            t.error = e;
        },
    );
    return t;
}

interface ParkedSend {
    /** Settles the parked sock.sendMessage() with the WAMessage it was parked with. */
    release: () => void;
    /** Rejects it instead. */
    fail: (err: Error) => void;
}

/**
 * Parks the NEXT sock.sendMessage() call on a gate: the relay stays in flight until the test
 * releases it. sock.sendMessage() is async, so failures are rejections, never sync throws.
 */
function parkSend(state: MockState, result: unknown): ParkedSend {
    let release!: () => void;
    let fail!: (err: Error) => void;
    const gate = new Promise<unknown>((resolve, reject) => {
        release = () => resolve(result);
        fail = reject;
    });
    state.sockSend.mockReturnValueOnce(gate);
    return { release, fail };
}

/** Baileys' failure when the ws is not open: a Boom 'Connection Closed' carrying 428. */
const connectionClosedBoom = () =>
    Object.assign(new Error('Connection Closed'), { isBoom: true, output: { statusCode: 428 } });

/** Every `[WA:send]` line a console spy has captured (first argument only). */
const sendLines = (spy: jest.SpiedFunction<typeof console.log>): string[] =>
    spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('[WA:send]'));

/** `[WA:send]` lines across log, warn and error: a change in this total means the service said something. */
const totalSendLines = (): number =>
    sendLines(logSpy).length + sendLines(warnSpy).length + sendLines(errorSpy).length;

/** How many captured calls (any first argument) contain `needle`. */
const countLogged = (spy: jest.SpiedFunction<typeof console.log>, needle: string): number =>
    spy.mock.calls.filter((call) => String(call[0]).includes(needle)).length;

/**
 * Proves the service holds neither a stale buffered outcome nor a leaked in-flight count: an ack
 * for an id nobody is waiting on must be DROPPED, so a later send that happens to carry that id
 * times out instead of being "confirmed" by an ack that predates it.
 */
async function expectStrayAckIsDropped(svc: Svc, state: MockState, index = 0) {
    serverAck(state, index, { id: 'GHOST' });
    state.sockSend.mockResolvedValueOnce(sentKey('GHOST'));
    const send = track(svc.sendMessage(GROUP, 'ghost check'));
    await flush();
    expect(send.done).toBe(false);
    await advance(ACK_TIMEOUT_MS);
    expect(send.value).toBe(false);
}

/** The private state a white-box test has to reach; see the tests that use it for why. */
interface ServiceInternals {
    pendingSends: Map<string, (outcome: string) => void>;
    teardownSocket: () => void;
}
const internals = (svc: Svc) => svc as unknown as ServiceInternals;

/**
 * Runs `body` with setTimeout wrapped so every timer handle's unref() is observable. Jest's fake
 * timers cannot say whether the service unref'd a timer; this can. Always restores setTimeout.
 */
async function withUnrefTracking(body: (seen: Array<{ ms: number; unref: jest.Mock }>) => Promise<void>) {
    const g = globalThis as unknown as { setTimeout: (...args: unknown[]) => unknown };
    const original = g.setTimeout;
    const seen: Array<{ ms: number; unref: jest.Mock }> = [];
    g.setTimeout = ((fn: unknown, ms?: number, ...rest: unknown[]) => {
        const handle = original(fn, ms, ...rest) as { unref?: () => unknown };
        const realUnref = handle.unref?.bind(handle);
        const unref = jest.fn(() => realUnref?.());
        handle.unref = unref;
        seen.push({ ms: ms ?? 0, unref });
        return handle;
    }) as never;
    try {
        await body(seen);
    } finally {
        g.setTimeout = original;
    }
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

const ENV_KEYS = [
    'WA_AUTH_PATH',
    'WA_DATA_PATH',
    'WA_LOG_LEVEL',
    'WA_ACK_TIMEOUT_MS',
    'WA_SEND_RELAY_TIMEOUT_MS',
    'npm_lifecycle_event',
];
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

    // Added by the pipeline LEAD after production showed the watchdog killing a healthy
    // socket mid-pairing. An unpaired socket never reaches 'open' by definition — it is
    // waiting for a human — so a QR arriving is the liveness proof, and the watchdog must
    // reset on it rather than cut the pairing window off at 90s from the socket opening.
    it('3.8 a QR resets the watchdog, so a socket being handed fresh QRs is not killed mid-pairing', async () => {
        const { svc, state } = await loadUnpaired();

        // Just short of the deadline, then a fresh QR arrives (as WhatsApp refreshes refs).
        await advance(WATCHDOG_MS - 1);
        conn(state, 0, { qr: 'second-ref' });
        expect(svc.latestQR).toBe('second-ref');

        // Without the reset the watchdog would fire 1ms from here and release the socket.
        await advance(WATCHDOG_MS - 1);
        expect(state.sockets[0].end).not.toHaveBeenCalled();
        expect(svc.getStatus().consecutiveInitFailures).toBe(0);
        expect(svc.latestQR).toBe('second-ref'); // still scannable

        // The watchdog still works: it fires 90s after the LAST sign of life.
        await advance(1);
        expect(state.sockets[0].end).toHaveBeenCalledWith(undefined);
        expect(svc.latestQR).toBeNull();
        expect(alertReasons()).toEqual([]); // unpaired: still no alert
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

// =============================================================================================
// S3 - sending and delivery confirmation (section numbers refer to s3-spec.md)
// =============================================================================================

// ---------------------------------------------------------------------------------------------
// Spec 3.1 - send while disconnected
// ---------------------------------------------------------------------------------------------

describe('spec 3.1: send while disconnected', () => {
    it('3.1 no socket: resolves false, never touches sock.sendMessage, and requests exactly one re-init', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(401)); // stand-down: no socket, no reconnect timer, no backoff window
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        const before = svc.getStatus();

        const result = await svc.sendMessage(GROUP, 'hello');
        await flush();

        expect(result).toBe(false);
        expect(state.sockSend).not.toHaveBeenCalled();
        expect(state.makeWASocket).toHaveBeenCalledTimes(2); // the original plus exactly one re-arm
        expect(logged(warnSpy, `[WA:send] Not connected (ready=false, socket=false). Not sending 5 chars to ${GROUP}.`)).toBe(true);
        expect(logged(logSpy, '[WA:send] Not connected; requesting a re-initialization.')).toBe(true);
        // A send-driven re-arm is not a failure: the readout the admin UI renders must not move.
        expect(svc.getStatus()).toEqual({ ...before, initializing: true });
    });

    it('3.1 five sends in a row while down open at most one socket', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(401));

        const results: boolean[] = [];
        for (let i = 0; i < 5; i++) {
            results.push(await svc.sendMessage(GROUP, `attempt ${i}`));
            await flush();
        }

        expect(results).toEqual([false, false, false, false, false]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        expect(state.sockSend).not.toHaveBeenCalled();
    });

    it('3.1 the re-arm floor: a re-armed socket that is released again is not relaunched inside 60 s, but is once the floor passes', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, closeWith(408)); // nobody scanned: released, no failure rung, no timer
        expect(jest.getTimerCount()).toBe(0);

        await svc.sendMessage(GROUP, 'first');
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(2); // the send-driven re-arm

        conn(state, 1, closeWith(408)); // released again, still no failure rung and no timer
        expect(jest.getTimerCount()).toBe(0);
        for (let i = 0; i < 4; i++) {
            expect(await svc.sendMessage(GROUP, `inside the floor ${i}`)).toBe(false);
            await flush();
        }
        expect(state.makeWASocket).toHaveBeenCalledTimes(2); // traffic alone cannot drive a socket per submission

        await advance(SEND_REARM_MIN_INTERVAL_MS - 1);
        await svc.sendMessage(GROUP, 'one millisecond early');
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);

        await advance(1);
        await svc.sendMessage(GROUP, 'floor passed');
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(3);
    });

    it('3.1 inside a failure-backoff window the re-arm is refused (and does not burn the floor); after it the next send re-arms', async () => {
        const { svc, state } = await loadUnpaired();
        await advance(WATCHDOG_MS); // a stalled unpaired socket: burns rung 1, arms no reconnect timer
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
        expect(jest.getTimerCount()).toBe(0);
        const window = svc.getStatus().nextInitAllowedAt;
        expect(window).toBeGreaterThan(Date.now());

        expect(await svc.sendMessage(GROUP, 'inside the window')).toBe(false);
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(1); // the ladder owns recovery

        await advance(LADDER_MS[0]);
        expect(await svc.sendMessage(GROUP, 'window open')).toBe(false);
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
        // The send-driven re-arm neither extended nor reset the failure ladder the admin UI shows.
        expect(svc.getStatus().nextInitAllowedAt).toBe(window);
        expect(svc.getStatus().consecutiveInitFailures).toBe(1);
    });

    it('3.1 a scheduled reconnect owns recovery: a send while it is pending opens nothing, and the timer opens exactly one socket', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, closeWith(408)); // registered session: transient, reconnect armed
        expect(jest.getTimerCount()).toBe(1);

        const result = await svc.sendMessage(GROUP, 'while a reconnect is pending');
        await flush();

        expect(result).toBe(false);
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1); // the send did not disturb the reconnect timer

        await advance(LADDER_MS[0]);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2); // the timer, and only the timer
    });

    it('3.1 reaching open resets the re-arm floor: a healthy connection makes the earlier throttle stale', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, closeWith(408));
        await svc.sendMessage(GROUP, 'arms the floor');
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);

        conn(state, 1, { connection: 'open' });
        conn(state, 1, closeWith(408)); // an unpaired socket that then drops is released, no timer
        await svc.sendMessage(GROUP, 'straight after a good connection');
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(3);
    });

    it('3.1 logout resets the re-arm floor', async () => {
        const { svc, state } = await loadUnpaired();
        conn(state, 0, closeWith(408));
        await svc.sendMessage(GROUP, 'arms the floor');
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);

        await svc.logout(); // ends socket 1, then its own forced re-arm opens socket 2
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(3);
        conn(state, 2, closeWith(408)); // released
        await svc.sendMessage(GROUP, 'straight after a logout');
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(4);
    });

    it('3.1 once shutdown has begun a send neither sends nor re-arms', async () => {
        const { svc, state } = await loadOpen();
        await signalHandlers.SIGTERM();

        const result = await svc.sendMessage(GROUP, 'too late');
        await flush();

        expect(result).toBe(false);
        expect(state.sockSend).not.toHaveBeenCalled();
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.2 - send while connecting
// ---------------------------------------------------------------------------------------------

describe('spec 3.2: send while connecting', () => {
    it('3.2 socket built but not open: false, the socket untouched, no second socket', async () => {
        const { svc, state } = await loadPaired();
        expect(svc.getStatus().initializing).toBe(true);

        const result = await svc.sendMessage(GROUP, 'hello');
        await flush();

        expect(result).toBe(false);
        expect(state.sockSend).not.toHaveBeenCalled();
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        expect(state.useAuthState).toHaveBeenCalledTimes(1);
        expect(logged(warnSpy, `[WA:send] Not connected (ready=false, socket=true). Not sending 5 chars to ${GROUP}.`)).toBe(true);
        expect(logged(logSpy, 'requesting a re-initialization')).toBe(false); // it returned at the isInitializing guard
    });

    it('3.2 the window between initialize() being called and a socket existing: false, and still only one launch', async () => {
        const gate = deferred();
        const { svc, state } = await loadPaired({ authPlan: [gate] });
        expect(state.makeWASocket).not.toHaveBeenCalled(); // the bootstrap launch is parked in useMultiFileAuthState()
        expect(svc.getStatus().initializing).toBe(true);

        const result = await svc.sendMessage(GROUP, 'hello');
        await flush();

        expect(result).toBe(false);
        expect(state.sockSend).not.toHaveBeenCalled();
        expect(state.useAuthState).toHaveBeenCalledTimes(1);

        gate.resolve();
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(1); // the parked launch completes, and nothing duplicated it
    });

    it('3.2 sends while connecting do not consume the re-arm floor: the first send after a release re-arms at once', async () => {
        const { svc, state } = await loadUnpaired();
        const before = svc.getStatus();

        for (let i = 0; i < 3; i++) expect(await svc.sendMessage(GROUP, `while connecting ${i}`)).toBe(false);
        await flush();
        expect(state.makeWASocket).toHaveBeenCalledTimes(1);
        expect(svc.getStatus()).toEqual(before);

        conn(state, 0, closeWith(408)); // released
        await svc.sendMessage(GROUP, 'after the release');
        await flush();

        expect(state.makeWASocket).toHaveBeenCalledTimes(2); // not blocked by a floor a connecting send should never have set
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.3 - the ack arrives before the message key (the early-ack race)
// ---------------------------------------------------------------------------------------------

describe('spec 3.3: the ack arrives before the key', () => {
    it('3.3 an ack that lands while sock.sendMessage() is still pending resolves true with no ack timer ever armed', async () => {
        const { svc, state } = await loadOpen();
        expect(jest.getTimerCount()).toBe(0);
        const parked = parkSend(state, sentKey('MSGID1'));

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(jest.getTimerCount()).toBe(1); // the relay deadline, nothing else yet

        serverAck(state, 0, { id: 'MSGID1' }); // beats the waiter's registration
        expect(send.done).toBe(false); // still parked at the relay: an ack alone cannot answer a send that has no id yet
        parked.release();
        await flush();

        expect(send.value).toBe(true);
        expect(jest.getTimerCount()).toBe(0); // relay timer cleared in finally; the ack timer never existed
        expect(logged(logSpy, `[WA:send] WhatsApp accepted the message to ${GROUP} (id=MSGID1).`)).toBe(true);
    });

    it('3.3 an early REJECTED outcome resolves false the same way', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        serverAck(state, 0, { id: 'MSGID1', error: '403' });
        parked.release();
        await flush();

        expect(send.value).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
        expect(logged(errorSpy, `[WA:send] WhatsApp REJECTED the message to ${GROUP} (id=MSGID1).`)).toBe(true);
    });

    it('3.3 an early messages.update is buffered too: status 3 accepts, status 0 rejects', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValue(sentKey('DIRECT1', DIRECT));

        const accepted = parkSend(state, sentKey('DIRECT1', DIRECT));
        const okSend = track(svc.sendMessage(DIRECT, 'ok'));
        await flush();
        msgUpdate(state, 0, [{ key: { id: 'DIRECT1' }, update: { status: 3 } }]);
        accepted.release();
        await flush();
        expect(okSend.value).toBe(true);

        const refused = parkSend(state, sentKey('DIRECT2', DIRECT));
        const badSend = track(svc.sendMessage(DIRECT, 'bad'));
        await flush();
        msgUpdate(state, 0, [{ key: { id: 'DIRECT2' }, update: { status: 0 } }]);
        refused.release();
        await flush();
        expect(badSend.value).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('3.3 a rejection overwrites a buffered acceptance: evidence WhatsApp refused it outranks evidence it accepted', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        serverAck(state, 0, { id: 'MSGID1' });
        serverAck(state, 0, { id: 'MSGID1', error: '463' });
        parked.release();
        await flush();

        expect(send.value).toBe(false);
    });

    it('3.3 a buffered rejection is never overwritten by a later acceptance', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        serverAck(state, 0, { id: 'MSGID1', error: '403' });
        serverAck(state, 0, { id: 'MSGID1' });
        msgUpdate(state, 0, [{ key: { id: 'MSGID1' }, update: { status: 3 } }]);
        parked.release();
        await flush();

        expect(send.value).toBe(false);
    });

    it('3.3 with no send in flight an inbound ack is DROPPED, not buffered: 500 of them cannot confirm a later send', async () => {
        const { svc, state } = await loadOpen();
        for (let i = 0; i < 500; i++) serverAck(state, 0, { id: `STRAY${i}` });
        for (let i = 0; i < 500; i++) msgUpdate(state, 0, [{ key: { id: `STRAY${i}` }, update: { status: 3 } }]);
        // The LAST one: were the gate missing, FIFO eviction would still be holding it.
        state.sockSend.mockResolvedValue(sentKey('STRAY499'));

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(send.done).toBe(false); // not confirmed by an ack that predates the send

        await advance(ACK_TIMEOUT_MS);
        expect(send.value).toBe(false);
    });

    it('3.3 a single stray ack before the send is dropped too', async () => {
        const { svc, state } = await loadOpen();
        serverAck(state, 0, { id: 'MSGID1' }); // nothing in flight: somebody else\'s business

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(send.done).toBe(false);

        await advance(ACK_TIMEOUT_MS);
        expect(send.value).toBe(false);
    });

    it('3.3 the early buffer is bounded at 200 with FIFO eviction: the oldest 50 of 250 are forgotten, the newest 200 kept', async () => {
        const { svc, state } = await loadOpen();
        const total = MAX_EARLY_ACKS + 50;
        // E0 and E49 are the two oldest boundary ids (evicted); E50 is the oldest survivor; E249 the newest.
        const probes = ['E0', 'E49', 'E50', `E${total - 1}`];
        const gates = probes.map((id) => parkSend(state, sentKey(id)));
        const sends = probes.map((_, i) => track(svc.sendMessage(GROUP, `probe ${i}`)));
        await flush();

        for (let i = 0; i < total; i++) serverAck(state, 0, { id: `E${i}` });
        gates.forEach((gate) => gate.release());
        await flush();

        // The two survivors confirm from the buffer; the two evicted ones register a waiter and wait.
        expect(sends.map((s) => s.value)).toEqual([undefined, undefined, true, true]);
        await advance(ACK_TIMEOUT_MS);
        expect(sends.map((s) => s.value)).toEqual([false, false, true, true]);
    });

    it('3.3 a detach clears the buffer: an outcome buffered on a dead socket cannot confirm a send on its successor', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, sentKey('OLD'));
        const doomed = track(svc.sendMessage(GROUP, 'in flight when the socket dies'));
        await flush();
        serverAck(state, 0, { id: 'CARRYOVER' }); // buffered: a send is in flight

        conn(state, 0, closeWith(408)); // detach clears the buffer wholesale
        parked.release();
        await flush();
        expect(doomed.value).toBe(false);

        await advance(LADDER_MS[0]);
        conn(state, 1, { connection: 'open' });
        state.sockSend.mockResolvedValue(sentKey('CARRYOVER'));
        const send = track(svc.sendMessage(GROUP, 'on the new socket'));
        await flush();
        expect(send.done).toBe(false);

        await advance(ACK_TIMEOUT_MS);
        expect(send.value).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.4 - the ack never arrives
// ---------------------------------------------------------------------------------------------

describe('spec 3.4: the ack never arrives', () => {
    it('3.4 times out false at exactly the ack budget, naming the id and the timeout', async () => {
        const { svc, state } = await loadOpen();

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(jest.getTimerCount()).toBe(1);

        await advance(ACK_TIMEOUT_MS - 1);
        expect(send.done).toBe(false);
        await advance(1);

        expect(send.value).toBe(false);
        expect(logged(errorSpy, `[WA:send] No acknowledgement from WhatsApp for ${GROUP} (id=MSGID1) within ${ACK_TIMEOUT_MS}ms. Treating as not sent.`)).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        // Nothing waits any more: the next send is unaffected by the corpse of the last.
        await expectStrayAckIsDropped(svc, state);
    });

    it('3.4 sock.sendMessage() resolving is NOT confirmation: a resolved relay with no ack is false (the July shape)', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        expect(state.sockSend).toHaveBeenCalledTimes(1); // the relay has resolved with a key
        expect(send.done).toBe(false); // and that alone must not have answered

        await advance(ACK_TIMEOUT_MS);
        expect(send.value).toBe(false);
    });

    it('3.4 the WAMessage returned by sock.sendMessage() is not evidence: its local status and ack fields settle nothing', async () => {
        // Baileys stamps status PENDING (and here, adversarially, even SERVER_ACK) on the object
        // before the stanza is encrypted. Only events that originate at WhatsApp may settle a send.
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValue({ key: { id: 'MSGID1', remoteJid: GROUP, fromMe: true }, status: 2, ack: 3 });

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(send.done).toBe(false);

        await advance(ACK_TIMEOUT_MS);
        expect(send.value).toBe(false);
    });

    it('3.4 an ack after the timeout does not throw, does not flip the result, and does not linger', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(ACK_TIMEOUT_MS);
        expect(send.value).toBe(false);
        const lines = totalSendLines();

        expect(() => serverAck(state, 0, { id: 'MSGID1' })).not.toThrow();
        expect(() => msgUpdate(state, 0, [{ key: { id: 'MSGID1' }, update: { status: 3 } }])).not.toThrow();
        await flush();

        expect(send.value).toBe(false);
        expect(totalSendLines()).toBe(lines); // not even a log line
        // ... and, having arrived with nothing in flight, it was dropped: a same-id send is not pre-confirmed.
        const again = track(svc.sendMessage(GROUP, 'again'));
        await flush();
        expect(again.done).toBe(false);
        await advance(ACK_TIMEOUT_MS);
        expect(again.value).toBe(false);
    });

    it('3.4 a late ack that DID get buffered (another send in flight) dies with the next detach', async () => {
        const { svc, state } = await loadOpen();
        const first = track(svc.sendMessage(GROUP, 'first'));
        await flush();
        await advance(ACK_TIMEOUT_MS);
        expect(first.value).toBe(false); // MSGID1 timed out

        const parked = parkSend(state, sentKey('MSGID2'));
        const second = track(svc.sendMessage(GROUP, 'second'));
        await flush();
        serverAck(state, 0, { id: 'MSGID1' }); // late, and buffered because `second` is in flight
        parked.release();
        await flush();
        serverAck(state, 0, { id: 'MSGID2' });
        await flush();
        expect(second.value).toBe(true);

        conn(state, 0, closeWith(408)); // the next detach runs
        await advance(LADDER_MS[0]);
        conn(state, 1, { connection: 'open' });
        state.sockSend.mockResolvedValue(sentKey('MSGID1'));
        const third = track(svc.sendMessage(GROUP, 'third'));
        await flush();
        expect(third.done).toBe(false); // the buffered MSGID1 did not survive the detach
        await advance(ACK_TIMEOUT_MS);
        expect(third.value).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.5 - ERROR status (0), the truthiness trap
// ---------------------------------------------------------------------------------------------

describe('spec 3.5: an ERROR outcome', () => {
    it('3.5 a server ack carrying an error attribute (the group failure signal) resolves false and logs a rejection naming the id', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        serverAck(state, 0, { id: 'MSGID1', error: '403' });
        await flush();

        expect(send.value).toBe(false);
        expect(logged(logSpy, '[WA:send] Rejected id=MSGID1 (server ack error=403).')).toBe(true);
        expect(logged(errorSpy, `[WA:send] WhatsApp REJECTED the message to ${GROUP} (id=MSGID1).`)).toBe(true);
        expect(jest.getTimerCount()).toBe(0); // it did not wait out the ack budget
    });

    it('3.5 messages.update with status 0 (ERROR) resolves false and logs a rejection: 0 is NOT "absent"', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValue(sentKey('MSGID1', DIRECT));
        const send = track(svc.sendMessage(DIRECT, 'hello'));
        await flush();

        msgUpdate(state, 0, [{ key: { id: 'MSGID1' }, update: { status: 0 } }]);
        await flush();

        expect(send.value).toBe(false);
        expect(logged(logSpy, '[WA:send] Rejected id=MSGID1 (status=ERROR).')).toBe(true);
        expect(logged(errorSpy, `[WA:send] WhatsApp REJECTED the message to ${DIRECT} (id=MSGID1).`)).toBe(true);
        expect(jest.getTimerCount()).toBe(0); // rejected NOW, not "ignored, then timed out"
    });

    it('3.5 control: status 1 (PENDING) does NOT settle the send, which then times out (and is not called a rejection)', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        msgUpdate(state, 0, [{ key: { id: 'MSGID1' }, update: { status: 1 } }]);
        await flush();
        expect(send.done).toBe(false);

        await advance(ACK_TIMEOUT_MS);
        expect(send.value).toBe(false);
        expect(logged(errorSpy, '[WA:send] No acknowledgement from WhatsApp')).toBe(true);
        expect(logged(errorSpy, 'REJECTED')).toBe(false);
    });

    it('3.5 status 0 after a PENDING is still a rejection', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        msgUpdate(state, 0, [{ key: { id: 'MSGID1' }, update: { status: 1 } }]);
        msgUpdate(state, 0, [{ key: { id: 'MSGID1' }, update: { status: 0 } }]);
        await flush();

        expect(send.value).toBe(false);
        expect(logged(errorSpy, 'REJECTED')).toBe(true);
    });

    it('3.5 a status that arrives as the string "0" is still an ERROR', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        msgUpdate(state, 0, [{ key: { id: 'MSGID1' }, update: { status: '0' } }]);
        await flush();

        expect(send.value).toBe(false);
        expect(logged(errorSpy, 'REJECTED')).toBe(true);
    });

    it.each([2, 3, 4, 5])('3.5 status %i (SERVER_ACK and above) is acceptance: the threshold is >= 2, inclusive', async (status) => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValue(sentKey('MSGID1', DIRECT));
        const send = track(svc.sendMessage(DIRECT, 'hello'));
        await flush();

        msgUpdate(state, 0, [{ key: { id: 'MSGID1' }, update: { status } }]);
        await flush();

        expect(send.value).toBe(true);
        expect(logged(logSpy, `[WA:send] Acknowledged id=MSGID1 (status=${status}).`)).toBe(true);
    });

    it('3.5 an update whose status is absent, null or not a number is not ours to judge: it neither accepts nor rejects', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        msgUpdate(state, 0, [
            { key: { id: 'MSGID1' }, update: {} },
            { key: { id: 'MSGID1' }, update: { status: null } },
            { key: { id: 'MSGID1' }, update: { status: undefined } },
            { key: { id: 'MSGID1' }, update: { status: 'banana' } },
            { key: { id: 'MSGID1' }, update: { status: Number.NaN } },
        ]);
        await flush();
        expect(send.done).toBe(false);

        await advance(ACK_TIMEOUT_MS);
        expect(send.value).toBe(false);
        expect(logged(errorSpy, 'REJECTED')).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.6 - disconnect mid-send
// ---------------------------------------------------------------------------------------------

describe('spec 3.6: disconnect mid-send', () => {
    it.each([408, 428, 500])('3.6 a close (%i) while waiting for the ack fails the send NOW, not after the ack budget', async (code) => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(send.done).toBe(false);
        expect(jest.getTimerCount()).toBe(1); // the ack timer

        conn(state, 0, closeWith(code));
        await flush(); // no advance(): promptness is the point

        expect(send.value).toBe(false);
        expect(logged(warnSpy, `[WA:send] The send to ${GROUP} (id=MSGID1) was abandoned before WhatsApp acknowledged it. Treating as not sent.`)).toBe(true);
        expect(logged(warnSpy, `[WA:send] Settled 1 in-flight send(s) as unconfirmed: the socket closed (statusCode=${code}).`)).toBe(true);
        expect(logged(errorSpy, 'No acknowledgement from WhatsApp')).toBe(false);
        // The ack timer was cleared: what remains is the reconnect timer and nothing else.
        expect(jest.getTimerCount()).toBe(1);
    });

    it('3.6 a 401 close fails the send too, and nothing is left ticking', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        conn(state, 0, closeWith(401));
        await flush();

        expect(send.value).toBe(false);
        expect(jest.getTimerCount()).toBe(0); // stand-down: no reconnect, and the ack timer is gone
    });

    it('3.6 every in-flight send is settled by the one close, and the log says how many', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValueOnce(sentKey('MSGID1')).mockResolvedValueOnce(sentKey('MSGID2'));
        const first = track(svc.sendMessage(GROUP, 'one'));
        const second = track(svc.sendMessage(GROUP, 'two'));
        await flush();
        expect(jest.getTimerCount()).toBe(2);

        conn(state, 0, closeWith(408));
        await flush();

        expect(first.value).toBe(false);
        expect(second.value).toBe(false);
        expect(logged(warnSpy, '[WA:send] Settled 2 in-flight send(s) as unconfirmed: the socket closed (statusCode=408).')).toBe(true);
        expect(jest.getTimerCount()).toBe(1);
    });

    it('3.6 an ack fired at the dead socket afterwards changes nothing', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        conn(state, 0, closeWith(408));
        await flush();
        expect(send.value).toBe(false);
        const lines = totalSendLines();

        lateServerAck(state, 0, { id: 'MSGID1' });
        lateServerAck(state, 0, { id: 'MSGID1', error: '403' });
        emitLate(state, 0, 'messages.update', [{ key: { id: 'MSGID1' }, update: { status: 3 } }]);
        await flush();

        expect(send.value).toBe(false);
        expect(totalSendLines()).toBe(lines);
        expect(logged(logSpy, 'Acknowledged')).toBe(false);
    });

    it('3.6 variant: the socket closes while sock.sendMessage() is still pending: false via the "socket was replaced" branch, no ack timer', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(jest.getTimerCount()).toBe(1); // the relay deadline

        conn(state, 0, closeWith(408)); // nothing is registered to settle yet
        expect(send.done).toBe(false);
        expect(jest.getTimerCount()).toBe(2); // relay deadline + reconnect
        parked.release();
        await flush();

        expect(send.value).toBe(false);
        expect(logged(warnSpy, `[WA:send] The socket was replaced while sending to ${GROUP}; the outcome is unknown. Recording as not sent.`)).toBe(true);
        expect(logged(warnSpy, 'abandoned before WhatsApp acknowledged it')).toBe(false);
        expect(jest.getTimerCount()).toBe(1); // only the reconnect timer: no ack timer was armed for a dead socket
    });

    it('3.6 variant: a send that was mid-relay when the socket closed leaves no in-flight count behind', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        conn(state, 0, closeWith(408));
        parked.release();
        await flush();
        expect(send.value).toBe(false);

        await advance(LADDER_MS[0]);
        conn(state, 1, { connection: 'open' });

        await expectStrayAckIsDropped(svc, state, 1);
    });

    it('3.6 teardownSocket() (the connect-watchdog and post-attach-throw path) settles waiters too', async () => {
        // White-box, and honestly so. Not reachable through the public API: the watchdog is
        // cleared at 'open' and a send needs an open socket, so no waiter can coexist with a
        // teardown today. The waiter is planted through the private map to pin the WIRING: that
        // teardownSocket() funnels through detachSocket(), which is what stops a future path
        // from forgetting to settle.
        const { svc } = await loadOpen();
        const outcomes: string[] = [];
        internals(svc).pendingSends.set('PLANTED', (outcome) => outcomes.push(outcome));

        internals(svc).teardownSocket();

        expect(outcomes).toEqual(['abandoned']);
        expect(internals(svc).pendingSends.size).toBe(0);
        expect(logged(warnSpy, '[WA:send] Settled 1 in-flight send(s) as unconfirmed: the socket was torn down.')).toBe(true);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.7 - logout mid-send
// ---------------------------------------------------------------------------------------------

describe('spec 3.7: logout mid-send', () => {
    it('3.7 logout() fails an in-flight send, resolves true, and still re-arms', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(send.done).toBe(false);

        const result = await svc.logout();
        await flush();

        expect(result).toBe(true);
        expect(send.value).toBe(false);
        expect(logged(warnSpy, '[WA:send] Settled 1 in-flight send(s) as unconfirmed: an admin logout.')).toBe(true);
        expect(logged(warnSpy, 'abandoned before WhatsApp acknowledged it')).toBe(true);
        expect(state.makeWASocket).toHaveBeenCalledTimes(2); // the forced re-arm is unaffected by the pending send
        expect(alertReasons()).toEqual([]);
        expect(jest.getTimerCount()).toBe(1); // only the re-armed socket's connect watchdog: no ack timer survived
    });

    it('3.7 the settle is logged once: the second, unconditional call in logout() finds nothing and says nothing', async () => {
        const { svc } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        await svc.logout();
        await flush();

        expect(send.value).toBe(false);
        expect(countLogged(warnSpy, 'Settled')).toBe(1);
    });

    it('3.7 with the real library\'s ordering (the loggedOut close lands DURING sock.logout()) the send is still failed and the alert stays suppressed', async () => {
        const { svc, state } = await loadOpen();
        state.sockLogout.mockImplementation(async () => {
            conn(state, 0, closeWith(401)); // what Baileys does: logout() ends the socket and the close fires
        });
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        const result = await svc.logout();
        await flush();

        expect(result).toBe(true);
        expect(send.value).toBe(false);
        expect(logged(warnSpy, 'Settled 1 in-flight send(s) as unconfirmed: the socket closed (statusCode=401)')).toBe(true);
        expect(logged(logSpy, 'Intentional admin logout')).toBe(true);
        expect(alertReasons()).toEqual([]); // intentionalLogout suppressed wa_session_lost
    });

    it('3.7 logout() stays bounded by SOCKET_END_TIMEOUT_MS: a pending send neither delays it nor waits out its own 20 s', async () => {
        const { svc, state } = await loadOpen();
        state.sockLogout.mockReturnValue(new Promise(() => undefined)); // sock.logout() never settles
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        const logout = track(svc.logout());
        await advance(SOCKET_END_TIMEOUT_MS - 1);
        expect(logout.done).toBe(false);

        await advance(1);
        expect(logout.value).toBe(true); // 5 s, not 5 s plus anything a send contributed
        expect(send.value).toBe(false); // and the send did not have to run out its 20 s budget
        expect(state.makeWASocket).toHaveBeenCalledTimes(2);
    });

    it('3.7 logout() after a 401 stand-down (this.sock is null) still settles anything left waiting', async () => {
        // White-box, and honestly so. After a stand-down no waiter can exist (the close already
        // settled them all), so the unconditional settle in logout() is a backstop for a state the
        // public API cannot construct. The waiter is planted to prove the backstop is wired, since
        // the detach inside logout() is skipped when there is no socket.
        const { svc, state } = await loadOpen();
        conn(state, 0, closeWith(401));
        const outcomes: string[] = [];
        internals(svc).pendingSends.set('PLANTED', (outcome) => outcomes.push(outcome));

        const result = await svc.logout();
        await flush();

        expect(result).toBe(true);
        expect(outcomes).toEqual(['abandoned']);
        expect(logged(warnSpy, '[WA:send] Settled 1 in-flight send(s) as unconfirmed: an admin logout.')).toBe(true);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.8 - shutdown mid-send
// ---------------------------------------------------------------------------------------------

describe('spec 3.8: shutdown mid-send', () => {
    it('3.8 SIGTERM with a send in flight: the send is false, the handler still reaches exit(0), no timer survives', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(jest.getTimerCount()).toBe(1);

        await signalHandlers.SIGTERM();

        expect(send.value).toBe(false);
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(jest.getTimerCount()).toBe(0);
        expect(state.sockets[0].end).toHaveBeenCalledTimes(1);
        expect(logged(warnSpy, '[WA:send] Settled 1 in-flight send(s) as unconfirmed: SIGTERM shutdown.')).toBe(true);
        expect(countLogged(warnSpy, 'Settled')).toBe(1); // the unconditional second call found nothing
    });

    it('3.8 SIGINT is wired the same way', async () => {
        const { svc } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        await signalHandlers.SIGINT();

        expect(send.value).toBe(false);
        expect(logged(warnSpy, 'unconfirmed: SIGINT shutdown')).toBe(true);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('3.8 the send is settled BEFORE the socket is ended: an end() that never settles does not hold it for 5 s', async () => {
        const { svc, state } = await loadOpen();
        state.sockEnd.mockReturnValue(new Promise(() => undefined));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        const shutdown = signalHandlers.SIGTERM();
        await flush(); // no advance()

        expect(send.value).toBe(false);
        expect(exitSpy).not.toHaveBeenCalled(); // still waiting on end()

        await advance(SOCKET_END_TIMEOUT_MS);
        await shutdown;
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('3.8 a send that was mid-relay at shutdown resolves false through the "socket was replaced" branch', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        await signalHandlers.SIGTERM();
        parked.release();
        await flush();

        expect(send.value).toBe(false);
        expect(logged(warnSpy, 'The socket was replaced while sending')).toBe(true);
        expect(jest.getTimerCount()).toBe(0); // no ack timer for a process that is exiting
    });

    it('3.8 the ack and relay timers are both unref()d, so a pending send cannot hold the event loop open through a shutdown', async () => {
        const { svc, state } = await loadOpen();

        await withUnrefTracking(async (seen) => {
            const send = track(svc.sendMessage(GROUP, 'hello'));
            await flush();

            const relay = seen.filter((t) => t.ms === RELAY_TIMEOUT_MS);
            const ack = seen.filter((t) => t.ms === ACK_TIMEOUT_MS);
            expect(relay).toHaveLength(1);
            expect(ack).toHaveLength(1);
            expect(relay[0].unref).toHaveBeenCalled();
            expect(ack[0].unref).toHaveBeenCalled();

            serverAck(state, 0, { id: 'MSGID1' });
            await flush();
            expect(send.value).toBe(true);
        });
    });

    it('3.8 shutdown after a 401 stand-down (this.sock is null) still settles anything left waiting, and exits', async () => {
        // White-box for the same reason as the logout() twin: the settle sits outside the
        // `if (sock)` precisely because the socket can already be gone, and the state that would
        // exercise it is not constructible through the public API.
        const { svc, state } = await loadOpen();
        conn(state, 0, closeWith(401));
        const outcomes: string[] = [];
        internals(svc).pendingSends.set('PLANTED', (outcome) => outcomes.push(outcome));

        await signalHandlers.SIGTERM();

        expect(outcomes).toEqual(['abandoned']);
        expect(logged(warnSpy, '[WA:send] Settled 1 in-flight send(s) as unconfirmed: SIGTERM shutdown.')).toBe(true);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.9 - two concurrent sends
// ---------------------------------------------------------------------------------------------

describe('spec 3.9: two concurrent sends', () => {
    it('3.9 acking only MSGID2 resolves the second true while the first keeps waiting, then times out false', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValueOnce(sentKey('MSGID1')).mockResolvedValueOnce(sentKey('MSGID2'));

        const first = track(svc.sendMessage(GROUP, 'to group one'));
        const second = track(svc.sendMessage(GROUP, 'to group two'));
        await flush();
        expect(state.sockSend.mock.calls.map((call) => call[1])).toEqual([
            { text: 'to group one', linkPreview: null },
            { text: 'to group two', linkPreview: null },
        ]);

        serverAck(state, 0, { id: 'MSGID2' });
        await flush();
        expect(second.value).toBe(true);
        expect(first.done).toBe(false); // outcomes are not crossed

        await advance(ACK_TIMEOUT_MS);
        expect(first.value).toBe(false);
        expect(second.value).toBe(true);
    });

    it('3.9 acking both in reverse order resolves both true', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValueOnce(sentKey('MSGID1')).mockResolvedValueOnce(sentKey('MSGID2'));
        const first = track(svc.sendMessage(GROUP, 'one'));
        const second = track(svc.sendMessage(GROUP, 'two'));
        await flush();

        serverAck(state, 0, { id: 'MSGID2' });
        serverAck(state, 0, { id: 'MSGID1' });
        await flush();

        expect(first.value).toBe(true);
        expect(second.value).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('3.9 a rejection of one send does not touch its neighbour', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValueOnce(sentKey('MSGID1')).mockResolvedValueOnce(sentKey('MSGID2'));
        const first = track(svc.sendMessage(GROUP, 'one'));
        const second = track(svc.sendMessage(GROUP, 'two'));
        await flush();

        serverAck(state, 0, { id: 'MSGID1', error: '403' });
        serverAck(state, 0, { id: 'MSGID2' });
        await flush();

        expect(first.value).toBe(false);
        expect(second.value).toBe(true);
    });

    it('3.9 one messages.update carrying two ids settles both waiters', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValueOnce(sentKey('MSGID1', DIRECT)).mockResolvedValueOnce(sentKey('MSGID2', DIRECT));
        const first = track(svc.sendMessage(DIRECT, 'one'));
        const second = track(svc.sendMessage(DIRECT, 'two'));
        await flush();

        msgUpdate(state, 0, [
            { key: { id: 'MSGID1' }, update: { status: 2 } },
            { key: { id: 'MSGID2' }, update: { status: 0 } },
        ]);
        await flush();

        expect(first.value).toBe(true);
        expect(second.value).toBe(false);
    });

    it('3.9 the pending-send cap: the 100th send is admitted, the 101st is shed at once, and a slot frees when one settles', async () => {
        const { svc, state } = await loadOpen();
        let n = 0;
        state.sockSend.mockImplementation(async () => sentKey(`M${n++}`));

        const sends: Array<Tracked<boolean>> = [];
        for (let i = 0; i < MAX_PENDING_SENDS - 1; i++) sends.push(track(svc.sendMessage(GROUP, `m${i}`)));
        await flush(); // 99 waiters registered
        sends.push(track(svc.sendMessage(GROUP, 'the hundredth')));
        await flush();
        expect(state.sockSend).toHaveBeenCalledTimes(MAX_PENDING_SENDS); // admitted: 99 pending is below the cap
        expect(sends.every((s) => !s.done)).toBe(true);

        const shed = await svc.sendMessage(GROUP, 'one too many');

        expect(shed).toBe(false);
        expect(state.sockSend).toHaveBeenCalledTimes(MAX_PENDING_SENDS); // never reached the socket
        expect(logged(errorSpy, `[WA:send] ${MAX_PENDING_SENDS} sends already awaiting acknowledgement (cap ${MAX_PENDING_SENDS}). Shedding this one.`)).toBe(true);

        serverAck(state, 0, { id: 'M0' });
        await flush();
        expect(sends[0].value).toBe(true);
        const next = track(svc.sendMessage(GROUP, 'now it fits'));
        await flush();
        expect(state.sockSend).toHaveBeenCalledTimes(MAX_PENDING_SENDS + 1);
        expect(next.done).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.10 - the same message id acked twice
// ---------------------------------------------------------------------------------------------

describe('spec 3.10: the same id acked twice', () => {
    it('3.10 a second ack, and a later ERROR, for a settled id: no throw, the result stays true, nothing lingers', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        serverAck(state, 0, { id: 'MSGID1' });
        await flush();
        expect(send.value).toBe(true);
        const lines = totalSendLines();

        expect(() => serverAck(state, 0, { id: 'MSGID1' })).not.toThrow();
        expect(() => msgUpdate(state, 0, [{ key: { id: 'MSGID1' }, update: { status: 0 } }])).not.toThrow();
        expect(() => serverAck(state, 0, { id: 'MSGID1', error: '403' })).not.toThrow();
        await flush();

        expect(send.value).toBe(true);
        expect(send.error).toBeUndefined();
        expect(totalSendLines()).toBe(lines);
        expect(jest.getTimerCount()).toBe(0);
        // The duplicates arrived with nothing in flight and were dropped, not kept for later.
        const again = track(svc.sendMessage(GROUP, 'same id again'));
        await flush();
        expect(again.done).toBe(false);
        await advance(ACK_TIMEOUT_MS);
        expect(again.value).toBe(false);
    });

    it('3.10 an ack delivered twice in the same tick settles once', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        serverAck(state, 0, { id: 'MSGID1' });
        serverAck(state, 0, { id: 'MSGID1' });
        await flush();

        expect(send.value).toBe(true);
        expect(countLogged(logSpy, '[WA:send] Acknowledged id=MSGID1')).toBe(1);
        expect(countLogged(logSpy, 'WhatsApp accepted the message')).toBe(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('3.10 in the same tick the FIRST outcome wins: accept then reject is true, reject then accept is false', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValueOnce(sentKey('MSGID1')).mockResolvedValueOnce(sentKey('MSGID2'));
        const acceptedFirst = track(svc.sendMessage(GROUP, 'a'));
        const rejectedFirst = track(svc.sendMessage(GROUP, 'b'));
        await flush();

        serverAck(state, 0, { id: 'MSGID1' });
        serverAck(state, 0, { id: 'MSGID1', error: '403' });
        serverAck(state, 0, { id: 'MSGID2', error: '403' });
        serverAck(state, 0, { id: 'MSGID2' });
        await flush();

        expect(acceptedFirst.value).toBe(true);
        expect(rejectedFirst.value).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.11 - a status update for a message we never sent
// ---------------------------------------------------------------------------------------------

describe('spec 3.11: events about messages we never sent', () => {
    it('3.11 a foreign ack and a foreign status update with no send in flight: no throw, no log, nothing buffered', async () => {
        const { svc, state } = await loadOpen();

        expect(() => serverAck(state, 0, { id: 'SOMEONE-ELSES' })).not.toThrow();
        expect(() => msgUpdate(state, 0, [{ key: { id: 'X' }, update: { status: 2 } }])).not.toThrow();
        expect(() => msgUpdate(state, 0, [{ key: { id: 'Y' }, update: { status: 0 } }])).not.toThrow();

        expect(errorSpy).not.toHaveBeenCalled(); // no error-level noise
        expect(totalSendLines()).toBe(0); // and no info-level chatter either
        // Nothing buffered: a later send that happens to carry one of those ids is not pre-confirmed.
        for (const id of ['SOMEONE-ELSES', 'X', 'Y']) {
            state.sockSend.mockResolvedValueOnce(sentKey(id));
            const send = track(svc.sendMessage(GROUP, 'hello'));
            await flush();
            expect(send.done).toBe(false);
            await advance(ACK_TIMEOUT_MS);
            expect(send.value).toBe(false);
        }
    });

    it('3.11 then a real send to a different id behaves normally', async () => {
        const { svc, state } = await loadOpen();
        serverAck(state, 0, { id: 'SOMEONE-ELSES' });
        msgUpdate(state, 0, [{ key: { id: 'X' }, update: { status: 2 } }]);

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        serverAck(state, 0, { id: 'MSGID1' });
        await flush();

        expect(send.value).toBe(true);
    });

    it('3.11 a foreign id, while a send IS waiting, settles nothing and says nothing', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        const lines = totalSendLines();

        serverAck(state, 0, { id: 'SOMEONE-ELSES' });
        serverAck(state, 0, { id: 'SOMEONE-ELSES', error: '403' });
        msgUpdate(state, 0, [{ key: { id: 'X' }, update: { status: 3 } }, { key: { id: 'Y' }, update: { status: 0 } }]);
        await flush();

        expect(send.done).toBe(false);
        expect(totalSendLines()).toBe(lines);
        serverAck(state, 0, { id: 'MSGID1' });
        await flush();
        expect(send.value).toBe(true);
    });

    it.each<[string, unknown]>([
        ['a non-array object shaped like one update', { key: { id: 'MSGID1' }, update: { status: 2 } }],
        ['null', null],
        ['undefined', undefined],
        ['a string', 'MSGID1'],
        ['a number', 2],
        ['an empty array', []],
    ])('3.11 a messages.update payload that is %s is ignored without throwing', async (_label, payload) => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        expect(() => msgUpdate(state, 0, payload)).not.toThrow();
        await flush();

        expect(send.done).toBe(false);
        serverAck(state, 0, { id: 'MSGID1' });
        await flush();
        expect(send.value).toBe(true);
    });

    it('3.11 garbage elements inside a messages.update array are skipped, and a valid one in the same array is still honoured', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        // Every one of these is malformed or not decisive; none may settle the send or abort the loop.
        expect(() =>
            msgUpdate(state, 0, [
                null,
                undefined,
                42,
                'MSGID1',
                {},
                { key: null },
                { key: {} },
                { key: { id: null }, update: { status: 2 } },
                { key: { id: '' }, update: { status: 2 } },
                { key: { id: 'MSGID1' } },
                { key: { id: 'MSGID1' }, update: null },
                { key: { id: 'MSGID1' }, update: {} },
                { key: { id: 'MSGID1' }, update: { status: 1 } },
            ]),
        ).not.toThrow();
        await flush();
        expect(send.done).toBe(false);

        msgUpdate(state, 0, [null, { key: { id: 'MSGID1' }, update: { status: 2 } }]); // garbage FIRST, then the real one
        await flush();
        expect(send.value).toBe(true);
    });

    it.each<[string, unknown]>([
        ['undefined', undefined],
        ['null', null],
        ['an empty object', {}],
        ['a node with undefined attrs', { attrs: undefined }],
        ['a node with empty attrs', { attrs: {} }],
        ['a node with an empty id', { attrs: { id: '' } }],
        ['an error ack with no id at all', { attrs: { error: '403' } }],
    ])('3.11 a server ack node that is %s is ignored without throwing', async (_label, node) => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        expect(() => wsEmit(state, 0, WA_ACK_EVENT, node)).not.toThrow();
        await flush();

        expect(send.done).toBe(false);
        serverAck(state, 0, { id: 'MSGID1' });
        await flush();
        expect(send.value).toBe(true);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.12 - group vs direct jid
// ---------------------------------------------------------------------------------------------

describe('spec 3.12: group and direct chats', () => {
    it('3.12 a GROUP send confirms on the server ack ALONE: no messages.update is ever fired', async () => {
        // messages.update never carries a positive status for a group (Baileys routes group receipts
        // to message-receipt.update). The plan's original wording, "SERVER_ACK on messages.update",
        // would have reported false for every group send forever. Nothing here fires one.
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValue(sentKey('MSGID1', GROUP));
        // Make "no messages.update was fired" a machine-checked fact of this test, not a reviewer's
        // memory: route the live messages.update listener through a spy that must stay untouched.
        const updateListeners = state.sockets[0].handlers['messages.update'];
        const messagesUpdateSpy = jest.fn(updateListeners[0]);
        updateListeners[0] = messagesUpdateSpy;

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(send.done).toBe(false);

        serverAck(state, 0, { id: 'MSGID1', from: GROUP });
        await flush();

        expect(messagesUpdateSpy).not.toHaveBeenCalled(); // the ack alone did it
        expect(send.value).toBe(true);
        expect(state.sockSend).toHaveBeenCalledWith(GROUP, { text: 'hello', linkPreview: null });
        expect(logged(logSpy, '[WA:send] Acknowledged id=MSGID1 (server ack).')).toBe(true);
        expect(logged(logSpy, `[WA:send] WhatsApp accepted the message to ${GROUP} (id=MSGID1).`)).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('3.12 the one thing messages.update can say about a group is a failure: status 0 rejects the send', async () => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        // The one thing messages.update can legitimately tell us about a group: a bad ack.
        msgUpdate(state, 0, [{ key: { id: 'MSGID1', remoteJid: GROUP, fromMe: true }, update: { status: 0 } }]);
        await flush();

        expect(send.value).toBe(false);
    });

    it('3.12 DIRECT chat: the server ack alone confirms', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValue(sentKey('MSGID1', DIRECT));
        const send = track(svc.sendMessage(DIRECT, 'hello'));
        await flush();

        serverAck(state, 0, { id: 'MSGID1', from: DIRECT });
        await flush();

        expect(send.value).toBe(true);
    });

    it('3.12 DIRECT chat: messages.update status 3 (DELIVERY_ACK, above the threshold) alone confirms', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValue(sentKey('MSGID1', DIRECT));
        const send = track(svc.sendMessage(DIRECT, 'hello'));
        await flush();

        msgUpdate(state, 0, [{ key: { id: 'MSGID1', remoteJid: DIRECT, fromMe: true }, update: { status: 3 } }]);
        await flush();

        expect(send.value).toBe(true);
        expect(logged(logSpy, '[WA:send] Acknowledged id=MSGID1 (status=3).')).toBe(true);
    });

    it.each<[string, Record<string, string | undefined>]>([
        ['an LID-form from', { from: '184467440737095@lid' }],
        ['a different chat jid', { from: '120363999999999999@g.us' }],
        ['no from at all', { from: undefined }],
    ])('3.12 matching is on the message id only: an ack with %s still confirms', async (_label, attrs) => {
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        wsEmit(state, 0, WA_ACK_EVENT, { tag: 'ack', attrs: { id: 'MSGID1', class: 'message', ...attrs } });
        await flush();

        expect(send.value).toBe(true);
    });

    it('3.12 the service listens to exactly the signals it trusts: never the local echo, never a per-participant receipt', async () => {
        // messages.upsert would be Baileys' own local echo (the July bug with a new name), and
        // message-receipt.update is one participant's device (deliberately not subscribed).
        const { state } = await loadOpen();

        expect(Object.keys(state.sockets[0].everRegistered).sort()).toEqual([
            'connection.update',
            'creds.update',
            'messages.update',
        ]);
        expect(Object.keys(state.sockets[0].wsEverRegistered)).toEqual([WA_ACK_EVENT]);
        expect(state.sockets[0].wsEverRegistered[WA_ACK_EVENT]).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.13 - listener hygiene and the identity guard
// ---------------------------------------------------------------------------------------------

describe('spec 3.13: listener hygiene and the identity guard', () => {
    /** Socket 0 dies, the reconnect timer opens socket 1 and it reaches 'open'. Returns the loaded service. */
    async function reconnected() {
        const loaded = await loadOpen();
        conn(loaded.state, 0, closeWith(408));
        await advance(LADDER_MS[0]);
        expect(loaded.state.sockets).toHaveLength(2);
        conn(loaded.state, 1, { connection: 'open' });
        return loaded;
    }

    it('3.13 after a close, ws.off was called with the exact registered handler, and messages.update listeners were removed', async () => {
        const { state } = await loadOpen();
        const handler = state.sockets[0].wsEverRegistered[WA_ACK_EVENT][0];
        expect(state.sockets[0].wsHandlers[WA_ACK_EVENT]).toEqual([handler]);

        conn(state, 0, closeWith(408));

        const { ws, ev } = state.sockets[0].sock;
        expect(ws.off).toHaveBeenCalledTimes(1);
        expect(ws.off).toHaveBeenCalledWith(WA_ACK_EVENT, handler);
        expect(state.sockets[0].wsHandlers[WA_ACK_EVENT]).toBeUndefined();
        expect(ev.removeAllListeners).toHaveBeenCalledWith('messages.update');
        expect(ev.removeAllListeners).toHaveBeenCalledWith('connection.update');
        expect(ev.removeAllListeners).toHaveBeenCalledWith('creds.update');
        expect(state.sockets[0].handlers['messages.update']).toBeUndefined();
    });

    it('3.13 only OUR ack listener is removed: Baileys\' own handler on the same event survives, and removeAllListeners is never used on ws', async () => {
        const { state } = await loadOpen();
        const baileysOwn = jest.fn();
        state.sockets[0].sock.ws.on(WA_ACK_EVENT, baileysOwn); // Baileys registers its bad-ack handler on the same event

        conn(state, 0, closeWith(408));

        expect(state.sockets[0].wsHandlers[WA_ACK_EVENT]).toEqual([baileysOwn]);
        expect(state.sockets[0].sock.ws.removeAllListeners).not.toHaveBeenCalled();
    });

    it.each<[string, (loaded: Awaited<ReturnType<typeof loadOpen>>) => Promise<void>]>([
        ['a close', async ({ state }) => conn(state, 0, closeWith(408))],
        ['a 401 stand-down', async ({ state }) => conn(state, 0, closeWith(401))],
        ['an admin logout', async ({ svc }) => void (await svc.logout())],
        ['a SIGTERM shutdown', async () => signalHandlers.SIGTERM()],
    ])('3.13 %s detaches the ack listener with the exact handler', async (_label, drop) => {
        const loaded = await loadOpen();
        const handler = loaded.state.sockets[0].wsEverRegistered[WA_ACK_EVENT][0];

        await drop(loaded);
        await flush();

        expect(loaded.state.sockets[0].sock.ws.off).toHaveBeenCalledWith(WA_ACK_EVENT, handler);
        expect(loaded.state.sockets[0].wsHandlers[WA_ACK_EVENT]).toBeUndefined();
        expect(loaded.state.sockets[0].sock.ev.removeAllListeners).toHaveBeenCalledWith('messages.update');
    });

    it('3.13 the connect-watchdog teardown detaches the ack listener too', async () => {
        const { state } = await loadPaired(); // never reaches open
        const handler = state.sockets[0].wsEverRegistered[WA_ACK_EVENT][0];
        expect(state.sockets[0].wsHandlers[WA_ACK_EVENT]).toEqual([handler]);

        await advance(WATCHDOG_MS);

        expect(state.sockets[0].sock.ws.off).toHaveBeenCalledWith(WA_ACK_EVENT, handler);
        expect(state.sockets[0].wsHandlers[WA_ACK_EVENT]).toBeUndefined();
        expect(state.sockets[0].sock.ev.removeAllListeners).toHaveBeenCalledWith('messages.update');
    });

    it('3.13 no listener accumulates across reconnects: every dead socket is bare, the live one has exactly one of each', async () => {
        const { state } = await loadOpen();
        for (let cycle = 0; cycle < 3; cycle++) {
            conn(state, cycle, closeWith(408));
            await advance(LADDER_MS[0]);
            conn(state, cycle + 1, { connection: 'open' });
        }

        expect(state.sockets).toHaveLength(4);
        for (let i = 0; i < 3; i++) {
            expect(state.sockets[i].wsHandlers[WA_ACK_EVENT]).toBeUndefined();
            expect(state.sockets[i].handlers['messages.update']).toBeUndefined();
        }
        expect(state.sockets[3].wsHandlers[WA_ACK_EVENT]).toHaveLength(1);
        expect(state.sockets[3].handlers['messages.update']).toHaveLength(1);
    });

    it('3.13 events delivered to a SUPERSEDED socket change nothing: no send settles and no line is logged', async () => {
        const { svc, state } = await reconnected();
        state.sockSend.mockResolvedValue(sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(send.done).toBe(false);
        const lines = totalSendLines();
        const infoLines = logSpy.mock.calls.length;

        lateServerAck(state, 0, { id: 'MSGID1' });
        lateServerAck(state, 0, { id: 'MSGID1', error: '403' });
        emitLate(state, 0, 'messages.update', [{ key: { id: 'MSGID1' }, update: { status: 3 } }]);
        emitLate(state, 0, 'messages.update', [{ key: { id: 'MSGID1' }, update: { status: 0 } }]);
        await flush();

        expect(send.done).toBe(false);
        expect(totalSendLines()).toBe(lines);
        expect(logSpy.mock.calls.length).toBe(infoLines);

        serverAck(state, 1, { id: 'MSGID1' }); // the CURRENT socket still works
        await flush();
        expect(send.value).toBe(true);
    });

    it('3.13 a superseded socket\'s late ack cannot be buffered either', async () => {
        const { svc, state } = await reconnected();
        const parked = parkSend(state, sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello')); // in flight, so a live ack WOULD be buffered
        await flush();

        lateServerAck(state, 0, { id: 'MSGID1' });
        parked.release();
        await flush();

        expect(send.done).toBe(false); // not pre-confirmed by the dead socket's ack
        await advance(ACK_TIMEOUT_MS);
        expect(send.value).toBe(false);
    });

    it('3.13 a socket that exposes no ws emitter is reported loudly and never throws: a group send can only time out, a direct one still confirms on status', async () => {
        const { svc, state } = await loadOpen();
        const build = state.makeWASocket.getMockImplementation() as (options: Record<string, unknown>) => { ws?: unknown };
        state.makeWASocket.mockImplementation((options: Record<string, unknown>) => {
            const built = build(options);
            built.ws = undefined; // Baileys always has one; this pins the defensive branch
            return built;
        });
        conn(state, 0, closeWith(408));

        await advance(LADDER_MS[0]);
        conn(state, 1, { connection: 'open' });

        expect(errorSpy).toHaveBeenCalledWith(
            '[WA:send] Socket exposes no ws emitter; server acks cannot be observed and every send will report as unconfirmed.',
        );
        const group = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(ACK_TIMEOUT_MS);
        expect(group.value).toBe(false); // never true without evidence

        state.sockSend.mockResolvedValue(sentKey('MSGID2', DIRECT));
        const direct = track(svc.sendMessage(DIRECT, 'hello'));
        await flush();
        msgUpdate(state, 1, [{ key: { id: 'MSGID2' }, update: { status: 3 } }]);
        await flush();
        expect(direct.value).toBe(true);

        expect(() => conn(state, 1, closeWith(408))).not.toThrow(); // detach copes with no handler to remove
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.14 - sock.sendMessage() resolves with no usable key
// ---------------------------------------------------------------------------------------------

describe('spec 3.14: no usable message key', () => {
    it.each<[string, unknown]>([
        ['undefined', undefined],
        ['null', null],
        ['an empty object', {}],
        ['a key with no id', { key: {} }],
        ['a key with a null id', { key: { id: null } }],
        ['a key with an empty id', { key: { id: '' } }],
    ])('3.14 sock.sendMessage() resolving %s is a loud false, arms no ack timer, and leaves nothing behind', async (_label, resolved) => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValue(resolved);

        const result = await svc.sendMessage(GROUP, 'hello');

        expect(result).toBe(false);
        expect(logged(errorSpy, `[WA:send] sock.sendMessage() returned no message key for ${GROUP}; delivery cannot be confirmed. Recording as not sent.`)).toBe(true);
        expect(jest.getTimerCount()).toBe(0); // the relay timer was cleared and no ack timer was ever armed
        await expectStrayAckIsDropped(svc, state); // and the in-flight count came back to zero
    });

    it('3.14 the harness default (a socket that resolves undefined) is this case', async () => {
        const { svc, state } = await loadPaired();
        conn(state, 0, { connection: 'open' });

        expect(await svc.sendMessage(GROUP, 'hello')).toBe(false);
        expect(logged(errorSpy, 'returned no message key')).toBe(true);
    });

    it('3.14 a resolved relay is never taken as success on its own: no ack, no true', async () => {
        const { svc, state } = await loadOpen();
        state.sockSend.mockResolvedValue({ status: 2, ack: 3, key: {} }); // looks acknowledged, has no id

        expect(await svc.sendMessage(GROUP, 'hello')).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.15 - sock.sendMessage() rejects, and the relay deadline
// ---------------------------------------------------------------------------------------------

describe('spec 3.15: sock.sendMessage() rejects, and the relay deadline', () => {
    it('3.15 a Boom "Connection Closed" (428) rejection: false, exactly one error log, no timer left', async () => {
        const { svc, state } = await loadOpen();
        const boom = connectionClosedBoom();
        state.sockSend.mockRejectedValue(boom); // sock.sendMessage() is async: it rejects, it never throws synchronously

        const result = await svc.sendMessage(GROUP, 'hello');

        expect(result).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(`[WA:send] sock.sendMessage() failed for ${GROUP}:`, boom);
        expect(sendLines(errorSpy)).toHaveLength(1);
        expect(jest.getTimerCount()).toBe(0);
        await expectStrayAckIsDropped(svc, state);
    });

    it('3.15 a plain TypeError (the malformed-jid path inside relayMessage): false, and it never escapes as a rejection', async () => {
        const { svc, state } = await loadOpen();
        const typeError = new TypeError("Cannot destructure property 'user' of 'jidDecode(...)' as it is undefined.");
        state.sockSend.mockRejectedValue(typeError);

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        expect(send.error).toBeUndefined();
        expect(send.value).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(`[WA:send] sock.sendMessage() failed for ${GROUP}:`, typeError);
    });

    it('3.15 a relay that never settles is abandoned at exactly the relay deadline: false', async () => {
        const { svc, state } = await loadOpen();
        parkSend(state, sentKey('MSGID1'));

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(RELAY_TIMEOUT_MS - 1);
        expect(send.done).toBe(false);
        await advance(1);

        expect(send.value).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(
            `[WA:send] sock.sendMessage() failed for ${GROUP}:`,
            expect.objectContaining({ message: `sock.sendMessage() did not settle within ${RELAY_TIMEOUT_MS}ms` }),
        );
        expect(jest.getTimerCount()).toBe(0); // no ack timer: the send never got an id
        await expectStrayAckIsDropped(svc, state);
    });

    it('3.15 if the abandoned relay later succeeds, an operator is told, and the return value stays false', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(RELAY_TIMEOUT_MS);
        expect(send.value).toBe(false);

        parked.release();
        await flush();

        expect(logged(errorSpy, `[WA:send] A send to ${GROUP} completed AFTER its ${RELAY_TIMEOUT_MS}ms deadline (id=MSGID1). It is recorded as NOT sent; the group may show it.`)).toBe(true);
        expect(send.value).toBe(false);
        expect(jest.getTimerCount()).toBe(0); // and it did not start an ack wait for a send already reported
    });

    it('3.15 a late success that carries no id is reported as id=unknown', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, undefined);
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(RELAY_TIMEOUT_MS);
        expect(send.value).toBe(false);

        parked.release();
        await flush();

        expect(logged(errorSpy, '(id=unknown)')).toBe(true);
    });

    it('3.15 if the abandoned relay later REJECTS it is handled and logged (it cannot become an unhandledRejection)', async () => {
        const { svc, state } = await loadOpen();
        const parked = parkSend(state, sentKey('MSGID1'));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(RELAY_TIMEOUT_MS);
        expect(send.value).toBe(false);

        parked.fail(new Error('late boom'));
        await flush();

        expect(warnSpy).toHaveBeenCalledWith(`[WA:send] The abandoned send to ${GROUP} later failed:`, expect.objectContaining({ message: 'late boom' }));
        expect(send.value).toBe(false);
    });

    it.each(['not-a-jid', '', '120363000000000000'])('3.15 a malformed chat id %j (no "@") returns false WITHOUT calling sock.sendMessage', async (chatId) => {
        const { svc, state } = await loadOpen();

        const result = await svc.sendMessage(chatId, 'hello');

        expect(result).toBe(false);
        expect(state.sockSend).not.toHaveBeenCalled();
        expect(logged(errorSpy, `[WA:send] Refusing to send: "${chatId}" is not a WhatsApp jid (expected user@s.whatsapp.net or id@g.us).`)).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        await expectStrayAckIsDropped(svc, state);
    });

    it('3.15 the routes\' own inputs are accepted: a group jid and a direct jid both reach the socket', async () => {
        const { svc, state } = await loadOpen();
        const g = track(svc.sendMessage(GROUP, 'hello'));
        const d = track(svc.sendMessage(DIRECT, 'hello'));
        await flush();

        expect(state.sockSend.mock.calls.map((call) => call[0])).toEqual([GROUP, DIRECT]);
        expect(g.done).toBe(false);
        expect(d.done).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------
// Spec 3.16 - env overrides and content shape
// ---------------------------------------------------------------------------------------------

describe('spec 3.16: env overrides and content shape', () => {
    it('3.16 WA_ACK_TIMEOUT_MS=1000 is honoured', async () => {
        const { svc } = await loadOpen({ env: { WA_ACK_TIMEOUT_MS: '1000' } });

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(999);
        expect(send.done).toBe(false);
        await advance(1);

        expect(send.value).toBe(false);
        expect(logged(errorSpy, `[WA:send] No acknowledgement from WhatsApp for ${GROUP} (id=MSGID1) within 1000ms.`)).toBe(true);
    });

    it.each(['0', 'abc', ''])('3.16 WA_ACK_TIMEOUT_MS=%j falls back to 20 000, not to an instant timeout', async (value) => {
        const { svc } = await loadOpen({ env: { WA_ACK_TIMEOUT_MS: value } });

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(ACK_TIMEOUT_MS - 1);
        expect(send.done).toBe(false);
        await advance(1);

        expect(send.value).toBe(false);
        expect(logged(errorSpy, `within ${ACK_TIMEOUT_MS}ms.`)).toBe(true);
    });

    it('3.16 WA_SEND_RELAY_TIMEOUT_MS=1000 is honoured', async () => {
        const { svc, state } = await loadOpen({ env: { WA_SEND_RELAY_TIMEOUT_MS: '1000' } });
        parkSend(state, sentKey('MSGID1'));

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(999);
        expect(send.done).toBe(false);
        await advance(1);

        expect(send.value).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(
            `[WA:send] sock.sendMessage() failed for ${GROUP}:`,
            expect.objectContaining({ message: 'sock.sendMessage() did not settle within 1000ms' }),
        );
    });

    it.each(['0', 'abc', ''])('3.16 WA_SEND_RELAY_TIMEOUT_MS=%j falls back to 10 000, not to an instant failure', async (value) => {
        const { svc, state } = await loadOpen({ env: { WA_SEND_RELAY_TIMEOUT_MS: value } });
        parkSend(state, sentKey('MSGID1'));

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(RELAY_TIMEOUT_MS - 1);
        expect(send.done).toBe(false);
        await advance(1);

        expect(send.value).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(
            `[WA:send] sock.sendMessage() failed for ${GROUP}:`,
            expect.objectContaining({ message: `sock.sendMessage() did not settle within ${RELAY_TIMEOUT_MS}ms` }),
        );
    });

    it('3.16 the two overrides are independent: a short ack budget does not shorten the relay deadline', async () => {
        const { svc, state } = await loadOpen({ env: { WA_ACK_TIMEOUT_MS: '1000' } });
        const parked = parkSend(state, sentKey('MSGID1'));

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(RELAY_TIMEOUT_MS - 1); // far beyond the 1 s ack budget, but the relay has 10 s
        expect(send.done).toBe(false);

        parked.release();
        await flush();
        expect(send.done).toBe(false); // now the 1 s ack budget starts
        await advance(1000);
        expect(send.value).toBe(false);
    });

    // Added by the pipeline LEAD after the S3 review (risk 5). A NEGATIVE value is
    // truthy, so it survives the `|| DEFAULT` and used to yield a timer that fires
    // immediately: every send would report a timeout while messages arrived fine — the
    // July failure shape, reachable by one operator typo.
    it.each([['-5'], ['-20000'], ['1e-9']])(
        '3.16 WA_ACK_TIMEOUT_MS=%s is floored at 1s instead of timing out instantly',
        async (value) => {
            const { svc, state } = await loadOpen({ env: { WA_ACK_TIMEOUT_MS: value } });
            state.sockSend.mockResolvedValue(sentKey('MSGID1', GROUP));
            const send = track(svc.sendMessage(GROUP, 'hello'));
            await flush();

            // Not settled before the floor...
            await advance(999);
            expect(send.done).toBe(false);
            // ...and an ack arriving inside the floor still confirms it.
            serverAck(state, 0, { id: 'MSGID1', from: GROUP });
            await flush();
            expect(send.value).toBe(true);
        },
    );

    it('3.16 a negative WA_SEND_RELAY_TIMEOUT_MS is floored too, so an in-flight relay is not abandoned at once', async () => {
        // The relay must be PARKED for this to discriminate. A mockResolvedValue relay wins
        // the Promise.race as a microtask no matter how small the timer is, so that version
        // of this test passed even with the floor removed — it could not fail.
        const { svc, state } = await loadOpen({ env: { WA_SEND_RELAY_TIMEOUT_MS: '-1' } });
        const parked = parkSend(state, sentKey('MSGID1', GROUP));
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();

        // Unfloored, setTimeout(-1) fires on the next tick and abandons the relay.
        await advance(999);
        expect(send.done).toBe(false);

        parked.release();
        await flush();
        serverAck(state, 0, { id: 'MSGID1', from: GROUP });
        await flush();
        expect(send.value).toBe(true);
    });

    it('3.16 env from an earlier test does not leak: a fresh load sees the defaults again', async () => {
        expect(process.env.WA_ACK_TIMEOUT_MS).toBeUndefined();
        expect(process.env.WA_SEND_RELAY_TIMEOUT_MS).toBeUndefined();

        const { svc } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await advance(ACK_TIMEOUT_MS - 1);
        expect(send.done).toBe(false);
        await advance(1);
        expect(send.value).toBe(false);
    });

    it('3.16 sock.sendMessage() is called with exactly (chatId, { text, linkPreview: null }): a URL in a prayer must not make the box fetch it', async () => {
        const { svc, state } = await loadOpen();
        const message = '🙏 *New Anonymous Request:* please pray, see https://example.com/some/page?x=1';

        const send = track(svc.sendMessage(GROUP, message));
        await flush();

        expect(state.sockSend).toHaveBeenCalledTimes(1);
        expect(state.sockSend).toHaveBeenCalledWith(GROUP, { text: message, linkPreview: null });
        const [chat, content] = state.sockSend.mock.calls[0] as [string, Record<string, unknown>];
        expect(state.sockSend.mock.calls[0]).toHaveLength(2); // no third "options" argument
        expect(chat).toBe(GROUP);
        expect(content.linkPreview).toBeNull(); // null, not undefined and not false: undefined is what triggers the fetch
        expect(Object.keys(content).sort()).toEqual(['linkPreview', 'text']); // nothing else rides along
        expect(content.text).toBe(message); // verbatim: not trimmed, not re-encoded

        serverAck(state, 0, { id: 'MSGID1' });
        await flush();
        expect(send.value).toBe(true);
    });

    it('3.16 the content shape is the same for a direct chat and for text with newlines', async () => {
        const { svc, state } = await loadOpen();
        const message = 'line one\nline two\n\nhttp://plain.example/';

        void svc.sendMessage(DIRECT, message);
        await flush();

        expect(state.sockSend).toHaveBeenCalledWith(DIRECT, { text: message, linkPreview: null });
    });
});

// ---------------------------------------------------------------------------------------------
// Frozen facade: sendMessage()
// ---------------------------------------------------------------------------------------------

describe('frozen facade: sendMessage()', () => {
    it('is a two-argument method that always returns a Promise', async () => {
        const { svc, state } = await loadOpen();

        expect(svc.sendMessage.length).toBe(2);
        const accepted = svc.sendMessage(GROUP, 'hello');
        expect(accepted).toBeInstanceOf(Promise);
        await flush();
        serverAck(state, 0, { id: 'MSGID1' });
        await flush();
        expect(await accepted).toBe(true);

        conn(state, 0, closeWith(401));
        const notConnected = svc.sendMessage(GROUP, 'hello');
        expect(notConnected).toBeInstanceOf(Promise);
        expect(await notConnected).toBe(false);
    });

    it('resolves the boolean true ONLY on a real acceptance, never a truthy object (the routes test `!sent`)', async () => {
        // api/submit and api/admin/prayers/resend write whatsappSent = true whenever the result is
        // truthy. The relay returning a (truthy) WAMessage must therefore never leak out as the result.
        const { svc, state } = await loadOpen();
        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        expect(send.done).toBe(false); // the relay resolved with a truthy object and nothing was returned

        serverAck(state, 0, { id: 'MSGID1' });
        await flush();

        expect(send.value).toBe(true);
        expect(typeof send.value).toBe('boolean');
    });

    it.each<[string, (state: MockState) => void, (state: MockState) => Promise<void>]>([
        [
            'sock.sendMessage() rejecting',
            (state) => void state.sockSend.mockRejectedValue(connectionClosedBoom()),
            async () => undefined,
        ],
        [
            'sock.sendMessage() resolving no key',
            (state) => void state.sockSend.mockResolvedValue(undefined),
            async () => undefined,
        ],
        [
            'a server ack carrying an error',
            () => undefined,
            async (state) => serverAck(state, 0, { id: 'MSGID1', error: '403' }),
        ],
        ['an ack timeout', () => undefined, async () => advance(ACK_TIMEOUT_MS)],
    ])('every failure resolves the boolean false and never rejects: %s', async (_label, arrange, act) => {
        const { svc, state } = await loadOpen();
        arrange(state);

        const send = track(svc.sendMessage(GROUP, 'hello'));
        await flush();
        await act(state);
        await flush();

        expect(send.error).toBeUndefined(); // a rejection would 500 a submission whose row is already written
        expect(send.value).toBe(false); // strictly false: not undefined, not null, not an object
    });

    it('getStatus() gains no field from S3', async () => {
        const { svc, state } = await loadOpen();
        void svc.sendMessage(GROUP, 'hello');
        await flush();
        serverAck(state, 0, { id: 'MSGID1' });
        await flush();

        expect(Object.keys(svc.getStatus()).sort()).toEqual(
            ['connected', 'consecutiveInitFailures', 'hasQr', 'initializing', 'nextInitAllowedAt'],
        );
    });
});
