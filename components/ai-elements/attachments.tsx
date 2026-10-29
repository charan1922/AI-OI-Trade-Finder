'use client';

/**
 * AI Elements — Attachments. Two kinds: an IMAGE (a screenshot the operator uploads or pastes — the
 * chat model sees it), or CONTEXT (an open position, a watch or a TF pick, sent as text with the
 * message so the AI reads exactly what the operator saw).
 */

import { ImagePlus, Paperclip, X } from 'lucide-react';
import { type ComponentProps, type ReactNode, useRef } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface AttachmentItem {
  id: string;
  /** Short chip text, e.g. "KOTAKBANK position" or "screenshot.png". */
  label: string;
  /** Context attachments: the text sent with the message. */
  text?: string;
  /** Image attachments: a data URL. */
  image?: string;
  icon?: ReactNode;
}

export function Attachments({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap gap-1', className)} {...props} />;
}

export function Attachment({ item, onRemove }: { item: AttachmentItem; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 py-0.5 pl-0.5 pr-1.5 text-[10px]"
      title={item.text ?? item.label}
    >
      {item.image ? (
        // A local data URL preview — next/image has nothing to optimise here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.image} alt="" className="size-5 rounded object-cover" />
      ) : (
        <span className="pl-1">{item.icon ?? <Paperclip className="size-3" />}</span>
      )}
      <span className="truncate">{item.label}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-foreground" aria-label="Remove">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

/** "Attach" menu: upload an image, or pin one of the context items available right now. */
export function AttachmentPicker({
  options,
  onPick,
  onImages,
  disabled,
}: {
  options: AttachmentItem[];
  onPick: (item: AttachmentItem) => void;
  onImages: (files: File[]) => void;
  disabled?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="ghost" disabled={disabled}>
          <Paperclip /> Attach
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) onImages(files);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex w-full items-center gap-2 rounded-md p-2 text-left text-[11px] hover:bg-muted"
        >
          <ImagePlus className="size-3.5" />
          <span>
            <span className="font-medium">Image / screenshot…</span>
            <span className="block text-muted-foreground">or paste one straight into the message box (Ctrl+V)</span>
          </span>
        </button>
        <div className="my-1 h-px bg-border" />
        {options.length === 0 ? (
          <p className="p-2 text-[11px] text-muted-foreground">
            No context to pin right now — no open position, active watch or TF pick.
          </p>
        ) : (
          options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => onPick(o)}
              className="flex w-full items-start gap-2 rounded-md p-2 text-left text-[11px] hover:bg-muted"
            >
              {o.icon ?? <Paperclip className="mt-0.5 size-3" />}
              <span>
                <span className="font-medium">{o.label}</span>
                <span className="block text-muted-foreground">{o.text}</span>
              </span>
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
