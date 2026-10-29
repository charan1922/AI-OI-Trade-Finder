import Link from 'next/link';
import { cn } from '@/lib/utils';

/** v1 | v2 switch shown on both commentary pages — plain links, no state. */
export function CommentaryVersionSwitch({ current }: { current: 'v1' | 'v2' }) {
  const item = (v: 'v1' | 'v2', href: string) => (
    <Link
      href={href}
      aria-current={current === v ? 'page' : undefined}
      className={cn(
        'rounded px-2 py-0.5 text-[11px] font-semibold',
        current === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {v}
    </Link>
  );
  return (
    <span className="inline-flex items-center rounded-md bg-muted p-0.5">
      {item('v1', '/trade-commentary')}
      {item('v2', '/trade-commentary-v2')}
    </span>
  );
}
