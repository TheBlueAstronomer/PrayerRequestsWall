import { NextResponse } from 'next/server';
import { whatsappService } from '@/lib/whatsapp';

/**
 * WhatsApp connection health, for the "can't send for N minutes" uptime net.
 *
 * 200 when the client is connected and able to send; 503 otherwise. A Cloud
 * Monitoring uptime check polls this and alerts only after a sustained failure
 * (a ~10-minute debounce in the alert policy), so it ignores the brief not-ready
 * window after a redeploy and only pages on a real, persistent outage.
 *
 * Kept on a separate path from /api/health on purpose: the site-uptime alert
 * must not fire just because WhatsApp is disconnected while the site itself is
 * fine. This is intentionally public (the external prober has no session) and
 * returns only a coarse status, no session detail.
 */
export async function GET() {
    const connected = whatsappService?.isConnected() ?? false;
    const needsScan = !!whatsappService?.latestQR;

    return NextResponse.json(
        { status: connected ? 'ok' : 'unavailable', connected, needsScan },
        { status: connected ? 200 : 503 },
    );
}
