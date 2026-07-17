'use client';

import { Activity, ArrowRight, Eye, EyeOff, Loader2, Lock, ShieldCheck, User } from 'lucide-react';
import { signIn } from 'next-auth/react';
import { useCallback, useEffect, useState } from 'react';

/**
 * The auth screen. Replaces the browser's native Basic-Auth prompt: posts the
 * password to /api/auth/login, which sets the signed session cookie the proxy
 * reads, then navigates to `?next=` (full load so the cookie takes effect).
 * Rendered bare (no app sidebar/header) via LayoutShell's /login bypass.
 */
export default function LoginPage() {
  const [username, setUsername] = useState('Analyst');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Google is THE sign-in. The password form is a break-glass fallback shown
  // only via /login?password=1 — so a Google outage/misconfig can never lock
  // the operator out of the console.
  const [withPassword, setWithPassword] = useState(false);

  // Surface a failed/refused Google sign-in — Auth.js redirects back here with
  // ?error= (e.g. AccessDenied) — and read the break-glass flag. Deferred a
  // tick per the repo's set-state-in-effect pattern.
  useEffect(() => {
    const kick = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const err = params.get('error');
      if (err) setError(err === 'AccessDenied' ? 'This Google account is not allowed in.' : `Google sign-in failed (${err}).`);
      if (params.get('password') === '1') setWithPassword(true);
    }, 0);
    return () => clearTimeout(kick);
  }, []);

  const googleSignIn = useCallback(() => {
    const next = new URLSearchParams(window.location.search).get('next');
    const target = next?.startsWith('/') ? next : '/';
    void signIn('google', { redirectTo: target });
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting || !password) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password, username }),
        });
        const j = (await res.json()) as { success: boolean; error?: string };
        if (j.success) {
          // Read ?next= at submit time (no effect needed); default home.
          const next = new URLSearchParams(window.location.search).get('next');
          // Full navigation so the new cookie is attached to the next request.
          window.location.assign(next?.startsWith('/') ? next : '/');
          return;
        }
        setError(j.error ?? 'Sign in failed.');
        setSubmitting(false);
      } catch {
        setError('Network error — try again.');
        setSubmitting(false);
      }
    },
    [password, username, submitting],
  );

  return (
    <div className="login-root relative flex min-h-dvh w-full overflow-hidden bg-white text-slate-900">
      <style>{CSS}</style>

      {/* Soft pastel colour wash — light, alive, never dark. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="login-blob login-blob-1" />
        <div className="login-blob login-blob-2" />
        <div className="login-blob login-blob-3" />
        <div className="login-dots absolute inset-0" />
      </div>

      {/* ── Brand hero (large screens) ───────────────────────────────── */}
      <section className="relative hidden flex-1 flex-col justify-between p-12 lg:flex xl:p-16">
        <div className="flex items-center gap-3">
          <LogoMark />
          <div>
            <p className="text-sm font-semibold tracking-tight text-slate-900">AI OI Trade Finder</p>
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">DeepQuant</p>
          </div>
        </div>

        <div className="max-w-md">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-[11px] font-medium text-slate-600 shadow-sm backdrop-blur">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            Realtime · in sync
          </div>
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-slate-900 xl:text-5xl">
            Insight over noise.
            <br />
            <span className="bg-gradient-to-r from-indigo-600 via-violet-500 to-emerald-500 bg-clip-text text-transparent">
              Everything in one console.
            </span>
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-500">
            Realtime analytics, live dashboards, and historical research — in a single private workspace.
          </p>
        </div>

        <div className="flex items-center gap-6 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-3.5" /> Private access
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Activity className="size-3.5" /> Realtime data
          </span>
        </div>
      </section>

      {/* ── Sign-in panel ────────────────────────────────────────────── */}
      <section className="relative flex w-full flex-col items-center justify-center px-6 py-12 lg:w-[46%] lg:max-w-xl">
        <div className="login-card w-full max-w-sm">
          {/* Compact brand for mobile */}
          <div className="mb-8 flex flex-col items-center text-center lg:hidden">
            <LogoMark />
            <p className="mt-4 text-base font-semibold tracking-tight text-slate-900">AI OI Trade Finder</p>
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-slate-400">DeepQuant</p>
          </div>

          <div className="login-glow rounded-2xl border border-slate-200/80 bg-white/80 p-8 shadow-xl shadow-slate-200/60 backdrop-blur-xl">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">Welcome back</h2>
            <p className="mt-1 text-sm text-slate-500">
              {withPassword ? 'Operator fallback — enter the console password.' : 'Sign in with your Google account to open the console.'}
            </p>

            {error && (
              <div className="login-error mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={googleSignIn}
              className="mt-6 flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:bg-slate-50"
            >
              <GoogleMark />
              Continue with Google
            </button>

            {withPassword && (
              <>
                <div className="mt-5 flex items-center gap-3">
                  <span className="h-px flex-1 bg-slate-200" />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">or</span>
                  <span className="h-px flex-1 bg-slate-200" />
                </div>
                <form onSubmit={submit} className="mt-5 space-y-4">
              <div>
                <label htmlFor="username" className="mb-1.5 block text-xs font-medium text-slate-600">
                  Username
                </label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="username"
                    type="text"
                    value={username}
                    autoComplete="username"
                    placeholder="Analyst"
                    onChange={(e) => setUsername(e.target.value)}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-11 pr-4 text-sm text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-slate-600">
                  Password
                </label>
                <div className="group relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="password"
                    type={show ? 'text' : 'password'}
                    value={password}
                    autoFocus
                    autoComplete="current-password"
                    placeholder="••••••••••••"
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-11 pr-11 text-sm text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                  />
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    aria-label={show ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 transition-colors hover:text-slate-600"
                  >
                    {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting || !password}
                className="group relative flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-lg bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600 bg-[length:200%_100%] text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:bg-[position:100%_0] hover:shadow-indigo-500/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Signing in…
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </>
                )}
                </button>
                </form>
              </>
            )}
          </div>

          <p className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
            <ShieldCheck className="size-3.5" />
            Secured session · guest Google accounts get read-only access
          </p>
        </div>
      </section>
    </div>
  );
}

