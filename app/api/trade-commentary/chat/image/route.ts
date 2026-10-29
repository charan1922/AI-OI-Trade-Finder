import { NextResponse } from 'next/server';
import { readImage } from '@/lib/operator-chat/images';

/**
 * GET /api/trade-commentary/chat/image?name=<messageId>-<n>.<ext> — a screenshot the operator attached
 * in the chat. Admin-only like the rest of the thread (chat prefix in lib/auth/rbac.ts).
 */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get('name') ?? '';
  const img = await readImage(name);
  if (!img) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return new NextResponse(new Uint8Array(img.bytes), {
    headers: { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400' },
  });
}
