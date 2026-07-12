import { handlers } from '@/auth';

/**
 * Auth.js catch-all endpoints (/api/auth/signin, /callback/google, /csrf,
 * /session, …). Our own static routes (login, logout, me) win over this
 * dynamic segment by Next's routing rules, so both systems coexist under
 * /api/auth. The proxy lets the Auth.js paths through unauthenticated — they
 * ARE the authentication step.
 */
export const { GET, POST } = handlers;
