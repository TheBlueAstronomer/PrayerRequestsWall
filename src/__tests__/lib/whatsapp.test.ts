/**
 * WhatsAppService unit tests.
 *
 * Strategy: each test uses jest.isolateModules() to load a fresh copy of the
 * module so the singleton is reset. Mock factories capture the event handlers
 * registered by createClient() so we can fire them in tests.
 */

// ─── Per-module mock state (reset by jest.isolateModules) ────────────────────

type EventHandlers = Record<string, ((...args: unknown[]) => void)>;

interface MockState {
    handlers: EventHandlers;
    initialize: jest.Mock;
    destroy: jest.Mock;
    logout: jest.Mock;
    sendMessage: jest.Mock;
    removeAllListeners: jest.Mock;
    clientOptions: Array<Record<string, unknown>>;
    /** Every client the module constructed, in order, with its own handler table. */
    clients: Array<{ handlers: EventHandlers; removeAllListeners: jest.Mock }>;
    pathJoin: jest.Mock;
    fsExists: jest.Mock;
    fsRm: jest.Mock;
}

function createMockState(): MockState {
    return {
        handlers: {},
        initialize: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
        logout: jest.fn().mockResolvedValue(undefined),
        // Default: WhatsApp acks the message as reaching the server (ACK_SERVER).
        sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'msg-default' }, ack: 1 }),
        removeAllListeners: jest.fn(),
        clientOptions: [],
        clients: [],
        pathJoin: jest.fn((...args: string[]) => args.join('/')),
        fsExists: jest.fn().mockReturnValue(false),
        fsRm: jest.fn(),
    };
}

/**
 * Loads a fresh WhatsAppService instance using jest.isolateModules so the
 * singleton globalThis.whatsappGlobal is reset each call.
 */
async function loadFreshService(applyState?: (s: MockState) => void) {
    const state = createMockState();
    if (applyState) applyState(state);

    // clear the global singleton so the module re-creates it
    delete (globalThis as Record<string, unknown>).whatsappGlobal;
    delete process.env.npm_lifecycle_event;

    let svc: { latestQR: string | null; sendMessage: (c: string, m: string) => Promise<boolean>; logout: () => Promise<boolean>; initialize: () => Promise<void>; isConnected: () => boolean };

    await jest.isolateModulesAsync(async () => {
        jest.doMock('whatsapp-web.js', () => ({
            Client: jest.fn().mockImplementation((options: Record<string, unknown>) => {
                // Each client keeps its OWN handler table, so a test can prove that a
                // replaced client no longer holds listeners into the service.
                const handlers: EventHandlers = {};
                const instance = {
                    handlers,
                    on: (event: string, handler: (...args: unknown[]) => void) => {
                        handlers[event] = handler;
                        state.handlers[event] = handler; // latest-wins view, for convenience
                    },
                    removeAllListeners: jest.fn(() => {
                        for (const key of Object.keys(handlers)) delete handlers[key];
                        state.removeAllListeners();
                    }),
                    initialize: state.initialize,
                    destroy: state.destroy,
                    logout: state.logout,
                    sendMessage: state.sendMessage,
                };
                state.clientOptions.push(options);
                state.clients.push(instance);
                return instance;
            }),
            LocalAuth: jest.fn().mockReturnValue({}),
        }));

        jest.doMock('fs', () => ({
            existsSync: state.fsExists,
            rmSync: state.fsRm,
        }));

        jest.doMock('path', () => ({
            join: state.pathJoin,
        }));

        const mod = await import('@/lib/whatsapp');
        svc = mod.whatsappService;
    });

    return { svc: svc!, state };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WhatsAppService — event handlers', () => {
    it('sets latestQR when qr event fires', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['qr']?.('mock-qr-string');
        expect(svc.latestQR).toBe('mock-qr-string');
    });

    it('clears latestQR when ready event fires', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['qr']?.('some-qr');
        state.handlers['ready']?.();
        expect(svc.latestQR).toBeNull();
    });

    it('clears latestQR on authenticated event', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['qr']?.('qr-code');
        state.handlers['authenticated']?.();
        expect(svc.latestQR).toBeNull();
    });

    it('resets latestQR to null on disconnected event (was already null after ready)', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        state.handlers['disconnected']?.('LOGOUT');
        expect(svc.latestQR).toBeNull();
    });
});

describe('WhatsAppService — sendMessage()', () => {
    it('returns false and does not call client.sendMessage when not ready', async () => {
        const { svc, state } = await loadFreshService();
        const result = await svc.sendMessage('123@g.us', 'Hello');
        expect(result).toBe(false);
        expect(state.sendMessage).not.toHaveBeenCalled();
    });

    it('returns true and calls client.sendMessage when ready', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();

        const result = await svc.sendMessage('123@g.us', 'Hello');
        expect(result).toBe(true);
        expect(state.sendMessage).toHaveBeenCalledWith('123@g.us', 'Hello');
    });

    it('returns false when client.sendMessage throws', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        state.sendMessage.mockRejectedValueOnce(new Error('network error'));

        const result = await svc.sendMessage('123@g.us', 'Boom');
        expect(result).toBe(false);
    });

    it('triggers re-initialization when not ready and not initializing', async () => {
        const { svc, state } = await loadFreshService();
        // constructor already called initialize once; disconnect to reset isInitializing
        state.handlers['disconnected']?.('LOGOUT');
        const callsBefore = state.initialize.mock.calls.length;

        await svc.sendMessage('123@g.us', 'Test');
        expect(state.initialize.mock.calls.length).toBeGreaterThan(callsBefore);
    });
});

