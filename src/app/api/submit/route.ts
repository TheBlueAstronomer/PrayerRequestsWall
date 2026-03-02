import { NextResponse } from 'next/server';
import { createPrayer, listActiveWhatsappJids } from '@/lib/prayers';
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
        await createPrayer(message);

        // Send to WhatsApp
        const waMessage = `🙏 *New Anonymous Prayer Request*\n\n${message}\n\nPlease keep this in prayer.`;

        const targets = new Set<string>();
        const groupId = process.env.WHATSAPP_GROUP_ID;
        if (groupId) targets.add(groupId);

        const subscriberJids = await listActiveWhatsappJids();
        for (const jid of subscriberJids) targets.add(jid);

        for (const jid of targets) {
            const sent = await whatsappService.sendMessage(jid, waMessage);
            if (!sent) {
                console.warn(`Message saved but failed to send WhatsApp notification to ${jid}`);
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Submission error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
