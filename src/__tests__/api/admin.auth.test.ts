import { POST } from '@/app/api/admin/auth/route';

function makeRequest(body: unknown): Request {
    return new Request('http://localhost/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/admin/auth', () => {
    it('returns 200 with token when password is correct', async () => {
        const response = await POST(makeRequest({ password: 'root' }));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.token).toBe('admin_token_temp');
    });

    it('returns 401 when password is wrong', async () => {
        const response = await POST(makeRequest({ password: 'wrong' }));
        const json = await response.json();

        expect(response.status).toBe(401);
        expect(json.error).toBe('Unauthorized');
    });

    it('returns 401 when password field is missing', async () => {
        const response = await POST(makeRequest({}));
        const json = await response.json();

        expect(response.status).toBe(401);
        expect(json.error).toBe('Unauthorized');
    });

    it('returns 500 when request body is not valid JSON', async () => {
        const badRequest = new Request('http://localhost/api/admin/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not-json',
        });
        const response = await POST(badRequest);
        const json = await response.json();

        expect(response.status).toBe(500);
        expect(json.error).toBe('Internal Server Error');
    });
});
