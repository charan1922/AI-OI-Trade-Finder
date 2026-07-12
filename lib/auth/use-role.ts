/**
 * Role for UI gating. The value is provided by the root layout (a Server
 * Component that reads the proxy's trusted header + cookie) via React Context —
 * no client fetch, no effect. This file re-exports the hook so existing
 * `@/lib/auth/use-role` imports keep working.
 */
export { RoleProvider, useRole } from '@/components/role-provider';
export type { RoleInfo } from '@/components/role-provider';
