const mockDbSelect = jest.fn();
const mockDbInsert = jest.fn();
const mockDbUpdate = jest.fn();
const mockSendMessage = jest.fn();

jest.mock('@/db', () => ({
    db: {
        select: mockDbSelect,
        insert: mockDbInsert,
        update: mockDbUpdate,
    },
}));

jest.mock('@/db/schema', () => ({
    prayerRequests: { id: 'id', content: 'content', whatsappSent: 'whatsapp_sent' },
    appSettings: { key: 'key', value: 'value' },
}));

jest.mock('drizzle-orm', () => ({
    eq: jest.fn((a, b) => ({ eq: [a, b] })),
}));

jest.mock('@/lib/whatsapp', () => ({
    whatsappService: {
        sendMessage: mockSendMessage,
        latestQR: null,
        logout: jest.fn(),
    },
}));

import { POST } from '@/app/api/submit/route';

// ── Builder helpers ──────────────────────────────────────────────────────────

function chainInsertReturning(rows: unknown[]) {
    const chain = {
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue(rows),
    };
    mockDbInsert.mockReturnValue(chain);
    return chain;
}

function chainSelect(rows: unknown[]) {
    const chain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(rows),
    };
    mockDbSelect.mockReturnValue(chain);
    return chain;
}

function chainUpdate() {
    const chain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
    };
    mockDbUpdate.mockReturnValue(chain);
    return chain;
}

function makeRequest(body: unknown): Request {
    return new Request('http://localhost/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/submit', () => {
    it('inserts prayer and sends WhatsApp message, returns success', async () => {
        chainInsertReturning([{ id: 1 }]);
        chainSelect([{ key: 'whatsapp_group_ids', value: 'group1@g.us' }]);
        chainUpdate();
        mockSendMessage.mockResolvedValueOnce(true);

        const response = await POST(makeRequest({ message: 'Please pray for me.' }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(mockSendMessage).toHaveBeenCalledWith(
            'group1@g.us',
            '🙏 *New Anonymous Request:* Please pray for me.'
        );
    });

    it('inserts prayer across multiple group IDs', async () => {
        chainInsertReturning([{ id: 2 }]);
        chainSelect([{ key: 'whatsapp_group_ids', value: 'g1@g.us, g2@g.us' }]);
        chainUpdate();
        mockSendMessage.mockResolvedValue(true);

        const response = await POST(makeRequest({ message: 'Multi-group prayer' }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it('returns success even if WhatsApp send fails (does not update whatsappSent)', async () => {
        chainInsertReturning([{ id: 3 }]);
        chainSelect([{ key: 'whatsapp_group_ids', value: 'g1@g.us' }]);
        mockSendMessage.mockResolvedValueOnce(false);

        const response = await POST(makeRequest({ message: 'Send failed prayer' }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(mockDbUpdate).not.toHaveBeenCalled();
    });

    it('falls back to WHATSAPP_GROUP_ID env var when no DB setting exists', async () => {
        process.env.WHATSAPP_GROUP_ID = 'env-group@g.us';
        chainInsertReturning([{ id: 4 }]);
        chainSelect([]);
        chainUpdate();
        mockSendMessage.mockResolvedValueOnce(true);

        const response = await POST(makeRequest({ message: 'Env var fallback' }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(mockSendMessage).toHaveBeenCalledWith(
            'env-group@g.us',
            '🙏 *New Anonymous Request:* Env var fallback'
        );

        delete process.env.WHATSAPP_GROUP_ID;
    });

    it('skips WhatsApp send when no group ID is configured', async () => {
        delete process.env.WHATSAPP_GROUP_ID;
        chainInsertReturning([{ id: 5 }]);
        chainSelect([]);

        const response = await POST(makeRequest({ message: 'No group prayer' }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('returns 400 when message is missing', async () => {
        const response = await POST(makeRequest({}));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Message is required');
    });

    it('returns 400 when message is not a string', async () => {
        const response = await POST(makeRequest({ message: 42 }));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Message is required');
    });

    it('returns 400 when message exceeds 1000 characters', async () => {
        const longMessage = 'a'.repeat(1001);
        const response = await POST(makeRequest({ message: longMessage }));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Message too long (max 1000 chars)');
    });

    it('accepts a message of exactly 1000 characters', async () => {
        const maxMessage = 'a'.repeat(1000);
        chainInsertReturning([{ id: 6 }]);
        chainSelect([]);

        const response = await POST(makeRequest({ message: maxMessage }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
    });

    it('returns 400 when message is an empty string', async () => {
        const response = await POST(makeRequest({ message: '' }));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Message is required');
    });

    it('returns 500 on DB error', async () => {
        mockDbInsert.mockImplementationOnce(() => {
            throw new Error('db error');
        });

        const response = await POST(makeRequest({ message: 'Valid prayer' }));
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });

    it('returns 500 on invalid JSON body', async () => {
        const badRequest = new Request('http://localhost/api/submit', {
            method: 'POST',
            body: 'not-json',
        });
        const response = await POST(badRequest);
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });

    it('filters out empty group IDs from comma-separated string', async () => {
        chainInsertReturning([{ id: 7 }]);
        chainSelect([{ key: 'whatsapp_group_ids', value: 'g1@g.us,,  ,g2@g.us' }]);
        chainUpdate();
        mockSendMessage.mockResolvedValue(true);

        await POST(makeRequest({ message: 'Filter test' }));

        expect(mockSendMessage).toHaveBeenCalledTimes(2);
        expect(mockSendMessage).toHaveBeenCalledWith('g1@g.us', expect.any(String));
        expect(mockSendMessage).toHaveBeenCalledWith('g2@g.us', expect.any(String));
    });
});
