const mockDbSelect = jest.fn();
const mockDbUpdate = jest.fn();
const mockSendMessage = jest.fn();

jest.mock('@/db', () => ({
    db: {
        select: mockDbSelect,
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

import { POST } from '@/app/api/admin/prayers/resend/route';

// ── Builder helpers ──────────────────────────────────────────────────────────

type SelectRow = { key?: string; value?: string; id?: number; content?: string; whatsappSent?: boolean };

function chainSelectSequence(rowSets: SelectRow[][]) {
    let callCount = 0;
    mockDbSelect.mockImplementation(() => {
        const rows = rowSets[callCount] ?? [];
        callCount++;
        return {
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockResolvedValue(rows),
        };
    });
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
    return new Request('http://localhost/api/admin/prayers/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/admin/prayers/resend', () => {
    it('resends to a single group and marks whatsappSent=true', async () => {
        const prayer = { id: 1, content: 'Heal my family', whatsappSent: false };
        chainSelectSequence([[prayer], [{ key: 'whatsapp_group_ids', value: 'g1@g.us' }]]);
        const updateChain = chainUpdate();
        mockSendMessage.mockResolvedValue(true);

        const response = await POST(makeRequest({ id: 1 }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.partialFailure).toBe(false);
        expect(mockSendMessage).toHaveBeenCalledWith('g1@g.us', '🙏 *New Anonymous Request:* Heal my family');
        expect(updateChain.set).toHaveBeenCalledWith({ whatsappSent: true });
    });

    it('resends to multiple groups', async () => {
        const prayer = { id: 2, content: 'Peace', whatsappSent: false };
        chainSelectSequence([[prayer], [{ key: 'whatsapp_group_ids', value: 'g1@g.us, g2@g.us' }]]);
        chainUpdate();
        mockSendMessage.mockResolvedValue(true);

        const response = await POST(makeRequest({ id: 2 }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it('returns partialFailure:true when one group send fails', async () => {
        const prayer = { id: 3, content: 'Guidance', whatsappSent: false };
        chainSelectSequence([[prayer], [{ key: 'whatsapp_group_ids', value: 'g1@g.us, g2@g.us' }]]);
        mockSendMessage
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);

        const response = await POST(makeRequest({ id: 3 }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(false);
        expect(json.partialFailure).toBe(true);
        expect(mockDbUpdate).not.toHaveBeenCalled();
    });

    it('returns 404 when prayer does not exist', async () => {
        chainSelectSequence([[]]);

        const response = await POST(makeRequest({ id: 999 }));
        const json = await response.json();

        expect(response.status).toBe(404);
        expect(json.error).toBe('Prayer not found');
    });

    it('returns 400 when id is missing', async () => {
        const response = await POST(makeRequest({}));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Missing or invalid id');
    });

    it('returns 400 when id is not a number', async () => {
        const response = await POST(makeRequest({ id: 'abc' }));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Missing or invalid id');
    });

    it('returns 400 when id is null', async () => {
        const response = await POST(makeRequest({ id: null }));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('Missing or invalid id');
    });

    it('returns 400 when no WhatsApp groups are configured (empty DB and no env)', async () => {
        delete process.env.WHATSAPP_GROUP_ID;
        const prayer = { id: 4, content: 'Hope', whatsappSent: false };
        chainSelectSequence([[prayer], []]);

        const response = await POST(makeRequest({ id: 4 }));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('No WhatsApp groups configured');
    });

    it('returns 400 when group IDs string contains only empty tokens', async () => {
        const prayer = { id: 5, content: 'Rest', whatsappSent: false };
        chainSelectSequence([[prayer], [{ key: 'whatsapp_group_ids', value: ' , , ' }]]);

        const response = await POST(makeRequest({ id: 5 }));
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe('No WhatsApp groups configured');
    });

    it('falls back to WHATSAPP_GROUP_ID env when DB setting is absent', async () => {
        process.env.WHATSAPP_GROUP_ID = 'env-group@g.us';
        const prayer = { id: 6, content: 'Env test', whatsappSent: false };
        chainSelectSequence([[prayer], []]);
        chainUpdate();
        mockSendMessage.mockResolvedValue(true);

        const response = await POST(makeRequest({ id: 6 }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(mockSendMessage).toHaveBeenCalledWith('env-group@g.us', expect.any(String));

        delete process.env.WHATSAPP_GROUP_ID;
    });

    it('returns 500 on DB error', async () => {
        mockDbSelect.mockImplementationOnce(() => {
            throw new Error('db fail');
        });

        const response = await POST(makeRequest({ id: 1 }));
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });

    it('returns 500 on invalid JSON body', async () => {
        const badRequest = new Request('http://localhost/api/admin/prayers/resend', {
            method: 'POST',
            body: 'not-json',
        });

        const response = await POST(badRequest);
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });
});
