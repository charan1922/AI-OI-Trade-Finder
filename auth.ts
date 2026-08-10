/**
 * Auth.js (NextAuth v5) — Google sign-in, official quickstart shape
 * (https://authjs.dev/getting-started/installation):
 *
 *   auth.ts                              ← this file (config + exports)
 *   app/api/auth/[...nextauth]/route.ts  ← export const { GET, POST } = handlers
 *   proxy.ts                             ← export const proxy = auth(<existing gate>)
 *
 * The Google provider reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET from env by
 * Auth.js convention, and sessions are stateless JWTs signed with AUTH_SECRET
 * — no database tables, so nothing here can ever touch trading data.
 *
 * Access control: ADMIN_GOOGLE_EMAILS → admin; GOOGLE_VIEWER_EMAILS → viewer;
 * every other account is denied before a session is issued. Role mapping
 * lives in lib/auth/rbac.ts and is reused by proxy.ts.
 *
 * Google Cloud Console → the OAuth client must list the callback URL
 *   <origin>/api/auth/callback/google
 * for every host this runs on (http://localhost:5001 and production).
 */
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { roleForGoogleEmail } from '@/lib/auth/rbac';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: {
    strategy: 'jwt',
    // Match the password-cookie session length (lib/auth/session.ts).
    maxAge: 7 * 24 * 60 * 60,
  },
  // Behind Railway's proxy the Host header is forwarded — trust it (the proxy
  // gate itself is ours, so this does not weaken auth).
  trustHost: true,
  pages: {
    signIn: '/login',
    // Failed/refused sign-ins land back on our login page; it shows ?error=.
    error: '/login',
  },
  callbacks: {
    // Verified email plus explicit role allowlist; unlisted accounts get no
    // Auth.js session even if Google OAuth itself accepts them.
    async signIn({ profile }) {
      if (profile?.email_verified !== true) return false;
      // Load the owner-managed registry (app_users) so someone the owner just
      // added on /users can sign in with no redeploy. Dynamically imported:
      // proxy.ts imports THIS file, so Prisma must not enter its static graph.
      // A failure here falls through to the hardcoded lists in rbac.ts.
      try {
        const { refreshRoleRegistry } = await import('@/lib/auth/users');
        await refreshRoleRegistry({ force: true });
      } catch {
        /* registry unavailable — hardcoded operators can still sign in */
      }
      return roleForGoogleEmail(profile.email, process.env.GOOGLE_VIEWER_EMAILS) != null;
    },
  },
});