/** Google "G" — inline SVG (self-contained, official brand colours). */
function GoogleMark() {
  return (
    <svg className="size-4" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** Brand tile with an "R" monogram — a lively indigo→violet accent. */
function LogoMark() {
  return (
    <div className="grid size-12 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-lg font-bold text-white shadow-lg shadow-indigo-500/30">
      R
    </div>
  );
}

const CSS = `
.login-blob { position: absolute; border-radius: 9999px; filter: blur(72px); opacity: 0.55; will-change: transform; }
.login-blob-1 { width: 34rem; height: 34rem; left: -10rem; top: -12rem; background: radial-gradient(circle, rgba(129,140,248,0.55), rgba(129,140,248,0) 66%); animation: login-drift-1 20s ease-in-out infinite; }
.login-blob-2 { width: 30rem; height: 30rem; right: -8rem; top: 30%; background: radial-gradient(circle, rgba(52,211,153,0.42), rgba(52,211,153,0) 66%); animation: login-drift-2 24s ease-in-out infinite; }
.login-blob-3 { width: 26rem; height: 26rem; left: 22%; bottom: -12rem; background: radial-gradient(circle, rgba(167,139,250,0.4), rgba(167,139,250,0) 66%); animation: login-drift-3 28s ease-in-out infinite; }
.login-dots { background-image: radial-gradient(rgba(15,23,42,0.045) 1px, transparent 1px); background-size: 24px 24px; mask-image: radial-gradient(ellipse 80% 70% at 50% 45%, black, transparent 82%); }
.login-card { animation: login-rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) both; }
.login-glow { position: relative; }
.login-glow::before {
  content: ""; position: absolute; inset: -1px; border-radius: 1rem; padding: 1px; z-index: -1;
  background: linear-gradient(130deg, rgba(99,102,241,0.5), rgba(139,92,246,0.35) 40%, rgba(16,185,129,0.4));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  opacity: 0.7; animation: login-glow-pulse 5s ease-in-out infinite;
}
.login-error { animation: login-shake 0.35s ease-in-out; }
@keyframes login-glow-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }
@keyframes login-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes login-shake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-5px)} 40%{transform:translateX(5px)} 60%{transform:translateX(-3px)} 80%{transform:translateX(3px)} }
@keyframes login-drift-1 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(2.5rem,1.5rem) scale(1.08)} }
@keyframes login-drift-2 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(-2rem,2rem) scale(1.1)} }
@keyframes login-drift-3 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(1.5rem,-1.5rem) scale(1.06)} }
@media (prefers-reduced-motion: reduce) { .login-blob, .login-card, .login-glow::before { animation: none; } }
`;
