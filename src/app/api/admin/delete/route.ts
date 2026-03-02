import { NextResponse } from 'next/server';
import { deletePrayerById, deletePrayersOlderThan, deletePrayersOlderThanHours } from '@/lib/prayers';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { adminKey, id, olderThanDays, olderThanHours } = body ?? {};

    if (!process.env.ADMIN_PASSWORD) {
      return NextResponse.json({ error: 'ADMIN_PASSWORD not configured' }, { status: 500 });
    }

    if (!adminKey || adminKey !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (typeof id === 'number') {
      await deletePrayerById(id);
      return NextResponse.json({ success: true, deleted: 1, mode: 'id' });
    }

    if (typeof olderThanHours === 'number') {
      const deleted = await deletePrayersOlderThanHours(olderThanHours);
      return NextResponse.json({ success: true, deleted, mode: 'olderThanHours' });
    }

    if (typeof olderThanDays === 'number') {
      const deleted = await deletePrayersOlderThan(olderThanDays);
      return NextResponse.json({ success: true, deleted, mode: 'olderThanDays' });
    }

    return NextResponse.json({ error: 'Provide either id, olderThanHours, or olderThanDays' }, { status: 400 });
  } catch (error) {
    console.error('Admin delete error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
