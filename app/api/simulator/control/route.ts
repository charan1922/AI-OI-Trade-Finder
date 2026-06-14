import { NextResponse } from 'next/server';
import type { SimulatorConfig } from '@/lib/simulator';
import { replayEngine } from '@/lib/simulator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET → current engine status. */
export async function GET() {
  return NextResponse.json({ success: true, data: replayEngine.status() });
}

interface ControlBody {
  action: 'load' | 'play' | 'pause' | 'step' | 'seek' | 'seekTime' | 'speed' | 'reset';
  config?: Partial<SimulatorConfig>;
  candleIndex?: number;
  time?: number;
  speed?: number;
}

/**
 * POST → drive the replay engine. One endpoint, action-dispatched, so the UI
 * has a single control surface (load / play / pause / step / seek / speed / reset).
 */
export async function POST(req: Request) {
  let body: ControlBody;
  try {
    body = (await req.json()) as ControlBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    switch (body.action) {
      case 'load': {
        const status = await replayEngine.load(body.config ?? {});
        return NextResponse.json({ success: true, data: status });
      }
      case 'play':
        return NextResponse.json({ success: true, data: replayEngine.play() });
      case 'pause':
        return NextResponse.json({ success: true, data: replayEngine.pause() });
      case 'step':
        return NextResponse.json({ success: true, data: replayEngine.step() });
      case 'seek':
        return NextResponse.json({ success: true, data: replayEngine.seek(body.candleIndex ?? 0) });
      case 'seekTime':
        return NextResponse.json({ success: true, data: replayEngine.seekTime(body.time ?? 0) });
      case 'speed':
        return NextResponse.json({ success: true, data: replayEngine.setSpeed(body.speed ?? 1) });
      case 'reset':
        return NextResponse.json({ success: true, data: replayEngine.reset() });
      default:
        return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
