import { NextResponse } from 'next/server';
import { whatsappService } from '@/lib/whatsapp';

export async function POST() {
    try {
        if (!whatsappService) {
            return NextResponse.json({ success: false, error: 'WhatsApp service not initialized' }, { status: 500 });
        }

        const success = await whatsappService.logout();

        if (success) {
            return NextResponse.json({ success: true, message: 'Logged out successfully' });
        } else {
            return NextResponse.json({ success: false, error: 'Failed to logout' }, { status: 500 });
        }
    } catch (error) {
        console.error('Error during logout:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}
