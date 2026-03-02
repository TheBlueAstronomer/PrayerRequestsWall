import { NextResponse } from 'next/server';
import { addWhatsappSubscriber, listWhatsappSubscribers, removeWhatsappSubscriber } from '@/lib/prayers';

function isAuthed(adminKey?: string) {
  return Boolean(process.env.ADMIN_PASSWORD) && adminKey === process.env.ADMIN_PASSWORD;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const adminKey = searchParams.get('adminKey') || undefined;

  if (!isAuthed(adminKey)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const subs = await listWhatsappSubscribers();
  return NextResponse.json({ subscribers: subs });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { adminKey, waJid } = body ?? {};
  if (!isAuthed(adminKey)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!waJid || typeof waJid !== 'string') return NextResponse.json({ error: 'waJid required' }, { status: 400 });

  await addWhatsappSubscriber(waJid.trim());
  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request) {
  const body = await request.json();
  const { adminKey, waJid } = body ?? {};
  if (!isAuthed(adminKey)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!waJid || typeof waJid !== 'string') return NextResponse.json({ error: 'waJid required' }, { status: 400 });

  await removeWhatsappSubscriber(waJid.trim());
  return NextResponse.json({ success: true });
}
