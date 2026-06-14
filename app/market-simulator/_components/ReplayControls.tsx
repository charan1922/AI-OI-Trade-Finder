'use client';

import { Clock, Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SIM_SPEEDS } from '@/lib/simulator/config';
import type { UseSimulator } from '../_hooks/use-simulator';

const IST = 5.5 * 3600;

function istTime(unixSeconds: number | null): string {
  if (!unixSeconds) return '--:--:--';
  return new Date((unixSeconds + IST) * 1000).toISOString().slice(11, 19);
}

/** UTC epoch seconds → "YYYY-MM-DDTHH:MM" IST wall-clock (for a datetime-local input). */
function toIstInput(unixSeconds: number): string {
  return new Date((unixSeconds + IST) * 1000).toISOString().slice(0, 16);
}

/** Parse an IST "YYYY-MM-DDTHH:MM" value back to UTC epoch seconds. */
function fromIstInput(value: string): number | null {
  const [date, time] = value.split('T');
  if (!date || !time) return null;
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000) - IST;
}

/** Transport bar: play/pause/step/reset + speed + seek scrubber. */
export default function ReplayControls({ sim }: { sim: UseSimulator }) {
  const { status, meta } = sim;
  const ready = status.totalTicks > 0;
  const playing = status.state === 'playing';
  const stepSec = meta ? Number(meta.interval) * 60 : 300;

  return (
    <div className="flex items-center gap-3 border-t border-border bg-card/40 px-3 py-2">
      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant={playing ? 'secondary' : 'default'}
          disabled={!ready}
          onClick={() => (playing ? sim.pause() : sim.play())}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button size="icon-sm" variant="outline" disabled={!ready || playing} onClick={() => sim.step()} title="Step">
          <SkipForward />
        </Button>
        <Button size="icon-sm" variant="outline" disabled={!ready} onClick={() => sim.reset()} title="Reset">
          <RotateCcw />
        </Button>
      </div>

      {/* Speed */}
      <div className="flex items-center gap-1">
        {SIM_SPEEDS.map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => sim.setSpeed(s)}
            className={`rounded px-1.5 py-0.5 text-[11px] font-mono transition-colors ${
              status.speed === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            {s}×
          </button>
        ))}
      </div>

      {/* Jump to time (IST) */}
      {ready && meta && (
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Jump to time (IST)">
          <Clock className="size-3.5 text-muted-foreground" />
          <input
            type="datetime-local"
            min={toIstInput(meta.firstTime)}
            max={toIstInput(meta.lastTime)}
            step={stepSec}
            value={status.simTime ? toIstInput(status.simTime) : ''}
            onChange={(e) => {
              const epoch = fromIstInput(e.target.value);
              if (epoch !== null) sim.seekTime(epoch);
            }}
            className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] outline-none [color-scheme:dark] focus:border-primary"
          />
        </label>
      )}

      {/* Scrubber */}
      <input
        type="range"
        min={0}
        max={Math.max(0, status.totalCandles - 1)}
        value={status.candleIndex}
        disabled={!ready}
        onChange={(e) => sim.seek(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-primary"
      />

      <div className="w-44 text-right font-mono text-[11px] text-muted-foreground">
        {istTime(status.simTime)} · {status.candleIndex + (ready ? 1 : 0)}/{status.totalCandles}
        <span className="ml-1 text-muted-foreground">({Math.round(status.progress * 100)}%)</span>
      </div>
    </div>
  );
}
