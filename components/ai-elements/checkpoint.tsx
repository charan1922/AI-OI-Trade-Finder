/** AI Elements — Checkpoint: a marker in the thread (here: a session milestone the day crossed). */

import { Flag } from 'lucide-react';

export function Checkpoint({ label, time }: { label: string; time?: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground" role="separator">
      <span className="h-px flex-1 bg-border" />
      <Flag className="size-3" />
      <span>
        {time && <span className="tabular-nums">{time} · </span>}
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
