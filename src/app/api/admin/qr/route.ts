import { NextResponse } from 'next/server';
import { whatsappService } from '@/lib/whatsapp';

/**
 * Read-only. This endpoint used to call initialize() whenever no QR was on offer,
 * and the admin page polls it every few seconds — so a client that failed to launch
 * was relaunched every 5s for as long as an admin tab was open, leaking a Chromium
 * per attempt until the VM exhausted swap (2026-08-07 outage). Re-arming now lives
 * behind POST /api/admin/whatsapp/reconnect and an explicit button.
 *
 * `connected` ships alongside the QR because "qr === null" is NOT "connected" — it
 * is also what a dead or backing-off client looks like. The admin page needs the
 * difference to decide whether to keep polling and whether to offer Reconnect.
 */
export async function GET() {
    try {
        const qr = whatsappService?.latestQR ?? null;
        const connected = whatsappService?.isConnected() ?? false;

        return NextResponse.json({ success: true, qr, connected });
    } catch (error) {
        console.error('Error fetching QR code:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
