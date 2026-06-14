import type { NextRequest } from 'next/server';
import { replayEngine } from '@/lib/simulator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * SSE stream of the market simulator. Mirrors the live-feed contract so the
 * front-end can consume replay exactly like the real Dhan live feed.
 */
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (controllerRef) {
      replayEngine.removeClient(controllerRef);
      controllerRef = null;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(encoder.encode(`: connected\n\n`));
      replayEngine.addClient(controller);

      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          cleanup();
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      cleanup();
    },
  });

  req.signal.onabort = () => {
    cleanup();
    try {
      controllerRef?.close();
    } catch {
      // already closed
    }
  };

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
