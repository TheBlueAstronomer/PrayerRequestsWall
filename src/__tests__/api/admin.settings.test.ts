const mockDbSelect = jest.fn();
const mockDbInsert = jest.fn();
const mockDbUpdate = jest.fn();

jest.mock('@/db', () => ({
    db: {
        select: mockDbSelect,
        insert: mockDbInsert,
        update: mockDbUpdate,
    },
}));

jest.mock('@/db/schema', () => ({
    appSettings: { key: 'key', value: 'value' },
}));

jest.mock('drizzle-orm', () => ({
    eq: jest.fn((a, b) => ({ eq: [a, b] })),
}));

import { GET, POST } from '@/app/api/admin/settings/route';

// ── Builder helpers ──────────────────────────────────────────────────────────

function chainSelect(rows: unknown[]) {
    const chain = { from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue(rows) };
    mockDbSelect.mockReturnValue(chain);
    return chain;
}

function chainInsert() {
    const chain = { values: jest.fn().mockResolvedValue(undefined) };
    mockDbInsert.mockReturnValue(chain);
    return chain;
}

function chainUpdate() {
    const chain = { set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue(undefined) };
    mockDbUpdate.mockReturnValue(chain);
    return chain;
}

function makePostRequest(body: unknown): Request {
    return new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// ── GET /api/admin/settings ──────────────────────────────────────────────────

describe('GET /api/admin/settings', () => {
    it('returns existing whatsapp_group_ids from DB', async () => {
        chainSelect([{ key: 'whatsapp_group_ids', value: '123@g.us,456@g.us' }]);

        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.whatsapp_group_ids).toBe('123@g.us,456@g.us');
    });

    it('returns empty string when no setting found', async () => {
        chainSelect([]);

        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.whatsapp_group_ids).toBe('');
    });

    it('returns 500 on DB error', async () => {
        mockDbSelect.mockImplementationOnce(() => {
            throw new Error('db down');
        });

        const response = await GET();
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });
});

// ── POST /api/admin/settings ─────────────────────────────────────────────────

describe('POST /api/admin/settings', () => {
    it('updates existing setting when record exists', async () => {
        chainSelect([{ key: 'whatsapp_group_ids', value: 'old-value' }]);
        const updateChain = chainUpdate();

        const response = await POST(makePostRequest({ whatsapp_group_ids: 'new@g.us' }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(updateChain.set).toHaveBeenCalledWith({ value: 'new@g.us' });
    });

    it('inserts new setting when no record exists', async () => {
        chainSelect([]);
        const insertChain = chainInsert();

        const response = await POST(makePostRequest({ whatsapp_group_ids: 'new@g.us' }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(insertChain.values).toHaveBeenCalledWith({
            key: 'whatsapp_group_ids',
            value: 'new@g.us',
        });
    });

    it('accepts empty string as valid group IDs', async () => {
        chainSelect([]);
        chainInsert();

        const response = await POST(makePostRequest({ whatsapp_group_ids: '' }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
    });

    it('returns 400 when whatsapp_group_ids is not a string', async () => {
        const response = await POST(makePostRequest({ whatsapp_group_ids: 123 }));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Invalid group IDs');
    });

    it('returns 400 when whatsapp_group_ids is missing', async () => {
        const response = await POST(makePostRequest({}));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Invalid group IDs');
    });

    it('returns 500 on DB error', async () => {
        mockDbSelect.mockImplementationOnce(() => {
            throw new Error('db down');
        });

        const response = await POST(makePostRequest({ whatsapp_group_ids: 'id@g.us' }));
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });

    it('returns 500 when request body is invalid JSON', async () => {
        const badRequest = new Request('http://localhost/api/admin/settings', {
            method: 'POST',
            body: 'not-json',
        });
        const response = await POST(badRequest);
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });
});
