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

    let svc: { latestQR: string | null; sendMessage: (c: string, m: string) => Promise<boolean>; logout: () => Promise<boolean>; initialize: () => Promise<void> };

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
