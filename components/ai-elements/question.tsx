'use client';

/** AI Elements — Question (shadcn "Questionnaire"): a decision waiting on the operator, with choices. */

import { MessageCircleQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface QuestionOption {
  label: string;
  variant?: 'default' | 'outline' | 'destructive';
  onSelect: () => void;
}

export function Question({
  title,
  description,
  options,
  disabled,
  note,
}: {
  title: string;
  description?: string;
  options: QuestionOption[];
  disabled?: boolean;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-sky-300 bg-sky-50/60 p-2 text-[10px] dark:border-sky-500/40 dark:bg-sky-500/5">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0 text-sky-600" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          {description && <p className="text-muted-foreground">{description}</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((o) => (
          <Button key={o.label} size="xs" variant={o.variant ?? 'outline'} disabled={disabled} onClick={o.onSelect}>
            {o.label}
          </Button>
        ))}
      </div>
      {note && <p className="mt-1.5 text-muted-foreground">{note}</p>}
    </div>
  );
}
