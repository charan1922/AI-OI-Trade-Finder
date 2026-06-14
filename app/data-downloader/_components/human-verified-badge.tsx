import { ShieldCheck } from 'lucide-react';

export function HumanVerifiedBadge({ show }: { show?: boolean }) {
  if (!show) return null;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-300 text-[9px] px-1 py-0.5 bg-amber-100 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/20 rounded"
      title="Verified from broker screenshots"
    >
      <ShieldCheck className="w-3 h-3" />
      verified
    </span>
  );
}
