'use client';

/** AI Elements — Model Selector: which model answers. Picking one is the caller's decision (it may confirm). */

import { Check, ChevronDown, Cpu } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

export function ModelSelector({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none"
        >
          <Cpu className="size-3.5" />
          {current?.label ?? value}
          {!disabled && <ChevronDown className="size-3" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => {
              setOpen(false);
              if (o.value !== value) onChange(o.value);
            }}
            className="flex w-full items-start gap-2 rounded-md p-2 text-left text-xs hover:bg-muted"
          >
            <Check className={cn('mt-0.5 size-3', o.value === value ? 'opacity-100' : 'opacity-0')} />
            <span>
              <span className="font-medium">{o.label}</span>
              {o.description && <span className="block text-muted-foreground">{o.description}</span>}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