describe('WhatsAppService — sendMessage() delivery acknowledgement', () => {
    /** Lets the awaited client.sendMessage() settle so the ack wait is registered. */
    const flush = () => new Promise(r => setTimeout(r, 0));

    it('returns true once WhatsApp acks the message as reaching the server', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        // Queued (ack 0) — delivery is only confirmed by the later message_ack event.
        state.sendMessage.mockResolvedValueOnce({ id: { _serialized: 'm1' }, ack: 0 });

        const pending = svc.sendMessage('123@g.us', 'Hello');
        await flush();
        state.handlers['message_ack']?.({ id: { _serialized: 'm1' } }, 1);

        await expect(pending).resolves.toBe(true);
    });

    it('returns false when WhatsApp rejects the message (ACK_ERROR)', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        state.sendMessage.mockResolvedValueOnce({ id: { _serialized: 'm2' }, ack: 0 });

        const pending = svc.sendMessage('bad@g.us', 'Hello');
        await flush();
        state.handlers['message_ack']?.({ id: { _serialized: 'm2' } }, -1);

        await expect(pending).resolves.toBe(false);
    });

    it('returns false when the message is only queued and never acked (the silent-drop bug)', async () => {
        process.env.WA_ACK_TIMEOUT_MS = '50';
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        // Resolves like a normal send, but WhatsApp never acks it — previously
        // this was reported as "sent successfully".
        state.sendMessage.mockResolvedValueOnce({ id: { _serialized: 'm3' }, ack: 0 });

        await expect(svc.sendMessage('stale@g.us', 'Hello')).resolves.toBe(false);
        delete process.env.WA_ACK_TIMEOUT_MS;
    });

    it('keeps waiting through non-decisive acks before confirming', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        state.sendMessage.mockResolvedValueOnce({ id: { _serialized: 'm4' }, ack: 0 });

        const pending = svc.sendMessage('123@g.us', 'Hello');
        await flush();
        // ACK_PENDING must not settle the send...
        state.handlers['message_ack']?.({ id: { _serialized: 'm4' } }, 0);
        // ...but ACK_DEVICE must.
        state.handlers['message_ack']?.({ id: { _serialized: 'm4' } }, 2);

        await expect(pending).resolves.toBe(true);
    });

    it('ignores acks for unrelated messages', async () => {
        process.env.WA_ACK_TIMEOUT_MS = '50';
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        state.sendMessage.mockResolvedValueOnce({ id: { _serialized: 'mine' }, ack: 0 });

        const pending = svc.sendMessage('123@g.us', 'Hello');
        await flush();
        state.handlers['message_ack']?.({ id: { _serialized: 'someone-elses' } }, 1);

        await expect(pending).resolves.toBe(false);
        delete process.env.WA_ACK_TIMEOUT_MS;
    });

    it('still confirms delivery when the ack arrives before the waiter is registered', async () => {
        process.env.WA_ACK_TIMEOUT_MS = '50';
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();

        // Fire the ack from inside client.sendMessage(), i.e. before sendMessage()
        // has had a chance to register its waiter. A delivered message must not
        // be reported as a timeout.
        state.sendMessage.mockImplementationOnce(async () => {
            state.handlers['message_ack']?.({ id: { _serialized: 'race' } }, 1);
            return { id: { _serialized: 'race' }, ack: 0 };
        });

        await expect(svc.sendMessage('123@g.us', 'Hello')).resolves.toBe(true);
        delete process.env.WA_ACK_TIMEOUT_MS;
    });

    it('returns false when the client returns no message id to track', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        state.sendMessage.mockResolvedValueOnce(undefined);

        await expect(svc.sendMessage('123@g.us', 'Hello')).resolves.toBe(false);
    });

    it('stops waiting for an ack if the client disconnects mid-send', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        state.sendMessage.mockResolvedValueOnce({ id: { _serialized: 'm5' }, ack: 0 });

        const pending = svc.sendMessage('123@g.us', 'Hello');
        await flush();
        state.handlers['disconnected']?.('LOGOUT');

        await expect(pending).resolves.toBe(false);
    });
});

describe('WhatsAppService — initialize()', () => {
    it('skips re-init when already ready', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        const callsBefore = state.initialize.mock.calls.length;
        await svc.initialize();
        expect(state.initialize.mock.calls.length).toBe(callsBefore);
    });

    it('calls client.initialize when not ready and not currently initializing', async () => {
        const { svc, state } = await loadFreshService();
        // Wait for constructor's async initialize to settle
        await new Promise(r => setTimeout(r, 0));
        // Simulate disconnect to reset isInitializing flag
        state.handlers['disconnected']?.('LOGOUT');

        const callsBefore = state.initialize.mock.calls.length;
        await svc.initialize();
        expect(state.initialize.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('handles client.initialize() rejection gracefully without throwing', async () => {
        const { svc, state } = await loadFreshService();
        await new Promise(r => setTimeout(r, 0));
        state.handlers['disconnected']?.('LOGOUT');
        state.initialize.mockRejectedValueOnce(new Error('init failed'));

        await expect(svc.initialize()).resolves.toBeUndefined();
    });
});

describe('WhatsAppService — logout()', () => {
    it('calls client.logout() and destroy() when ready, resets state, returns true', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();

        const result = await svc.logout();

        expect(state.logout).toHaveBeenCalled();
        expect(state.destroy).toHaveBeenCalled();
        expect(svc.latestQR).toBeNull();
        expect(result).toBe(true);
    });

    it('skips client.logout() when not ready, still calls destroy(), returns true', async () => {
        const { svc, state } = await loadFreshService();
        // isReady is false — logout() on the client should be skipped
        const result = await svc.logout();

        expect(state.logout).not.toHaveBeenCalled();
        expect(state.destroy).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    it('continues and returns true even if client.logout() throws', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        state.logout.mockRejectedValueOnce(new Error('already logged out'));

        const result = await svc.logout();
        expect(result).toBe(true);
        expect(state.destroy).toHaveBeenCalled();
    });

    it('continues and returns true even if client.destroy() throws', async () => {
        const { svc, state } = await loadFreshService();
        state.destroy.mockRejectedValueOnce(new Error('destroy failed'));

        const result = await svc.logout();
        expect(result).toBe(true);
    });

    it('re-creates a new client after logout', async () => {
        // We verify that initialize is called again (on the new client)
        const { svc, state } = await loadFreshService();
        const initCallsBefore = state.initialize.mock.calls.length;

        await svc.logout();

        // After logout a new Client is created and initialize() is called on it
        expect(state.initialize.mock.calls.length).toBeGreaterThan(initCallsBefore);
    });
});

describe('WhatsAppService — client replacement (listener leak)', () => {
    it('detaches the old client listeners when logout() swaps in a new client', async () => {
        const { svc, state } = await loadFreshService();
        const oldClient = state.clients[0];
        expect(oldClient.handlers['qr']).toBeDefined();

        await svc.logout();

        expect(state.clients.length).toBe(2);
        expect(oldClient.removeAllListeners).toHaveBeenCalled();
        // The replaced client must hold no listeners into the service.
        expect(oldClient.handlers['qr']).toBeUndefined();
        expect(oldClient.handlers['disconnected']).toBeUndefined();
    });

    it('a replaced client can no longer overwrite latestQR', async () => {
        // The production bug: the old client stayed subscribed and kept emitting
        // 'qr' into the shared latestQR alongside its replacement, so the QR shown
        // in the admin UI was often the dead client's and scanning it did nothing.
        const { svc, state } = await loadFreshService();
        const oldClient = state.clients[0];

        await svc.logout();
        const newClient = state.clients[1];

        newClient.handlers['qr']?.('qr-from-live-client');
        // The old client is detached: it has no handler left to fire.
        expect(oldClient.handlers['qr']).toBeUndefined();
        expect(svc.latestQR).toBe('qr-from-live-client');
    });

    it('a late disconnect from the replaced client cannot clear a healthy session', async () => {
        const { svc, state } = await loadFreshService();
        const oldClient = state.clients[0];

        await svc.logout();
        const newClient = state.clients[1];
        newClient.handlers['ready']?.();

        // In production the old client's LOGOUT disconnect landed minutes later and
        // reset isReady on the new, healthy session. It now has no handler to fire.
        expect(oldClient.handlers['disconnected']).toBeUndefined();

        const result = await svc.sendMessage('123@g.us', 'still connected');
        expect(result).toBe(true);
    });
});

describe('WhatsAppService — session-lost alert', () => {
    /** True if any console.error carried the stable alert token. */
    function alerted(spy: jest.SpyInstance): boolean {
        return spy.mock.calls.flat().some(a => typeof a === 'string' && a.includes('wa_session_lost'));
    }

    it('emits the alert on an involuntary LOGOUT disconnect', async () => {
        const { state } = await loadFreshService();
        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        state.handlers['disconnected']?.('LOGOUT');
        expect(alerted(spy)).toBe(true);
        spy.mockRestore();
    });

    it('emits the alert on auth_failure', async () => {
        const { state } = await loadFreshService();
        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        state.handlers['auth_failure']?.('session invalidated');
        expect(alerted(spy)).toBe(true);
        spy.mockRestore();
    });

    it('does NOT alert on a non-logout disconnect (e.g. NAVIGATION)', async () => {
        const { state } = await loadFreshService();
        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        state.handlers['disconnected']?.('NAVIGATION');
        expect(alerted(spy)).toBe(false);
        spy.mockRestore();
    });

    it('suppresses the alert for an admin-initiated logout()', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        // The real client.logout() emits a LOGOUT `disconnected`; mirror that so the
        // suppression path (intentionalLogout flag) is exercised end-to-end.
        state.logout.mockImplementationOnce(async () => {
            state.handlers['disconnected']?.('LOGOUT');
        });
        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        await svc.logout();
        expect(alerted(spy)).toBe(false);
        spy.mockRestore();
    });

    it('alerts again on a later involuntary logout after an intentional one (flag is one-shot)', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        state.logout.mockImplementationOnce(async () => {
            state.handlers['disconnected']?.('LOGOUT');
        });
        await svc.logout(); // consumes the intentional flag

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        // A fresh, involuntary logout on the new client must alert.
        state.handlers['disconnected']?.('LOGOUT');
        expect(alerted(spy)).toBe(true);
        spy.mockRestore();
    });

    it('isConnected() reflects the ready state', async () => {
        const { svc, state } = await loadFreshService();
        expect(svc.isConnected()).toBe(false);
        state.handlers['ready']?.();
        expect(svc.isConnected()).toBe(true);
        state.handlers['disconnected']?.('LOGOUT');
        expect(svc.isConnected()).toBe(false);
    });
});

