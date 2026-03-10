const mockDbSelect = jest.fn();
const mockDbDelete = jest.fn();

jest.mock('@/db', () => ({
    db: {
        select: mockDbSelect,
        delete: mockDbDelete,
    },
}));

jest.mock('@/db/schema', () => ({
    prayerRequests: {
        id: 'id',
        content: 'content',
        createdAt: 'created_at',
        whatsappSent: 'whatsapp_sent',
    },
}));

jest.mock('drizzle-orm', () => ({
    eq: jest.fn((a, b) => ({ eq: [a, b] })),
}));

import { GET, DELETE } from '@/app/api/admin/prayers/route';

// ── Builder helpers ──────────────────────────────────────────────────────────

function chainSelect(rows: unknown[]) {
    const chain = {
        from: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue(rows),
        where: jest.fn().mockResolvedValue(rows),
    };
    mockDbSelect.mockReturnValue(chain);
    return chain;
}

function chainDelete() {
    const chain = { where: jest.fn().mockResolvedValue(undefined) };
    mockDbDelete.mockReturnValue(chain);
    return chain;
}

function makeDeleteRequest(url: string): Request {
    return new Request(url, { method: 'DELETE' });
}

// ── GET /api/admin/prayers ───────────────────────────────────────────────────

describe('GET /api/admin/prayers', () => {
    it('returns list of prayers', async () => {
        const prayers = [
            { id: 1, content: 'Pray for me', createdAt: new Date(), whatsappSent: false },
            { id: 2, content: 'Healing', createdAt: new Date(), whatsappSent: true },
        ];
        chainSelect(prayers);

        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.prayers).toHaveLength(2);
    });

    it('returns empty array when no prayers exist', async () => {
        chainSelect([]);

        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.prayers).toEqual([]);
    });

    it('returns 500 on DB error', async () => {
        mockDbSelect.mockImplementationOnce(() => {
            throw new Error('db error');
        });

        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });
});

// ── DELETE /api/admin/prayers ─────────────────────────────────────────────────

describe('DELETE /api/admin/prayers', () => {
    it('deletes a prayer by id and returns success', async () => {
        const deleteChain = chainDelete();

        const response = await DELETE(makeDeleteRequest('http://localhost/api/admin/prayers?id=5'));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(deleteChain.where).toHaveBeenCalled();
    });

    it('returns 400 when id parameter is missing', async () => {
        const response = await DELETE(makeDeleteRequest('http://localhost/api/admin/prayers'));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Missing id parameter');
    });

    it('returns 400 when id parameter is not a number', async () => {
        const response = await DELETE(makeDeleteRequest('http://localhost/api/admin/prayers?id=abc'));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Invalid id');
    });

    it('returns 400 when id is empty string', async () => {
        const response = await DELETE(makeDeleteRequest('http://localhost/api/admin/prayers?id='));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Missing id parameter');
    });

    it('returns 500 on DB error during delete', async () => {
        mockDbDelete.mockImplementationOnce(() => {
            throw new Error('db down');
        });

        const response = await DELETE(makeDeleteRequest('http://localhost/api/admin/prayers?id=1'));
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });
});
