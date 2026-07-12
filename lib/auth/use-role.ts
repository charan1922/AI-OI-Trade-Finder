'use client';

/**
 * Client-side role lookup — powers UI gating only (disable/hide action
 * controls for read-only sessions). The proxy is the enforcement layer; if
 * this hook is ever wrong the worst case is a button that 403s with a clear
 * message. Fetched once per app load and cached module-wide, so any number of
 * components can call useRole() for the price of one /api/auth/me request.
 *
 * Fails OPEN to admin: on a fetch error an admin keeps a working UI and a
 * viewer merely sees buttons the server will still reject.
 */
import { useEffect, useState } from 'react';
import type { Role } from './rbac';

export interface RoleInfo {
  role: Role;
  /** True for the read-only login — disable every action control. */
  readOnly: boolean;
  /** False until /api/auth/me has answered (defaults to admin meanwhile). */
  loaded: boolean;
}

let cachedRole: Role | null = null;
let inFlight: Promise<Role> | null = null;

async function fetchRole(): Promise<Role> {
  try {
    const res = await fetch('/api/auth/me');
    const j = (await res.json()) as { role?: string };
    return j.role === 'viewer' ? 'viewer' : 'admin';
  } catch {
    return 'admin';
  }
}

export function useRole(): RoleInfo {
  const [info, setInfo] = useState<RoleInfo>(() =>
    cachedRole
      ? { role: cachedRole, readOnly: cachedRole === 'viewer', loaded: true }
      : { role: 'admin', readOnly: false, loaded: false },
  );

  useEffect(() => {
    if (cachedRole) return; // initial state already carries the answer
    let alive = true;
    inFlight ??= fetchRole();
    inFlight.then((role) => {
      cachedRole = role;
      if (alive) setInfo({ role, readOnly: role === 'viewer', loaded: true });
    });
    return () => {
      alive = false;
    };
  }, []);

  return info;
}
