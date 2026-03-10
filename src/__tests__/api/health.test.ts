import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
    it('returns 200 with status ok', async () => {
        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json).toEqual({ status: 'ok' });
    });
});
