import { NextResponse } from 'next/server';
import { db } from '@/db';
import { prayerRequests } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
    try {
        const prayers = await db.select().from(prayerRequests).orderBy(prayerRequests.createdAt);
        return NextResponse.json({ success: true, prayers });
    } catch (error) {
        console.error('Error fetching prayers for admin:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const url = new URL(request.url);
        const idStr = url.searchParams.get('id');

        if (!idStr) {
            return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
        }

        const id = parseInt(idStr, 10);
        if (isNaN(id)) {
            return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
        }

        await db.delete(prayerRequests).where(eq(prayerRequests.id, id));

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting prayer:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
