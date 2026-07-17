import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { adminOnly } from '@/lib/auth/server';
import { buildDumpFile } from '@/lib/db-explorer/dump';

export const dynamic = 'force-dynamic';
// A full clone build + stream of the whole DB can take a while — give it room.
export const maxDuration = 300;

/**
 * POST /api/db-explorer/dump  { full?: boolean }
 *
 * Streams a SQLite copy of THIS server's live DB (curated subset by default,
 * whole DB when full) as application/octet-stream. Powers `pnpm db:pull-prod`
 * over HTTPS instead of SSH. Admin-only (also under /api/db-explorer, which the
 * proxy admin-gates); read-only against the live DB — it never writes prod.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;

  let full = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { full?: boolean };
    full = body?.full === true;
  } catch {
    // no/invalid body → subset
  }

  let tmpPath: string;
  try {
    tmpPath = buildDumpFile(full);
  } catch (err) {
    return NextResponse.json({ success: false, error: `dump build failed: ${String(err)}` }, { status: 500 });
  }

  let size = 0;
  try {
    size = fs.statSync(tmpPath).size;
  } catch {
    return NextResponse.json({ success: false, error: 'dump file vanished after build' }, { status: 500 });
  }

  // Stream the temp file out, then delete it once the stream closes (covers both
  // success and client abort). POSIX keeps the inode alive for the open fd, so
  // the unlink is safe even mid-stream.
  const nodeStream = fs.createReadStream(tmpPath);
  const cleanup = () => {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // already gone
    }
  };
  nodeStream.on('close', cleanup);
  nodeStream.on('error', cleanup);

  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="${full ? 'clone' : 'subset'}.db"`,
      'Cache-Control': 'no-store',
    },
  });
}
