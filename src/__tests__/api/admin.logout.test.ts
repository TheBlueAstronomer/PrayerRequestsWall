const mockLogout = jest.fn();

jest.mock('@/lib/whatsapp', () => ({
    whatsappService: {
        logout: mockLogout,
        latestQR: null,
        sendMessage: jest.fn(),
    },
}));

import { POST } from '@/app/api/admin/logout/route';

describe('POST /api/admin/logout', () => {
    it('returns success:true when logout succeeds', async () => {
        mockLogout.mockResolvedValueOnce(true);

        const response = await POST();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.message).toBe('Logged out successfully');
        expect(mockLogout).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when logout returns false', async () => {
        mockLogout.mockResolvedValueOnce(false);

        const response = await POST();
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.success).toBe(false);
        expect(json.error).toBe('Failed to logout');
    });

    it('returns 500 when logout throws', async () => {
        mockLogout.mockRejectedValueOnce(new Error('network failure'));

        const response = await POST();
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.success).toBe(false);
        expect(json.error).toBe('Internal Server Error');
    });
});
