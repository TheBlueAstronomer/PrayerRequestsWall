import { NextResponse } from 'next/server';
import { whatsappService } from '@/lib/whatsapp';

export async function GET() {
    try {
        const qr = whatsappService?.latestQR ?? null;

        if (!qr) {
            // No QR on offer — either the client never started, or it gave up after
            // qrMaxRetries and released Chromium. Re-arm it so an admin opening this
            // page always gets a scannable code. initialize() is a no-op while the
            // client is already connected or initializing, so polling is safe.
            Promise.resolve(whatsappService?.initialize()).catch((err) => {
                console.error('[WA:qr] Failed to re-arm the client for a new QR:', err);
            });
        }

        return NextResponse.json({ success: true, qr });
    } catch (error) {
        console.error('Error fetching QR code:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