describe('WhatsAppService — qrMaxRetries', () => {
    it('bounds QR retries instead of respawning Chromium forever', async () => {
        const { state } = await loadFreshService();
        const qrMaxRetries = state.clientOptions[0].qrMaxRetries as number;

        // 0 means "unlimited" in whatsapp-web.js — the infinite-Chromium bug.
        expect(qrMaxRetries).toBeGreaterThan(0);
        expect(Number.isFinite(qrMaxRetries)).toBe(true);
    });

    it('honours WA_QR_MAX_RETRIES', async () => {
        process.env.WA_QR_MAX_RETRIES = '3';
        const { state } = await loadFreshService();
        expect(state.clientOptions[0].qrMaxRetries).toBe(3);
        delete process.env.WA_QR_MAX_RETRIES;
    });

    it('drops the expired QR and re-arms a clean client when retries run out', async () => {
        const { svc, state } = await loadFreshService();
        const oldClient = state.clients[0];
        state.handlers['qr']?.('a-qr-nobody-scanned');
        expect(svc.latestQR).toBe('a-qr-nobody-scanned');

        // whatsapp-web.js destroys the client and emits this once qrMaxRetries is hit.
        oldClient.handlers['disconnected']?.('Max qrcode retries reached');

        expect(svc.latestQR).toBeNull();
        expect(oldClient.removeAllListeners).toHaveBeenCalled();
        expect(state.clients.length).toBe(2);
    });

    it('does not re-arm the client on an ordinary disconnect', async () => {
        const { state } = await loadFreshService();
        const clientsBefore = state.clients.length;

        state.handlers['disconnected']?.('NAVIGATION');

        expect(state.clients.length).toBe(clientsBefore);
    });
});

describe('WhatsAppService — lock file helpers', () => {
    it('clearStaleLock removes lock file if it exists', async () => {
        const { state } = await loadFreshService(s => s.fsExists.mockReturnValue(true));
        // constructor calls initialize() which calls clearStaleLock()
        expect(state.fsRm).toHaveBeenCalled();
    });

    it('clearStaleLock does nothing if lock file is absent', async () => {
        const { state } = await loadFreshService(s => s.fsExists.mockReturnValue(false));
        expect(state.fsRm).not.toHaveBeenCalled();
    });

    it('waitForLockRelease resolves immediately when lock is absent', async () => {
        const { svc, state } = await loadFreshService(s => s.fsExists.mockReturnValue(false));
        await expect(svc.logout()).resolves.toBe(true);
        // rmSync should not be called during lock-release wait (lock was absent)
        const rmCalls = state.fsRm.mock.calls.length;
        expect(rmCalls).toBe(0);
    });

    it('waitForLockRelease force-removes lock after timeout', async () => {
        // Fake timers must be active before the module is loaded so the
        // setTimeout inside waitForLockRelease is also faked.
        jest.useFakeTimers();

        const { svc, state } = await loadFreshService(s => {
            // Lock always present → triggers timeout path in waitForLockRelease
            s.fsExists.mockReturnValue(true);
        });

        // fsRm was already called once by clearStaleLock during init; reset count
        state.fsRm.mockClear();

        // Start logout (which internally awaits waitForLockRelease)
        const logoutPromise = svc.logout();

        // Pump the 200ms polling loop past the 10000ms timeout
        for (let i = 0; i < 60; i++) {
            jest.advanceTimersByTime(200);
            await Promise.resolve();
        }

        await logoutPromise;

        expect(state.fsRm).toHaveBeenCalled();
        jest.useRealTimers();
    }, 15000);
});

describe('WhatsAppService — WA_DATA_PATH env', () => {
    it('uses WA_DATA_PATH env when set', async () => {
        process.env.WA_DATA_PATH = '/custom/path';
        const { state } = await loadFreshService();
        expect(state.pathJoin).toHaveBeenCalledWith('/custom/path', 'session', 'SingletonLock');
        delete process.env.WA_DATA_PATH;
    });

    it('falls back to ./.wwebjs_auth when WA_DATA_PATH is not set', async () => {
        delete process.env.WA_DATA_PATH;
        const { state } = await loadFreshService();
        expect(state.pathJoin).toHaveBeenCalledWith('./.wwebjs_auth', 'session', 'SingletonLock');
    });
});

// ─── New tests: backoff ladder + browser discard (Chromium-leak fix) ─────────
//
// Harness note: Jest 30's fake timers also fake Date.now(), and the backoff
// ladder compares against Date.now(). Every test below that drives the ladder
// therefore calls jest.useFakeTimers() BEFORE loadFreshService() — same
// constraint as the "waitForLockRelease force-removes lock after timeout"
// test above.

/**
 * Drains pending microtasks — e.g. the constructor's fire-and-forget bootstrap
 * initialize() call — without depending on real timers, which fake timers do
 * not advance on their own.
 */
