import { NextResponse } from 'next/server';
import { db } from '@/db';
import { prayerRequests, appSettings } from '@/db/schema';
import { whatsappService } from '@/lib/whatsapp';
import { eq } from 'drizzle-orm';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { id } = body;

        if (!id || typeof id !== 'number') {
            return NextResponse.json({ error: 'Missing or invalid id' }, { status: 400 });
        }

        const rows = await db.select().from(prayerRequests).where(eq(prayerRequests.id, id));
        if (rows.length === 0) {
            return NextResponse.json({ error: 'Prayer not found' }, { status: 404 });
        }

        const prayer = rows[0];

        const settingsRes = await db.select().from(appSettings).where(eq(appSettings.key, 'whatsapp_group_ids'));
        const groupIdsStr = settingsRes.length > 0 ? settingsRes[0].value : process.env.WHATSAPP_GROUP_ID;

        if (!groupIdsStr) {
            return NextResponse.json({ error: 'No WhatsApp groups configured' }, { status: 400 });
        }

        const groupIds = groupIdsStr.split(',').map((gid: string) => gid.trim()).filter((gid: string) => gid.length > 0);
        if (groupIds.length === 0) {
            return NextResponse.json({ error: 'No WhatsApp groups configured' }, { status: 400 });
        }

        let anyFailed = false;
        for (const targetId of groupIds) {
            const sent = await whatsappService?.sendMessage(targetId, `🙏 *New Anonymous Request:* ${prayer.content}`);
            if (!sent) {
                console.warn(`Resend failed for prayer ${id} to target: ${targetId}`);
                anyFailed = true;
            }
        }

        if (!anyFailed) {
            await db.update(prayerRequests)
                .set({ whatsappSent: true })
                .where(eq(prayerRequests.id, id));
        }

        return NextResponse.json({ success: !anyFailed, partialFailure: anyFailed });
    } catch (error) {
        console.error('Resend error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
