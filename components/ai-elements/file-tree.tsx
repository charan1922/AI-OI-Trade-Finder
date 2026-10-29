'use client';

/** AI Elements — File Tree: a navigable tree (here: today's workspace — watches, notebook, wake-ups). */

import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';

export function FileTree({ children }: { children: ReactNode }) {
  return <div className="flex flex-col text-[10px]" role="tree">{children}</div>;
}

export function FileTreeFolder({
  name,
  count,
  defaultOpen = true,
  children,
}: {
  name: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="group/folder" role="treeitem">
      <Collapsible.Trigger className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted/50">
        <ChevronRight className="size-3 text-muted-foreground transition-transform group-data-[state=open]/folder:rotate-90" />
        <Folder className="size-3 text-amber-600 group-data-[state=open]/folder:hidden" />
        <FolderOpen className="hidden size-3 text-amber-600 group-data-[state=open]/folder:block" />
        <span className="font-medium">{name}</span>
        {count != null && <span className="text-muted-foreground tabular-nums">({count})</span>}
      </Collapsible.Trigger>
      <Collapsible.Content className="ml-3 border-l border-border/60 pl-2" role="group">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function FileTreeFile({ name, badge, onSelect }: { name: string; badge?: ReactNode; onSelect?: () => void }) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={false}
      onClick={onSelect}
      className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted/50"
    >
      <FileText className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {badge}
    </button>
  );
}