async function flushMicrotasks(times = 5) {
    for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * loadFreshService()'s local `svc` type pins initialize() to a zero-arg
 * signature (matching how most existing tests call it). These tests need the
 * real `{ force?: boolean }` signature — cast narrowly here (the underlying
 * object, and thus `this` inside the real method, is unchanged) rather than
 * widening the shared helper's type declaration.
 */
function withForce(svc: { initialize: () => Promise<void> }): { initialize: (opts?: { force?: boolean }) => Promise<void> } {
    return svc as unknown as { initialize: (opts?: { force?: boolean }) => Promise<void> };
}

describe('WhatsAppService — init backoff', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('after a failed init, a plain initialize() is blocked until the backoff window elapses, then proceeds', async () => {
        jest.useFakeTimers();
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        state.initialize.mockRejectedValueOnce(new Error('boom'));
        await svc.initialize(); // 1st failure -> 5s backoff window opens

        const callsAfterFailure = state.initialize.mock.calls.length;

        // Still inside the window: a plain (non-forced) call is a silent no-op.
        await svc.initialize();
        expect(state.initialize.mock.calls.length).toBe(callsAfterFailure);

        // The window has fully elapsed: the same plain call now goes through.
        jest.advanceTimersByTime(5000);
        await svc.initialize();
        expect(state.initialize.mock.calls.length).toBe(callsAfterFailure + 1);
    });

    it('initialize({ force: true }) calls client.initialize() while inside a backoff window', async () => {
        jest.useFakeTimers();
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        state.initialize.mockRejectedValueOnce(new Error('boom'));
        await svc.initialize(); // 1st failure -> nextInitAllowedAt = now + 5000

        const callsAfterFailure = state.initialize.mock.calls.length;

        // Well inside the 5s window.
        jest.advanceTimersByTime(1000);
        await withForce(svc).initialize({ force: true });

        expect(state.initialize.mock.calls.length).toBe(callsAfterFailure + 1);
    });

    it('force: true does not bypass the isInitializing guard during an in-flight init', async () => {
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        // client.initialize() never resolves — simulates a slow launch already
        // in progress.
        state.initialize.mockImplementationOnce(() => new Promise(() => { }));
        const inFlight = svc.initialize(); // sets isInitializing = true, never settles
        void inFlight; // intentionally left pending; discarded with the module

        await flushMicrotasks(); // let it reach the `await this.client.initialize()` suspension
        const callsBefore = state.initialize.mock.calls.length; // 1 (the in-flight call)

        await withForce(svc).initialize({ force: true });

        // force only skips the backoff *timer* — it must never start a second
        // concurrent client.initialize() call.
        expect(state.initialize.mock.calls.length).toBe(callsBefore);
    });

    it('resets the failure counter on a successful initialize (fail -> succeed -> fail => backoff is 5s again, not 15s)', async () => {
        jest.useFakeTimers();
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        // 1st failure -> backoff = INIT_BACKOFF_MS[0] = 5000ms.
        state.initialize.mockRejectedValueOnce(new Error('fail-1'));
        await svc.initialize();

        // Clear the window and succeed -> resets consecutiveInitFailures to 0.
        jest.advanceTimersByTime(5000);
        await svc.initialize();
        state.handlers['disconnected']?.('NAVIGATION'); // clear isInitializing for the next attempt

        // 2nd failure. If the counter had NOT reset, this would be treated as
        // the 2nd consecutive failure (15s backoff, INIT_BACKOFF_MS[1]).
        state.initialize.mockRejectedValueOnce(new Error('fail-2'));
        await svc.initialize();
        const callsAfterSecondFailure = state.initialize.mock.calls.length;

        // Not yet past 5s — blocked either way, so this alone proves nothing.
        jest.advanceTimersByTime(4999);
        await svc.initialize();
        expect(state.initialize.mock.calls.length).toBe(callsAfterSecondFailure);

        // Now past 5s. A 15s backoff (unreset counter) would still block this.
        jest.advanceTimersByTime(1);
        await svc.initialize();
        expect(state.initialize.mock.calls.length).toBe(callsAfterSecondFailure + 1);
    });

    it('the failure path destroys the old client and swaps in a fresh one', async () => {
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const clientsBefore = state.clients.length;
        const destroyCallsBefore = state.destroy.mock.calls.length;

        state.initialize.mockRejectedValueOnce(new Error('boom'));
        await svc.initialize();

        expect(state.destroy.mock.calls.length).toBeGreaterThan(destroyCallsBefore);
        expect(state.clients.length).toBe(clientsBefore + 1);
    });

    it('settles initialize() after DESTROY_TIMEOUT_MS even when destroy() never resolves', async () => {
        jest.useFakeTimers();
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        state.destroy.mockReturnValue(new Promise(() => { })); // never settles
        state.initialize.mockRejectedValueOnce(new Error('boom'));

        let settled = false;
        const initPromise = svc.initialize().then(() => { settled = true; });

        // Pump timers in 200ms steps — same style as the existing
        // "waitForLockRelease force-removes lock after timeout" test — since
        // advanceTimersByTime alone does not also flush the microtasks in
        // between. 80 * 200ms = 16000ms clears the 15000ms DESTROY_TIMEOUT_MS.
        for (let i = 0; i < 80; i++) {
            jest.advanceTimersByTime(200);
            await Promise.resolve();
        }

        await initPromise;
        expect(settled).toBe(true);
    }, 15000);
});

describe('WhatsAppService — browser discard', () => {
    /** Same check as the "session-lost alert" describe's helper above — copied
     *  locally since these describe blocks do not share scope. */
    function alerted(spy: jest.SpyInstance): boolean {
        return spy.mock.calls.flat().some(a => typeof a === 'string' && a.includes('wa_session_lost'));
    }

    afterEach(() => {
        jest.useRealTimers();
    });

    it('a discard during a failed initialize() emits no wa_session_lost alert, even if destroy() makes the dying client fire a LOGOUT-shaped disconnect', async () => {
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const deadIndex = state.clients.length - 1;
        // destroy() itself makes the dying client emit a LOGOUT disconnect —
        // proof that detachClient() removed the listener BEFORE destroy() ran;
        // otherwise this would page a human for a session we are deliberately
        // discarding (fixes C1/E7).
        state.destroy.mockImplementationOnce(async () => {
            state.clients[deadIndex].handlers['disconnected']?.('LOGOUT');
        });
        state.initialize.mockRejectedValueOnce(new Error('boom'));

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        await svc.initialize();
        expect(alerted(spy)).toBe(false);
        spy.mockRestore();
    });

    it('settles a pending ack when the browser is discarded during a failed initialize()', async () => {
        jest.useFakeTimers();
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();

        state.handlers['ready']?.();
        let resolveSend: (v: unknown) => void = () => { };
        state.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
        const sendPromise = svc.sendMessage('123@g.us', 'in flight when the browser died');

        // The connection drops before client.sendMessage() itself has resolved,
        // so no ack waiter is registered yet — this settle is a no-op.
        state.handlers['disconnected']?.('NAVIGATION');

        // The network call now completes, AFTER the disconnect: sendMessage()
        // registers its ack-wait against a client that is already gone.
        resolveSend({ id: { _serialized: 'mid-discard' }, ack: 0 });
        await flushMicrotasks();

        // A later relaunch attempt fails and discards that same dead client.
        state.initialize.mockRejectedValueOnce(new Error('boom'));
        const initPromise = svc.initialize();

        // Must resolve via detachClient()'s settle, not the 30s ack timeout —
        // fake timers here are never advanced, so a timeout-based resolution
        // is not possible; only the explicit settle can unblock this.
        await expect(sendPromise).resolves.toBe(false);
        await initPromise;
    });
});

// ─── Round 2 — review findings F1/F2/F4/F5 + the intentionalLogout nit ───────
//
// Same additive-only rule as round 1: everything below is new describe
// blocks, appended after the existing file content.

