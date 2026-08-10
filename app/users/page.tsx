'use client';

/**
 * /users — who can sign in, and what they can do. OWNER-ONLY.
 *
 * User rule 2026-08-10: "i am the main guy i should be able to add admin or
 * viewer nd no other can". A plain admin has full trading access but never sees
 * or reaches this page — the proxy redirects them home and /api/users 403s.
 *
 * Two kinds of row, deliberately distinguished so the screen never overstates
 * what it controls:
 *   • Locked (code) — OWNER_GOOGLE_EMAILS / ADMIN_GOOGLE_EMAILS in
 *     lib/auth/rbac.ts. Checked BEFORE the database, so they cannot be changed
 *     or revoked here; that needs a code change + deploy.
 *   • Managed (database) — rows in app_users. Add/change/remove takes effect on
 *     the person's next request, no redeploy.
 */

import { AlertTriangle, Loader2, Lock, RefreshCw, Trash2, UserPlus, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface AppUser {
  email: string;
  name: string | null;
  role: string;
  plan: string;
  status: string;
  createdAt: string;
  lastSeenAt: string;
  /** null = never granted access; the row only records that they signed in once
   *  (back when the allowlist allowed it). Such a row conveys NO access. */
  grantedAt: string | null;
}

type NewRole = 'admin' | 'viewer';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
}

const ROLE_HELP: Record<NewRole, string> = {
  admin: 'Full access — can trade, sync data, spend AI credits. Cannot manage users.',
  viewer: 'Read-only — sees every data page, but every action is refused.',
};

