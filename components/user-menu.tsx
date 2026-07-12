'use client';

import { Eye, LogOut, ShieldCheck } from 'lucide-react';
import { useRole } from '@/lib/auth/use-role';
import { cn } from '@/lib/utils';

/**
 * Header role chip + logout link. Renders nothing until we know the gate is on
 * (local dev has no session to end). The role chip doubles as the read-only
 * indicator so a viewer always knows which login they're on.
 *
 * Sign-out is a plain link to GET /api/auth/logout, which clears the cookie and
 * 302s to /login in one response — a single browser navigation with no client
 * fetch, so it can't hang behind a busy page's in-flight requests (e.g. /live).
 */
export function UserMenu() {
  const { readOnly, username, gateEnabled } = useRole();

  if (!gateEnabled) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span className="hidden text-xs font-medium text-muted-foreground sm:inline">{username}</span>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium',
          readOnly
            ? 'border-amber-300/60 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
            : 'border-emerald-300/60 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
        )}
        title={readOnly ? 'Read-only session — actions are disabled' : 'Operator session — full access'}
      >
        {readOnly ? <Eye className="size-3" /> : <ShieldCheck className="size-3" />}
        {readOnly ? 'Read-only' : 'Operator'}
      </span>
      {/* Deliberate <a>: logout must be ONE full browser navigation (the API
          route clears cookies + redirects) — a client-side <Link /> transition
          would not carry the Set-Cookie response through. The lint rule fires
          because /api/auth now contains the Auth.js catch-all segment. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/api/auth/logout"
        title="Sign out"
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <LogOut className="size-4" />
        <span className="hidden sm:inline">Sign out</span>
      </a>
    </div>
  );
}
