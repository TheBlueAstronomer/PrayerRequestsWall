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
        sendMessage: jest.fn().mockResolvedValue(undefined),
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
            Client: jest.fn().mockImplementation(() => ({
                on: (event: string, handler: (...args: unknown[]) => void) => {
                    state.handlers[event] = handler;
                },
                initialize: state.initialize,
                destroy: state.destroy,
                logout: state.logout,
                sendMessage: state.sendMessage,
            })),
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
