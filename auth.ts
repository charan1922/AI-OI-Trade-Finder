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
 * Access control (user rule 2026-07-12): ADMIN_GOOGLE_EMAILS → admin; EVERY
 * other verified Google account that completes sign-in → read-only viewer
 * (pages + read APIs only; all actions 403). Role mapping lives in proxy.ts.
 * While the Google OAuth app is in "Testing" publishing status, Google itself
 * only admits the test users added in Google Cloud Console — that list is the
 * real guest list for viewers.
 *
 * Google Cloud Console → the OAuth client must list the callback URL
 *   <origin>/api/auth/callback/google
 * for every host this runs on (http://localhost:5001 and production).
 */
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

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
    // Any VERIFIED Google account may sign in; the role split (admin vs
    // read-only viewer) happens in proxy.ts via ADMIN_GOOGLE_EMAILS.
    signIn({ profile }) {
      return profile?.email_verified === true && !!profile?.email;
    },
  },
});
