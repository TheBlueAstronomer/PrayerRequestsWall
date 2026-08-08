jest.mock('@/lib/whatsapp', () => ({
    whatsappService: {
        latestQR: null,
        sendMessage: jest.fn(),
        logout: jest.fn(),
        initialize: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockReturnValue(false),
    },
}));

import { GET } from '@/app/api/admin/qr/route';
import { whatsappService } from '@/lib/whatsapp';

const mockService = whatsappService as jest.Mocked<typeof whatsappService> & { latestQR: string | null };

beforeEach(() => {
    (mockService.initialize as jest.Mock).mockClear();
    (mockService.isConnected as jest.Mock).mockClear();
    (mockService.isConnected as jest.Mock).mockReturnValue(false);
});

describe('GET /api/admin/qr', () => {
    it('returns success:true with null qr when no QR is available', async () => {
        mockService.latestQR = null;
        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.qr).toBeNull();
    });

    it('returns the latest QR string when available', async () => {
        mockService.latestQR = 'qr-data-string-abc123';
        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.qr).toBe('qr-data-string-abc123');
    });

    // GET /api/admin/qr is read-only: the old re-arm-on-empty-QR behaviour leaked a
    // Chromium every poll while the client was failing (2026-08-07 outage). Re-arming
    // now only happens via POST /api/admin/whatsapp/reconnect.
    it('does not re-arm the client when no QR is on offer', async () => {
        mockService.latestQR = null;
        await GET();

        expect(mockService.initialize).not.toHaveBeenCalled();
    });

    it('does not re-arm while a QR is already being offered', async () => {
        mockService.latestQR = 'live-qr';
        await GET();

        expect(mockService.initialize).not.toHaveBeenCalled();
    });

    it('never calls initialize, even one primed to fail', async () => {
        // Guards against a regression that re-adds a fire-and-forget re-arm call:
        // even a rejecting initialize() must never be reachable from this handler.
        mockService.latestQR = null;
        (mockService.initialize as jest.Mock).mockRejectedValueOnce(new Error('boom'));

        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.qr).toBeNull();
        expect(mockService.initialize).not.toHaveBeenCalled();
    });

    it('passes through the connected status from the service', async () => {
        mockService.latestQR = null;
        (mockService.isConnected as jest.Mock).mockReturnValue(true);

        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.connected).toBe(true);
    });

    it('returns 500 on internal error', async () => {
        // Simulate an error by making the property access throw
        Object.defineProperty(mockService, 'latestQR', {
            get: () => { throw new Error('unexpected'); },
            configurable: true,
        });

        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');

        // Restore
        Object.defineProperty(mockService, 'latestQR', {
            value: null,
            writable: true,
            configurable: true,
        });
    });
});
