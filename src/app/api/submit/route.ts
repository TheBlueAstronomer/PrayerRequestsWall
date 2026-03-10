import { NextResponse } from 'next/server';
import { db } from '@/db';
import { prayerRequests, appSettings } from '@/db/schema';
import { whatsappService } from '@/lib/whatsapp';
import { eq } from 'drizzle-orm';

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
        const inserted = await db.insert(prayerRequests).values({
            content: message,
        }).returning({ id: prayerRequests.id });

        const prayerId = inserted[0].id;

        // Fetch target group IDs from DB
        const settingsRes = await db.select().from(appSettings).where(eq(appSettings.key, 'whatsapp_group_ids'));
        const groupIdsStr = settingsRes.length > 0 ? settingsRes[0].value : process.env.WHATSAPP_GROUP_ID;

        let allSent = false;
        if (groupIdsStr) {
            const groupIds = groupIdsStr.split(',').map(id => id.trim()).filter(id => id.length > 0);
            if (groupIds.length > 0) {
                let anyFailed = false;
                for (const targetId of groupIds) {
                    const sent = await whatsappService?.sendMessage(targetId, `🙏 *New Anonymous Request:* ${message}`);
                    if (!sent) {
                        console.warn(`Message saved but failed to send to WhatsApp target: ${targetId}`);
                        anyFailed = true;
                    }
                }
                allSent = !anyFailed;
            }
        } else {
            console.warn('No WHATSAPP_GROUP_ID found in DB or ENV, skipping WhatsApp message');
        }

        if (allSent) {
            await db.update(prayerRequests)
                .set({ whatsappSent: true })
                .where(eq(prayerRequests.id, prayerId));
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Submission error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
