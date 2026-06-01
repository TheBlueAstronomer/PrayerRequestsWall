import { NextResponse } from 'next/server';
import { db } from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

async function upsertSetting(key: string, value: string) {
    const existing = await db.select().from(appSettings).where(eq(appSettings.key, key));
    if (existing.length > 0) {
        await db.update(appSettings)
            .set({ value })
            .where(eq(appSettings.key, key));
    } else {
        await db.insert(appSettings).values({ key, value });
    }
}

export async function GET() {
    try {
        const groupResult = await db.select().from(appSettings).where(eq(appSettings.key, 'whatsapp_group_ids'));
        const testGroupResult = await db.select().from(appSettings).where(eq(appSettings.key, 'whatsapp_test_group_id'));
        const ids = groupResult.length > 0 ? groupResult[0].value : '';
        const testGroupId = testGroupResult.length > 0 ? testGroupResult[0].value : '';
        return NextResponse.json({ success: true, whatsapp_group_ids: ids, whatsapp_test_group_id: testGroupId });
    } catch (error) {
        console.error('Error fetching settings:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { whatsapp_group_ids, whatsapp_test_group_id } = body;
        const hasTestGroupId = Object.prototype.hasOwnProperty.call(body, 'whatsapp_test_group_id');

        if (typeof whatsapp_group_ids !== 'string' || (hasTestGroupId && typeof whatsapp_test_group_id !== 'string')) {
            return NextResponse.json({ error: 'Invalid group IDs' }, { status: 400 });
        }

        await upsertSetting('whatsapp_group_ids', whatsapp_group_ids);
        if (hasTestGroupId) {
            await upsertSetting('whatsapp_test_group_id', whatsapp_test_group_id);
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error updating settings:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