/**
 * Round 4 (R1) rewrite. The round-3 stub below hand-rolled on/once/off
 * semantics and stored the RAW handler in once(), matching it in off() —
 * but real Puppeteer's once() (node_modules/puppeteer-core/lib/cjs/puppeteer/
 * common/EventEmitter.js) wraps the handler internally and registers the
 * *wrapper* as the actual listener, so a later off(type, handler) with the
 * original reference can never find it (`lastIndexOf` returns -1) and removes
 * nothing. Because the hand-rolled stub was more forgiving than the real
 * thing, its off() call appeared to disarm the watch when production's own
 * disarm was silently a no-op against a real browser — a false-negative
 * regression test, not a real one. (Production has since moved off once() to
 * on() for the same reason; see the doc comment above `browser.on(...)` in
 * initialize().)
 *
 * Fixed by wrapping the REAL puppeteer-core EventEmitter instead of
 * hand-rolling registration/removal semantics, so this cannot drift out of
 * sync with upstream again. Every test below fires via `.emit('disconnected')`
 * — never by invoking a captured handler reference directly, which is exactly
 * what let the original bug through: it bypasses the registration/removal
 * machinery entirely and can't tell "disarmed" from "never armed" apart.
 *
 * Round 5: import from the package's PUBLIC entry point (`puppeteer-core`),
 * not the deep internal path (`puppeteer-core/lib/cjs/puppeteer/common/
 * EventEmitter.js`) round 4 used. That internal layout is not part of the
 * package's public contract and upstream can relocate it in any minor;
 * `require('puppeteer-core').EventEmitter` is sanctioned by the package's
 * `exports` map and verified identical
 * (`require('puppeteer-core').EventEmitter === require('puppeteer-core/lib/
 * cjs/puppeteer/common/EventEmitter.js').EventEmitter` → `true`, confirmed by
 * running it directly against this tree's node_modules). This module-scope
 * require runs on load of the one file A-AC-10 protects — a failed resolve
 * here would fail all 66 tests in it, not just the 7 using this stub.
 * puppeteer-core itself is not a direct dependency (arrives transitively via
 * whatsapp-web.js -> puppeteer), which is exactly why the public, versioned
 * entry point is the only path worth depending on.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EventEmitter: PuppeteerEventEmitter } = require('puppeteer-core');

function createPupBrowserStub() {
    const browser = new PuppeteerEventEmitter();
    // Spy on the REAL on()/off() so tests can assert they were called, while
    // still running the real registration/removal logic underneath — these
    // are pass-through spies, not replacements.
    jest.spyOn(browser, 'on');
    jest.spyOn(browser, 'off');
    return browser as {
        on: jest.SpyInstance;
        off: jest.SpyInstance;
        once: (type: string, handler: (...args: unknown[]) => void) => unknown;
        emit: (type: string, event?: unknown) => boolean;
    };
}

describe('WhatsAppService — isInitializing latch (F4)', () => {
    it('a second initialize() after a successful launch does not call client.initialize() again', async () => {
        // No 'ready', 'disconnected', or 'auth_failure' has fired — the browser
        // is still up (e.g. holding the QR screen). Spec §0: if isInitializing
        // were cleared unconditionally on a successful resolve (e.g. a stray
        // `finally { this.isInitializing = false }`), this second call would
        // launch a second Chromium on the same profile.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks(); // let the bootstrap's own successful initialize() resolve

        const callsAfterSuccess = state.initialize.mock.calls.length;

        await svc.initialize();

        expect(state.initialize.mock.calls.length).toBe(callsAfterSuccess);
    });

    it('increases the backoff gap across consecutive failures: 5s, then 15s, then 60s', async () => {
        jest.useFakeTimers();
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        // 1st failure -> INIT_BACKOFF_MS[0] = 5000ms.
        state.initialize.mockRejectedValueOnce(new Error('fail-1'));
        await svc.initialize();
        const callsAfterFail1 = state.initialize.mock.calls.length;

        jest.advanceTimersByTime(4999);
        await svc.initialize(); // still blocked
        expect(state.initialize.mock.calls.length).toBe(callsAfterFail1);

        jest.advanceTimersByTime(1); // exactly 5000ms since fail-1: allowed
        state.initialize.mockRejectedValueOnce(new Error('fail-2'));
        await svc.initialize(); // 2nd failure -> INIT_BACKOFF_MS[1] = 15000ms
        const callsAfterFail2 = state.initialize.mock.calls.length;
        expect(callsAfterFail2).toBe(callsAfterFail1 + 1);

        jest.advanceTimersByTime(14999);
        await svc.initialize(); // still blocked -- an unreset 5s gap would have allowed this
        expect(state.initialize.mock.calls.length).toBe(callsAfterFail2);

        jest.advanceTimersByTime(1); // exactly 15000ms since fail-2: allowed
        state.initialize.mockRejectedValueOnce(new Error('fail-3'));
        await svc.initialize(); // 3rd failure -> INIT_BACKOFF_MS[2] = 60000ms
        const callsAfterFail3 = state.initialize.mock.calls.length;
        expect(callsAfterFail3).toBe(callsAfterFail2 + 1);

        jest.advanceTimersByTime(59999);
        await svc.initialize(); // still blocked -- an unreset 15s gap would have allowed this
        expect(state.initialize.mock.calls.length).toBe(callsAfterFail3);

        jest.advanceTimersByTime(1); // exactly 60000ms since fail-3: allowed
        await svc.initialize(); // succeeds (default mock)
        expect(state.initialize.mock.calls.length).toBe(callsAfterFail3 + 1);

        jest.useRealTimers();
    });
});

describe('WhatsAppService — browser-crash detection (F1, pupBrowser disconnected)', () => {
    function alerted(spy: jest.SpyInstance, reasonSubstring?: string): boolean {
        return spy.mock.calls.flat().some(a =>
            typeof a === 'string' &&
            a.includes('wa_session_lost') &&
            (reasonSubstring === undefined || a.includes(reasonSubstring)),
        );
    }

    it('sets isReady false and alerts with reason browser_disconnected when the underlying browser process dies', async () => {
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION'); // clean slate

        // Attach a controllable pupBrowser BEFORE the next initialize() call, so
        // the listener registered right after a successful client.initialize()
        // has something real to subscribe to.
        const liveClient = state.clients[state.clients.length - 1];
        const pupBrowser = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof pupBrowser }).pupBrowser = pupBrowser;

        await svc.initialize(); // succeeds (default mock)
        state.handlers['ready']?.();
        expect(svc.isConnected()).toBe(true);
        expect(pupBrowser.on).toHaveBeenCalledWith('disconnected', expect.any(Function));

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        pupBrowser.emit('disconnected'); // simulate the browser process dying (OOM-kill / crash)

        expect(svc.isConnected()).toBe(false);
        expect(alerted(spy, 'browser_disconnected')).toBe(true);
        spy.mockRestore();
    });

    it('does not alert when the browser disconnected event fires inside client.logout(), before this.client is ever swapped', async () => {
        // Round 3 (S4) rewrite: a fresh review flagged the original version of
        // this test for firing the crash handler *after* `await svc.logout()`
        // had already completed replaceClient() — the one ordering where the
        // handler's own `this.client !== watchedClient` guard alone happens to
        // save it, regardless of whether disarmBrowserWatch() ran at all. In
        // production the browser 'disconnected' event fires from *inside*
        // client.logout() (or client.destroy()), ~10s before replaceClient()
        // ever swaps this.client — at that instant the guard has NOT engaged
        // yet, so only the explicit disarm (called at the very top of logout(),
        // before either call can close the browser) can prevent a false alert.
        // Uses the realistic createPupBrowserStub() (wrapping the real
        // puppeteer-core EventEmitter — not a captured-and-directly-invoked
        // handler) so off() actually has to have run for emit('disconnected')
        // to be a no-op.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const liveClient = state.clients[state.clients.length - 1];
        const pupBrowser = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof pupBrowser }).pupBrowser = pupBrowser;

        await svc.initialize(); // succeeds — arms the crash watch
        state.handlers['ready']?.();

        // Fire the browser's own 'disconnected' event from *inside*
        // client.logout() itself, before disarmBrowserWatch() has any later
        // chance to matter and before this.client is swapped.
        state.logout.mockImplementationOnce(async () => { pupBrowser.emit('disconnected'); });

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        await svc.logout();
        expect(alerted(spy, 'browser_disconnected')).toBe(false);
        spy.mockRestore();
    });

    it('does not alert when destroyClient() closes a browser whose crash watch is still armed (discardBrowser() path)', async () => {
        // The second B1 path: discardBrowser() destroys the old browser
        // *before* this.client is ever reassigned (this.client = createClient()
        // is the last line), so at the instant destroy() runs, the handler's
        // own `this.client !== watchedClient` guard is still false — only
        // disarmBrowserWatch(), wired into detachClient() ahead of
        // destroyClient(), prevents a false alert here. Otherwise a client that
        // once launched successfully and later fails would alert on every
        // rung of the backoff ladder it discards through.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const liveClient = state.clients[state.clients.length - 1];
        const pupBrowser = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof pupBrowser }).pupBrowser = pupBrowser;

        await svc.initialize(); // succeeds — arms the crash watch on this client

        // Reset isInitializing WITHOUT swapping this.client — mirrors a real
        // disconnect that doesn't itself trigger a client replacement. The
        // watch stays armed on the very client the next attempt will use.
        state.handlers['disconnected']?.('NAVIGATION');

        // That same client's next launch attempt fails, and its destroy()
        // (inside discardBrowser()) is where the browser actually closes.
        state.destroy.mockImplementationOnce(async () => { pupBrowser.emit('disconnected'); });
        state.initialize.mockRejectedValueOnce(new Error('boom'));

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        await svc.initialize();
        expect(alerted(spy, 'browser_disconnected')).toBe(false);
        spy.mockRestore();
    });

    it('detachClient() disarms the crash watch on the ordinary discard path (replaceClient() via qrMaxRetries)', async () => {
        // Confirms the watcher is disarmed via detachClient() on the plain
        // discard path too (not just the logout()/discardBrowser() paths
        // above) — asserts the mechanism itself (off() called with the right
        // handler), then confirms a later fire is genuinely inert.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const liveClient = state.clients[state.clients.length - 1];
        const pupBrowser = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof pupBrowser }).pupBrowser = pupBrowser;

        await svc.initialize(); // succeeds — arms the crash watch

        // whatsapp-web.js hits qrMaxRetries -> 'disconnected' -> replaceClient()
        // -> detachClient() -> disarmBrowserWatch().
        liveClient.handlers['disconnected']?.('max qrcode retries reached');

        expect(pupBrowser.off).toHaveBeenCalledWith('disconnected', expect.any(Function));

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        pupBrowser.emit('disconnected');
        expect(alerted(spy, 'browser_disconnected')).toBe(false);
        spy.mockRestore();
    });
});

describe('WhatsAppService — concurrent initialize() during mid-launch (F2, initInFlight)', () => {
    it('refuses a concurrent initialize() even when a handler clears isInitializing mid-launch', async () => {
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        // client.initialize() never resolves — simulates being mid-inject() when
        // AUTHENTICATION_FAILURE or the AppState-changed disconnect route fires
        // (both are wired up during inject(), which client.initialize() awaits).
        state.initialize.mockImplementationOnce(() => new Promise(() => { }));
        const inFlight = svc.initialize();
        void inFlight; // intentionally left pending; discarded with the module

        await flushMicrotasks(); // let it reach the suspension point

        // Simulate that mid-launch event: it clears isInitializing synchronously,
        // but NOT initInFlight, which only the still-suspended initialize() call
        // itself controls (cleared in its `finally`, which hasn't run yet).
        state.handlers['disconnected']?.('NAVIGATION');

        const callsBefore = state.initialize.mock.calls.length;
        await svc.initialize();

        // If initInFlight did not exist, isInitializing alone (now false) would
        // let this second call through — two client.initialize() calls on one
        // profile, the exact orphan this PR exists to remove.
        expect(state.initialize.mock.calls.length).toBe(callsBefore);
    });
});

describe('WhatsAppService — destroyClient() cleanup-failure alert (F5, wa_cleanup_failed)', () => {
    it('emits a wa_cleanup_failed alert when destroy() times out while discarding a dead client', async () => {
        jest.useFakeTimers();
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        state.destroy.mockReturnValue(new Promise(() => { })); // never settles
        state.initialize.mockRejectedValueOnce(new Error('boom'));

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        const initPromise = svc.initialize();

        // Same 200ms-step pump as the round-1 DESTROY_TIMEOUT_MS test: 80 * 200ms
        // = 16000ms clears the 15000ms DESTROY_TIMEOUT_MS.
        for (let i = 0; i < 80; i++) {
            jest.advanceTimersByTime(200);
            await Promise.resolve();
        }
        await initPromise;

        const cleanupAlerted = spy.mock.calls.flat().some(a => typeof a === 'string' && a.includes('wa_cleanup_failed'));
        expect(cleanupAlerted).toBe(true);

        spy.mockRestore();
        jest.useRealTimers();
    }, 15000);
});

describe('WhatsAppService — logout() intentionalLogout cleanup on throw', () => {
    function alerted(spy: jest.SpyInstance): boolean {
        return spy.mock.calls.flat().some(a => typeof a === 'string' && a.includes('wa_session_lost'));
    }

    it('clears intentionalLogout even when client.logout() throws, so the next involuntary LOGOUT still alerts', async () => {
        const { svc, state } = await loadFreshService();
        state.handlers['ready']?.();
        // client.logout() throws, so the real client's own LOGOUT disconnected
        // event this would normally trigger never fires here (state.logout is
        // fully mocked) — intentionalLogout would previously be left dangling.
        state.logout.mockRejectedValueOnce(new Error('logout failed'));

        await svc.logout();

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        // A later, genuine involuntary logout on the replacement client.
        state.handlers['disconnected']?.('LOGOUT');
        expect(alerted(spy)).toBe(true);
        spy.mockRestore();
    });
});

// ─── Round 3 — fresh-reviewer findings B1/S2/S3 + getStatus()/timing fix-ups ─
//
// Same additive-only rule as rounds 1-2, with one sanctioned exception: the
// S4 test above ("does not alert when the browser disconnected event fires
// inside client.logout()...") was rewritten IN PLACE — the reviewer identified
// it as testing the wrong ordering, not as a missing test. Everything below is
// new describe blocks.

describe('WhatsAppService — discardBrowser() resilience (S2)', () => {
    it('clears isInitializing even if createClient() throws while discarding a dead browser', async () => {
        // discardBrowser()'s `this.client = this.createClient()` runs outside
        // any try of its own. If it throws, isInitializing (and initInFlight)
        // must still be cleared by the surrounding try/finally, or the service
        // wedges permanently and only a container restart recovers it.
        //
        // The shared loadFreshService()/MockState harness doesn't expose the
        // raw `Client` mock (it's constructed inside a `jest.doMock` factory
        // that only lives within its own `jest.isolateModulesAsync` block), so
        // this test builds its own minimal, self-contained isolate — the same
        // pattern loadFreshService() itself uses — to get a Client constructor
        // it can make throw on demand.
        let clientConstructCalls = 0;
        let latestHandlers: EventHandlers | undefined;
        const initializeMock = jest.fn().mockResolvedValue(undefined);

        let svc!: { initialize: (opts?: { force?: boolean }) => Promise<void> };

        await jest.isolateModulesAsync(async () => {
            jest.doMock('whatsapp-web.js', () => ({
                Client: jest.fn().mockImplementation(() => {
                    clientConstructCalls++;
                    if (clientConstructCalls === 2) {
                        // The 2nd construction is discardBrowser()'s reconstruction.
                        throw new Error('cannot construct client');
                    }
                    const handlers: EventHandlers = {};
                    latestHandlers = handlers;
                    return {
                        handlers,
                        on: (event: string, handler: (...args: unknown[]) => void) => { handlers[event] = handler; },
                        removeAllListeners: jest.fn(),
                        initialize: initializeMock,
                        destroy: jest.fn().mockResolvedValue(undefined),
                        logout: jest.fn().mockResolvedValue(undefined),
                        sendMessage: jest.fn(),
                    };
                }),
                LocalAuth: jest.fn().mockReturnValue({}),
            }));
            jest.doMock('fs', () => ({ existsSync: jest.fn().mockReturnValue(false), rmSync: jest.fn() }));
            jest.doMock('path', () => ({ join: (...args: string[]) => args.join('/') }));

            delete (globalThis as Record<string, unknown>).whatsappGlobal;
            delete process.env.npm_lifecycle_event;

            const mod = await import('@/lib/whatsapp');
            svc = mod.whatsappService as unknown as typeof svc;
        });

        await flushMicrotasks(); // let the bootstrap's own successful initialize() resolve
        latestHandlers?.['disconnected']?.('NAVIGATION'); // clean slate, no client swap yet

        initializeMock.mockRejectedValueOnce(new Error('boom'));

        // client.initialize() fails -> discardBrowser() -> createClient()'s 2nd
        // construction throws synchronously, outside destroyClient()'s own
        // try/catch — the rejection propagates out of initialize() itself.
        await expect(svc.initialize()).rejects.toThrow('cannot construct client');

        // The guard must not be left wedged: a subsequent call has to reach
        // client.initialize() again, not silently no-op forever.
        initializeMock.mockClear();
        await svc.initialize({ force: true });
        expect(initializeMock).toHaveBeenCalledTimes(1);
    });
});

describe('WhatsAppService — post-launch crash rate limiting (S3)', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('rate-limits relaunch after a post-launch browser crash, same as any other failure', async () => {
        // recordInitFailure() is now shared by client.initialize() rejecting
        // and by the browser-crash watcher — an OOM-kill after a successful
        // launch must open the same backoff window as any other failure, or
        // launch -> crash -> relaunch runs completely unrate-limited at
        // ~1GB/cycle.
        jest.useFakeTimers();
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const liveClient = state.clients[state.clients.length - 1];
        const pupBrowser = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof pupBrowser }).pupBrowser = pupBrowser;

        await svc.initialize(); // succeeds — arms the crash watch

        pupBrowser.emit('disconnected'); // simulate the browser process dying post-launch

        // Exactly one rung consumed by the crash itself (round-4 R1 also
        // covers the "not two rungs for one failure" case more directly below
        // — this just confirms the crash path opens a real backoff window).
        expect((svc as unknown as { getStatus: () => { consecutiveInitFailures: number } }).getStatus().consecutiveInitFailures).toBe(1);

        const callsAfterCrash = state.initialize.mock.calls.length;

        // Still inside INIT_BACKOFF_MS[0] = 5000ms -> blocked.
        await svc.initialize();
        expect(state.initialize.mock.calls.length).toBe(callsAfterCrash);

        jest.advanceTimersByTime(5000);
        await svc.initialize(); // window elapsed -> goes through
        expect(state.initialize.mock.calls.length).toBe(callsAfterCrash + 1);
    });
});

describe('WhatsAppService — getStatus() reporting during mid-launch (initInFlight)', () => {
    it('reports initializing: true while initInFlight is set even if isInitializing was cleared mid-launch', async () => {
        // getStatus().initializing now ORs in initInFlight, not just
        // isInitializing — otherwise the reconnect route could report 202
        // "starting" for a call that immediately no-ops at the initInFlight
        // guard, during exactly the window F2's test proves is refused.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        state.initialize.mockImplementationOnce(() => new Promise(() => { }));
        const inFlight = svc.initialize();
        void inFlight; // intentionally left pending; discarded with the module

        await flushMicrotasks();

        // The mid-launch event that clears isInitializing but not initInFlight
        // (see the F2 describe above).
        state.handlers['disconnected']?.('NAVIGATION');

        const status = (svc as unknown as { getStatus: () => { initializing: boolean } }).getStatus();
        expect(status.initializing).toBe(true);
    });
});

describe('WhatsAppService — intentionalLogout reset timing (round 3)', () => {
    it('suppresses a LOGOUT disconnect that fires on the old client during waitForLockRelease(), before replaceClient() detaches it', async () => {
        // The intentionalLogout reset moved from right after client.destroy()
        // to just after replaceClient(). The old placement left a ~10s window
        // (a full waitForLockRelease()) where a late LOGOUT-shaped disconnect
        // from the still-attached old client would have read the flag as
        // already false and raised a false alert. Simulate exactly that
        // window by firing the old client's own disconnected event from
        // inside fs.existsSync() — waitForLockRelease()'s poll — which runs
        // strictly after client.destroy() has resolved and strictly before
        // replaceClient() ever runs.
        const { svc, state } = await loadFreshService(s => {
            s.fsExists.mockReturnValue(true); // lock initially present -> waitForLockRelease() actually polls
        });
        await flushMicrotasks();
        state.handlers['ready']?.();

        const oldClient = state.clients[state.clients.length - 1];
        state.fsRm.mockClear();

        let fired = false;
        state.fsExists.mockImplementation(() => {
            if (!fired) {
                fired = true;
                oldClient.handlers['disconnected']?.('LOGOUT');
            }
            return false; // lock reads as released on this same poll
        });

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        await svc.logout();

        const alerted = spy.mock.calls.flat().some(a => typeof a === 'string' && a.includes('wa_session_lost'));
        expect(alerted).toBe(false);
        spy.mockRestore();
    });
});

// ─── Round 4 — fresh-reviewer BLOCK: rebuilt pupBrowser stub + S1/R1 coverage ─
//
// Same additive-only rule as before, with one sanctioned exception (per the
// coordinator): createPupBrowserStub() itself, and the 4 existing tests built
// on it (2 hard-failing, 2 silently no longer exercising what they claimed),
// were rewritten in place above — a fresh review found the hand-rolled stub
// stored the raw once() handler and matched it in off(), which real
// Puppeteer's once() (it stores an internal wrapper) never would, so those
// tests could not tell a genuine disarm from a missing one. Everything below
// this comment is new describe blocks.

describe('WhatsAppService — stale watch disarm across a same-client re-arm (S1)', () => {
    function alerted(spy: jest.SpyInstance, reasonSubstring?: string): boolean {
        return spy.mock.calls.flat().some(a =>
            typeof a === 'string' &&
            a.includes('wa_session_lost') &&
            (reasonSubstring === undefined || a.includes(reasonSubstring)),
        );
    }

    it('does not alert or record a failure when an old, superseded browser closes after the same client re-arms on a new one', async () => {
        // The gap S1 closes: disarmBrowserWatch() used to take a `dead: Client`
        // and early-return on a `dead.pupBrowser !== this.browserWatch.browser`
        // identity mismatch. A plain disconnect/auth_failure clears
        // isInitializing WITHOUT replacing the Client, so a second successful
        // initialize() on the *same* Client overwrites `this.browserWatch`
        // with a new {browser, handler} pair while abandoning the old one
        // still-armed on the old (by-then-stale) browser reference — and
        // because `this.client` never changed either, the handler's own
        // `this.client !== watchedClient` backstop can't save it: both the old
        // and new handler close over the exact same Client object.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const liveClient = state.clients[state.clients.length - 1];

        // First launch arms the watch on browser A.
        const browserA = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof browserA }).pupBrowser = browserA;
        await svc.initialize();

        // A plain disconnect clears isInitializing WITHOUT replacing the
        // client (no LOGOUT, no qrMaxRetries) — browserWatch is untouched by
        // this path; only the arming block's own disarmBrowserWatch() call
        // (S1) will disarm it, on the *next* initialize().
        state.handlers['disconnected']?.('NAVIGATION');

        // The same Client relaunches and gets a new underlying browser, B.
        const browserB = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof browserB }).pupBrowser = browserB;
        await svc.initialize();

        const getFailures = () => (svc as unknown as { getStatus: () => { consecutiveInitFailures: number } }).getStatus().consecutiveInitFailures;
        const failuresBefore = getFailures();

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });

        // The old, superseded browser A closes late — must be inert.
        browserA.emit('disconnected');
        expect(alerted(spy, 'browser_disconnected')).toBe(false);
        expect(getFailures()).toBe(failuresBefore);

        // B's watch is still live — a genuine crash on the CURRENT browser
        // must still alert, proving this is a real re-arm, not just a disarm.
        browserB.emit('disconnected');
        expect(alerted(spy, 'browser_disconnected')).toBe(true);

        spy.mockRestore();
    });
});

describe('WhatsAppService — one logical failure consumes exactly one backoff rung (R1)', () => {
    it('a failed initialize() with a still-armed stale watch does not double-count via the crash handler', async () => {
        // R1's second consequence: before the on()/off() fix, a still-armed
        // watch whose browser closed during discardBrowser()'s destroy() fired
        // the crash handler in addition to the catch block's own
        // recordInitFailure() — one logical failure burning two rungs. With
        // the fix, disarmBrowserWatch() (now called unconditionally inside
        // detachClient(), ahead of destroyClient()) removes the listener
        // before the browser ever closes, so only the catch's own call runs.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const liveClient = state.clients[state.clients.length - 1];
        const pupBrowser = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof pupBrowser }).pupBrowser = pupBrowser;

        await svc.initialize(); // succeeds — arms the crash watch

        // Reset isInitializing WITHOUT swapping this.client or disarming the
        // watch — a plain disconnect does neither.
        state.handlers['disconnected']?.('NAVIGATION');

        // The still-armed browser closes from inside destroy(), which
        // discardBrowser() reaches only after this failed launch.
        state.destroy.mockImplementationOnce(async () => { pupBrowser.emit('disconnected'); });
        state.initialize.mockRejectedValueOnce(new Error('boom'));

        await svc.initialize();

        const status = (svc as unknown as { getStatus: () => { consecutiveInitFailures: number } }).getStatus();
        expect(status.consecutiveInitFailures).toBe(1);
    });
});

// ─── Round 5 — disarm moved before the await (stale-watch-across-LOGOUT gap) ─

describe('WhatsAppService — stale watch disarmed before relaunch, not after (round 5)', () => {
    function alerted(spy: jest.SpyInstance, reasonSubstring?: string): boolean {
        return spy.mock.calls.flat().some(a =>
            typeof a === 'string' &&
            a.includes('wa_session_lost') &&
            (reasonSubstring === undefined || a.includes(reasonSubstring)),
        );
    }

    it('does not alert or record a failure when the old browser dies mid-launch of the next attempt, after an involuntary LOGOUT that left the client unreplaced', async () => {
        // The gap this round closes: Client.js's framenavigated -> post_logout=1
        // route emits DISCONNECTED 'LOGOUT' WITHOUT destroying the browser or
        // replacing the Client (unlike an admin-driven logout(), which destroys
        // it explicitly). That LOGOUT alert is legitimate and expected — but it
        // leaves the crash watch armed on a still-live browser. If disarm sat
        // AFTER `await this.client.initialize()` (round 4's position), the next
        // relaunch attempt on the same Client would leave that stale watch
        // armed for the whole in-flight duration of the new launch — and if the
        // old browser died in that window, `this.client === watchedClient`
        // (nothing ever replaced it) so the stale handler would fire: a
        // duplicate wa_session_lost, a spurious backoff rung, and
        // isInitializing cleared mid-launch of the attempt actually in
        // progress. Moving the disarm to the FIRST statement in the try — before
        // the await, not after — closes the window entirely.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const liveClient = state.clients[state.clients.length - 1];
        const browserA = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof browserA }).pupBrowser = browserA;

        await svc.initialize(); // succeeds — arms the watch on browser A

        // Involuntary logout: fires LOGOUT without destroying the browser or
        // replacing the client. A real, expected alert for THIS event — but
        // browser A's watch is left armed (nothing here disarms it).
        const earlySpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        state.handlers['disconnected']?.('LOGOUT');
        expect(alerted(earlySpy, 'LOGOUT')).toBe(true); // the legitimate alert
        earlySpy.mockRestore();

        const getFailures = () => (svc as unknown as { getStatus: () => { consecutiveInitFailures: number } }).getStatus().consecutiveInitFailures;
        const failuresBefore = getFailures();

        // The same Client relaunches; client.initialize() hangs mid-launch —
        // exactly the window the fix closes by disarming before, not after,
        // this await.
        state.initialize.mockImplementationOnce(() => new Promise(() => { }));
        const inFlight = svc.initialize();
        void inFlight; // intentionally left pending; discarded with the module
        await flushMicrotasks();

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        browserA.emit('disconnected'); // the OLD, still-armed browser dies mid-launch

        expect(alerted(spy, 'browser_disconnected')).toBe(false);
        expect(getFailures()).toBe(failuresBefore);
        spy.mockRestore();
    });

    it('the crash handler explicitly off()s itself when it genuinely fires', async () => {
        // Cheap to pin: the handler no longer relies solely on "Browser only
        // emits disconnected once" plus nulling the field — it now calls
        // browser.off(type, handler) on itself before doing anything else.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        const liveClient = state.clients[state.clients.length - 1];
        const pupBrowser = createPupBrowserStub();
        (liveClient as unknown as { pupBrowser?: typeof pupBrowser }).pupBrowser = pupBrowser;

        await svc.initialize(); // arms the watch

        const spy = jest.spyOn(console, 'error').mockImplementation(() => { });
        pupBrowser.emit('disconnected');
        spy.mockRestore();

        expect(pupBrowser.off).toHaveBeenCalledWith('disconnected', expect.any(Function));
    });

    it('re-asserts isInitializing after a successful launch even if something cleared it mid-inject', async () => {
        // Defensive re-assert: `if (!this.isReady) this.isInitializing = true;`
        // right after the await succeeds. Simulate the mid-inject clear this
        // guards against (e.g. an AppState-changed disconnect firing from
        // inside client.initialize(), before it resolves) and confirm the
        // flag comes back rather than staying false.
        const { svc, state } = await loadFreshService();
        await flushMicrotasks();
        state.handlers['disconnected']?.('NAVIGATION');

        state.initialize.mockImplementationOnce(async () => {
            state.handlers['disconnected']?.('NAVIGATION'); // clears isInitializing mid-inject
            return undefined;
        });

        await svc.initialize();

        const status = (svc as unknown as { getStatus: () => { initializing: boolean } }).getStatus();
        expect(status.initializing).toBe(true);
    });
});
