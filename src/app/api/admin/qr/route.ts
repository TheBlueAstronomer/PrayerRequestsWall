import { NextResponse } from 'next/server';
import { whatsappService } from '@/lib/whatsapp';

export async function GET() {
    try {
        const qr = whatsappService?.latestQR;
        return NextResponse.json({ success: true, qr });
    } catch (error) {
        console.error('Error fetching QR code:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
