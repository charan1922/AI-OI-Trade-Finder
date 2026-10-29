'use client';

/** AI Elements — Sources: the data a reply was built on ("Used 3 sources"), collapsed by default. */

import { BookOpen, ChevronDown } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';

export function Sources({ children }: { children: ReactNode }) {
  return <Collapsible.Root className="group/sources text-xs">{children}</Collapsible.Root>;
}

export function SourcesTrigger({ count }: { count: number }) {
  return (
    <Collapsible.Trigger className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
      <BookOpen className="size-3.5" />
      <span>
        Used {count} source{count === 1 ? '' : 's'}
      </span>
      <ChevronDown className="size-3 transition-transform group-data-[state=open]/sources:rotate-180" />
    </Collapsible.Trigger>
  );
}

export function SourcesContent({ children }: { children: ReactNode }) {
  return <Collapsible.Content className="mt-1.5 flex flex-col gap-1 pl-5">{children}</Collapsible.Content>;
}

export function Source({ title, href }: { title: string; href?: string }) {
  return href ? (
    <a href={href} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      {title}
    </a>
  ) : (
    <span className="text-muted-foreground">{title}</span>
  );
}
