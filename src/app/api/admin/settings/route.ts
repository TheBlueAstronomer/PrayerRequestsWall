import { NextResponse } from 'next/server';
import { db } from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
    try {
        const result = await db.select().from(appSettings).where(eq(appSettings.key, 'whatsapp_group_ids'));
        const ids = result.length > 0 ? result[0].value : '';
        return NextResponse.json({ success: true, whatsapp_group_ids: ids });
    } catch (error) {
        console.error('Error fetching settings:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { whatsapp_group_ids } = body;

        if (typeof whatsapp_group_ids !== 'string') {
            return NextResponse.json({ error: 'Invalid group IDs' }, { status: 400 });
        }

        // Check if exists
        const existing = await db.select().from(appSettings).where(eq(appSettings.key, 'whatsapp_group_ids'));
        if (existing.length > 0) {
            await db.update(appSettings)
                .set({ value: whatsapp_group_ids })
                .where(eq(appSettings.key, 'whatsapp_group_ids'));
        } else {
            await db.insert(appSettings).values({ key: 'whatsapp_group_ids', value: whatsapp_group_ids });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error updating settings:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