export default function UsersPage() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [codeAdmins, setCodeAdmins] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<NewRole>('viewer');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/users', { cache: 'no-store' });
      const data = (await res.json()) as {
        success: boolean;
        users?: AppUser[];
        owners?: string[];
        codeAdmins?: string[];
        error?: string;
      };
      if (data.success) {
        setUsers(data.users ?? []);
        setOwners(data.owners ?? []);
        setCodeAdmins(data.codeAdmins ?? []);
        setError(null);
      } else {
        setError(data.error ?? 'failed to load');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred kick (same pattern as /prompts): loading on the next tick instead
  // of synchronously in the effect body avoids the cascading-render lint error.
  useEffect(() => {
    let stopped = false;
    const kick = setTimeout(() => {
      if (!stopped) void load();
    }, 0);
    return () => {
      stopped = true;
      clearTimeout(kick);
    };
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>, key: string) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as { success: boolean; error?: string; warning?: string };
        if (!data.success) {
          setError(data.error ?? 'request failed');
          return false;
        }
        if (data.warning) setNotice(data.warning);
        await load();
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  const add = useCallback(async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    const ok = await post({ action: 'set-role', email: trimmed, role }, `add:${trimmed}`);
    if (ok) setEmail('');
  }, [email, role, post]);

  /**
   * One row per person. Merges the two sources: emails hardcoded in
   * ADMIN_GOOGLE_EMAILS (which may or may not have a database row yet) and rows
   * added on this screen. A code-listed admin with no row is admin by code; once
   * a row exists, the row wins — including a revoke.
   */
  const ownerSet = new Set(owners);
  const codeSet = new Set(codeAdmins);
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const rows = [
    ...codeAdmins.map((e) => {
      const row = byEmail.get(e);
      return {
        email: e,
        name: row?.name ?? null,
        role: row?.role ?? 'admin',
        status: row?.status ?? 'active',
        lastSeenAt: row?.lastSeenAt ?? null,
        inCode: true,
        // Code-listed operators have access from code, grant stamp or not.
        granted: true,
      };
    }),
    ...users
      .filter((u) => !ownerSet.has(u.email) && !codeSet.has(u.email))
      .map((u) => ({
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        lastSeenAt: u.lastSeenAt as string | null,
        inCode: false,
        granted: u.grantedAt != null,
      })),
  ];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Users className="size-5" />
        <h1 className="text-lg font-bold tracking-tight">Users &amp; Access</h1>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded border border-border p-1.5 hover:bg-muted"
          title="Refresh"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Only you (the owner) can open this page. Anyone you add here signs in with Google; anyone not listed is refused
        a session entirely. Changes apply on their next request — no redeploy.
      </p>

      {error && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* Add / change */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-bold">Give someone access</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Add them before they sign in — an unlisted Google account is turned away at the door. Re-adding an existing
          email just changes their role.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
            placeholder="name@gmail.com"
            className="min-w-[16rem] flex-1 rounded border border-border bg-background px-2.5 py-1.5 text-sm"
          />
          <div className="flex overflow-hidden rounded border border-border">
            {(['viewer', 'admin'] as NewRole[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                title={ROLE_HELP[r]}
                className={`px-3 py-1.5 text-xs font-medium capitalize ${
                  role === r ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void add()}
            disabled={!email.trim() || busy !== null}
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy?.startsWith('add:') ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />}
            Add
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{ROLE_HELP[role]}</p>
      </section>

      {/* The owner — the one row nothing here can touch */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-bold">
          <Lock className="size-3.5" /> You (owner)
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Hardcoded in <code className="rounded bg-muted px-1">lib/auth/rbac.ts</code> and checked before anything in
          the database — so no action on this page, and no database mistake, can lock you out of your own app. Changing
          it needs a code change and a deploy, on purpose.
        </p>
        <ul className="mt-2 divide-y divide-border">
          {owners.map((e) => (
            <li key={e} className="flex items-center gap-2 py-2">
              <span className="font-mono text-xs">{e}</span>
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                Owner
              </span>
              <span className="text-[11px] text-muted-foreground">full access + manages this page</span>
              <Lock className="ml-auto size-3.5 text-muted-foreground" />
            </li>
          ))}
        </ul>
      </section>

      {/* Everyone else */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-bold">Everyone else ({rows.length})</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Change a role or revoke access at any time. Revoking is reversible — the account is remembered as revoked and
          simply stops being let in; click Restore to bring it back.
        </p>
        {rows.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {loading ? 'loading…' : 'Nobody yet. Add an email above to let them in.'}
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Email</th>
                  <th className="py-1.5 pr-3 font-medium">Access</th>
                  <th className="py-1.5 pr-3 font-medium">Last seen</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((u) => {
                  const revoked = u.status === 'revoked';
                  // Signed in at some point but never granted access by you —
                  // shown so you can grant with one click, NOT because they can
                  // currently get in. They cannot.
                  const seenOnly = !revoked && !u.granted;
                  return (
                    <tr key={u.email} className={revoked ? 'opacity-60' : undefined}>
                      <td className="py-2 pr-3">
                        <span className="font-mono">{u.email}</span>
                        {u.name && <span className="ml-1.5 text-muted-foreground">({u.name})</span>}
                        {u.inCode && (
                          <span
                            className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                            title="Also listed in ADMIN_GOOGLE_EMAILS in code. Anything set here overrides it."
                          >
                            in code
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {revoked ? (
                          <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700 dark:text-red-300">
                            Revoked
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            {seenOnly && (
                              <span
                                className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground"
                                title="Signed in at some point but you never granted access, so they cannot get in. Click Viewer or Admin to grant."
                              >
                                No access
                              </span>
                            )}
                            <div className="flex overflow-hidden rounded border border-border">
                              {(['viewer', 'admin'] as NewRole[]).map((r) => (
                                <button
                                  key={r}
                                  type="button"
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void post({ action: 'set-role', email: u.email, role: r }, `role:${u.email}`)
                                  }
                                  title={seenOnly ? `Grant ${r} — ${ROLE_HELP[r]}` : ROLE_HELP[r]}
                                  className={`px-2 py-1 text-[11px] font-medium capitalize disabled:opacity-50 ${
                                    !seenOnly && u.role === r
                                      ? 'bg-primary text-primary-foreground'
                                      : 'bg-background hover:bg-muted'
                                  }`}
                                >
                                  {r}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{fmtDate(u.lastSeenAt)}</td>
                      <td className="py-2 text-right">
                        {revoked ? (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              void post({ action: 'set-role', email: u.email, role: 'viewer' }, `role:${u.email}`)
                            }
                            className="rounded border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"
                            title="Restore as viewer"
                          >
                            {busy === `role:${u.email}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              'Restore'
                            )}
                          </button>
                        ) : seenOnly ? null : (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => {
                              if (confirm(`Revoke access for ${u.email}? They will no longer be able to sign in.`)) {
                                void post({ action: 'remove', email: u.email }, `del:${u.email}`);
                              }
                            }}
                            className="rounded border border-border p-1.5 text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
                            title="Revoke access"
                          >
                            {busy === `del:${u.email}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
