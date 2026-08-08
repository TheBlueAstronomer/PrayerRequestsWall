type MockStatus = {
    connected: boolean;
    hasQr: boolean;
    initializing: boolean;
    consecutiveInitFailures: number;
    nextInitAllowedAt: number;
};

const mockGetStatus = jest.fn();
const mockInitialize = jest.fn();

/**
 * A getter (not a static value) so a single test can swap the whole service to
 * undefined for the "service not initialized" branch, and back, without a
 * fresh module registry per test. TS's CommonJS emit reads `whatsappService`
 * as a live property access on this module object at each use site (same
 * reason mutating `mockService.latestQR` works in admin.qr.test.ts), so the
 * route sees whatever this getter currently returns.
 */
let mockWhatsappService: { getStatus: typeof mockGetStatus; initialize: typeof mockInitialize } | undefined;

jest.mock('@/lib/whatsapp', () => ({
    get whatsappService() {
        return mockWhatsappService;
    },
}));

import { POST } from '@/app/api/admin/whatsapp/reconnect/route';

function defaultStatus(overrides: Partial<MockStatus> = {}): MockStatus {
    return {
        connected: false,
        hasQr: false,
        initializing: false,
        consecutiveInitFailures: 0,
        nextInitAllowedAt: 0,
        ...overrides,
    };
}

beforeEach(() => {
    mockWhatsappService = { getStatus: mockGetStatus, initialize: mockInitialize };
    mockGetStatus.mockReset().mockReturnValue(defaultStatus());
    mockInitialize.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/admin/whatsapp/reconnect', () => {
    it('returns 500 when the service is not initialized', async () => {
        mockWhatsappService = undefined;

        const response = await POST();
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json).toEqual({ success: false, error: 'WhatsApp service not initialized' });
        expect(mockGetStatus).not.toHaveBeenCalled();
        expect(mockInitialize).not.toHaveBeenCalled();
    });

    it('reports already-connected and does not call initialize when getStatus().connected is true', async () => {
        mockGetStatus.mockReturnValue(defaultStatus({ connected: true }));

        const response = await POST();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json).toEqual({
            success: true,
            status: 'already-connected',
            message: 'WhatsApp is already connected.',
        });
        expect(mockInitialize).not.toHaveBeenCalled();
    });

    it('reports already-connecting and does not call initialize when getStatus().initializing is true', async () => {
        mockGetStatus.mockReturnValue(defaultStatus({ initializing: true }));

        const response = await POST();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json).toEqual({
            success: true,
            status: 'already-connecting',
            message: 'A connection attempt is already in progress.',
        });
        expect(mockInitialize).not.toHaveBeenCalled();
    });

    it('otherwise starts a forced reconnect and returns 202 starting', async () => {
        const response = await POST();
        const json = await response.json();

        expect(response.status).toBe(202);
        expect(json).toEqual({
            success: true,
            status: 'starting',
            message: 'Reconnecting. A QR code will appear here shortly.',
        });
        expect(mockInitialize).toHaveBeenCalledTimes(1);
        expect(mockInitialize).toHaveBeenCalledWith({ force: true });
    });

    it('does not let a rejected initialize() change the 202 response or produce an unhandled rejection', async () => {
        let rejectInit!: (err: Error) => void;
        mockInitialize.mockImplementationOnce(() => new Promise((_, reject) => { rejectInit = reject; }));

        const response = await POST();
        const json = await response.json();

        expect(response.status).toBe(202);
        expect(json.status).toBe('starting');

        // Reject only after the response has already been built. The route's
        // own .catch() must absorb this — if it did not, this would surface as
        // an unhandledRejection and fail the test run.
        rejectInit(new Error('cold launch failed'));
        await new Promise((resolve) => setImmediate(resolve));
    });
});
