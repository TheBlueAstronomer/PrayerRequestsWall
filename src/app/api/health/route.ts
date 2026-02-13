import { NextResponse } from 'next/server';

export async function GET() {
    // In a real app, you might check DB connectivity here
    // For now, just returning 200 indicates the Next.js server is up and running
    return NextResponse.json({ status: 'ok' }, { status: 200 });
}
