'use client';

import { createContext, useContext } from 'react';
import type { Role } from '@/lib/auth/rbac';

/**
 * Role context — the App Router way. The root layout (a Server Component) reads
 * the caller's role from the proxy's trusted `x-app-role` header and the display
 * username from the cookie, then hands them here. No client fetch, no effect, no
 * loading flash — the value is correct from the first server render and only
 * changes on a full reload (login/logout both hard-navigate).
 */
export interface RoleInfo {
  role: Role;
  /** True for the read-only login — disable every action control. */
  readOnly: boolean;
  /** Display-only name from login (header greeting). */
  username: string;
  /** True when the password gate is active (production). Local dev → false, so
   *  the UI hides logout (no session to end). */
  gateEnabled: boolean;
}

const RoleContext = createContext<RoleInfo>({
  role: 'admin',
  readOnly: false,
  username: 'Analyst',
  gateEnabled: false,
});

export function RoleProvider({ value, children }: { value: RoleInfo; children: React.ReactNode }) {
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleInfo {
  return useContext(RoleContext);
}
