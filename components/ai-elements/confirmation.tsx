'use client';

/**
 * AI Elements — Confirmation: an action the AI proposed. Nothing happens until the operator taps
 * Confirm; the server claims it atomically and runs it through the same gated code as /auto-trade.
 */

import { CheckCircle2, Loader2, ShieldQuestion, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ConfirmationStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';

export function Confirmation({
  title,
  status,
  result,
  canAct,
  onConfirm,
  onCancel,
}: {
  title: string;
  status: ConfirmationStatus;
  result?: string | null;
  canAct: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border p-2 text-xs',
        status === 'pending' ? 'border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/5' : 'border-border bg-card'
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldQuestion className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
        <span className="flex-1">{title}</span>
      </div>
      {status === 'pending' && canAct && (
        <div className="flex gap-2">
          <Button size="sm" onClick={onConfirm}>
            Confirm
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
      {status === 'pending' && !canAct && <p className="text-xs text-muted-foreground">Waiting for an admin to confirm.</p>}
      {status === 'running' && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Running…
        </p>
      )}
      {status === 'done' && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-3" /> {result ?? 'Done'}
        </p>
      )}
      {status === 'failed' && (
        <p className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400">
          <XCircle className="size-3" /> {result ?? 'Failed'}
        </p>
      )}
      {status === 'cancelled' && <p className="text-xs text-muted-foreground">Cancelled.</p>}
      {status === 'expired' && <p className="text-xs text-muted-foreground">Expired — ask again for a fresh card.</p>}
    </div>
  );
}
