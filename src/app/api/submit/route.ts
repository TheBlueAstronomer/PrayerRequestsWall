import { NextResponse } from 'next/server';
import { db } from '@/db';
import { prayerRequests } from '@/db/schema';
import { whatsappService } from '@/lib/whatsapp';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { message } = body;

        // Validation
        if (!message || typeof message !== 'string') {
            return NextResponse.json({ error: 'Message is required' }, { status: 400 });
        }
        if (message.length > 1000) {
            return NextResponse.json({ error: 'Message too long (max 1000 chars)' }, { status: 400 });
        }

        // Store in DB
        await db.insert(prayerRequests).values({
            content: message,
        });

        // Send to WhatsApp
        const groupId = process.env.WHATSAPP_GROUP_ID;
        if (groupId) {
            // We don't await this necessarily to return fast response, but better to await for error handlng?
            // PRD says "Real-time forwarding". Best effort.
            // If we await, user waits.
            const sent = await whatsappService.sendMessage(groupId, `🙏 *New Anonymous Request:* ${message}`);
            if (!sent) {
                console.warn('Message saved but failed to send to WhatsApp');
            }
        } else {
            console.warn('WHATSAPP_GROUP_ID not set, skipping WhatsApp message');
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Submission error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
