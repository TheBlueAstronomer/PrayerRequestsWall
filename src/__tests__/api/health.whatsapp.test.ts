jest.mock('@/lib/whatsapp', () => ({
    whatsappService: {
        isConnected: jest.fn(),
        latestQR: null,
    },
}));

import { GET } from '@/app/api/health/whatsapp/route';
import { whatsappService } from '@/lib/whatsapp';

const mock = whatsappService as unknown as { isConnected: jest.Mock; latestQR: string | null };

describe('GET /api/health/whatsapp', () => {
    beforeEach(() => {
        mock.isConnected.mockReset();
        mock.latestQR = null;
    });

    it('returns 200 and connected:true when the client is ready', async () => {
        mock.isConnected.mockReturnValue(true);
        const res = await GET();
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json).toMatchObject({ status: 'ok', connected: true });
    });

    it('returns 503 and connected:false when the client is not ready', async () => {
        mock.isConnected.mockReturnValue(false);
        const res = await GET();
        const json = await res.json();

        expect(res.status).toBe(503);
        expect(json).toMatchObject({ status: 'unavailable', connected: false });
    });

    it('reports needsScan:true when a QR is pending', async () => {
        mock.isConnected.mockReturnValue(false);
        mock.latestQR = '2@some-qr-string';
        const res = await GET();
        const json = await res.json();

        expect(res.status).toBe(503);
        expect(json.needsScan).toBe(true);
    });

    it('reports needsScan:false while connected', async () => {
        mock.isConnected.mockReturnValue(true);
        const res = await GET();
        const json = await res.json();

        expect(json.needsScan).toBe(false);
    });
});
