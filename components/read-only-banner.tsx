'use client';

import { Eye } from 'lucide-react';
import { useRole } from '@/lib/auth/use-role';

/**
 * Shown on pages with action controls when the session is the read-only
 * (viewer) login. Renders nothing for admin — safe to drop into any page.
 * Purely informational: the proxy rejects viewer writes regardless.
 */
export function ReadOnlyBanner({ note }: { note?: string }) {
  const { readOnly } = useRole();
  if (!readOnly) return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
      <Eye className="size-3.5 shrink-0" />
      <span>
        Read-only session — you can view everything, but actions are disabled.
        {note ? ` ${note}` : ''}
      </span>
    </div>
  );
}
