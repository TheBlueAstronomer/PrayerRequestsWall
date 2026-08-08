import { NextResponse } from 'next/server';
import { whatsappService } from '@/lib/whatsapp';

/**
 * Explicit, human-driven re-arm — the only path that may launch Chromium on demand
 * now that GET /api/admin/qr is read-only.
 *
 * Auth is enforced centrally in src/proxy.ts for every /api/admin/* route, so this
 * handler adds no check of its own (same as /api/admin/logout).
 *
 * Deliberately does NOT await initialize(): a cold launch takes 60-90s and nginx
 * gives up at proxy_read_timeout (62s), so awaiting would 504 the admin while the
 * launch they asked for is still running. Report acceptance; let the QR poll show
 * the result.
 */
export async function POST() {
    try {
        if (!whatsappService) {
            return NextResponse.json(
                { success: false, error: 'WhatsApp service not initialized' },
                { status: 500 },
            );
        }

        const status = whatsappService.getStatus();

        if (status.connected) {
            return NextResponse.json({
                success: true,
                status: 'already-connected',
                message: 'WhatsApp is already connected.',
            });
        }

        if (status.initializing) {
            return NextResponse.json({
                success: true,
                status: 'already-connecting',
                message: 'A connection attempt is already in progress.',
            });
        }

        // force: true bypasses the failure backoff window — a human asking for a
        // reconnect must never be told to wait 15 minutes.
        void whatsappService.initialize({ force: true }).catch((err) => {
            console.error('[WA:reconnect] Forced initialization failed:', err);
        });

        return NextResponse.json(
            { success: true, status: 'starting', message: 'Reconnecting. A QR code will appear here shortly.' },
            { status: 202 },
        );
    } catch (error) {
        console.error('Error during WhatsApp reconnect:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}
