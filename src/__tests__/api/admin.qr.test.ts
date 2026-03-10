jest.mock('@/lib/whatsapp', () => ({
    whatsappService: {
        latestQR: null,
        sendMessage: jest.fn(),
        logout: jest.fn(),
    },
}));

import { GET } from '@/app/api/admin/qr/route';
import { whatsappService } from '@/lib/whatsapp';

const mockService = whatsappService as jest.Mocked<typeof whatsappService> & { latestQR: string | null };

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
