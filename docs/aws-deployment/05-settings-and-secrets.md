# 05 — Settings and secrets

[← Building and shipping](04-building-and-shipping-the-app.md) · Next: [Jobs that run by themselves →](06-jobs-that-run-by-themselves.md)

---

The image ships with no secrets and no DB. Both are supplied on the box at `docker run`
time, via two mechanisms: the **env-file** and the **data volume**.

## The env-file

A plain file of settings + secrets (broker keys, operator password, feature flags),
passed to the container with `--env-file`. It lives only on the box — never in the repo
or the image. We keep it mostly in sync with the laptop's `.env.local` for easy
tracking, except for the safety flags below.

## The data volume

An EBS volume mounted at `/app/data`, which **survives image swaps**. Holds:
- `project-r.db` — the SQLite database (market data, trades, settings).
- Broker token caches (`.fyers-token.json`, `.dhan-token.json`).
- `tradefinder_platform_trades.json` — read at startup by the bhavcopy route; a missing
  copy throws ENOENT, so it must be present on the volume.

Because the DB is on this volume and not in the image, **deploys never touch data** —
new app version, same database.

## Box-vs-laptop safety flags (intentional differences)

These differ on purpose so running the app locally can never place a live order or
collide with the box's broker session.

| Setting | Box | Laptop | Effect |
|---|---|---|---|
| `AUTONOMOUS_SERVER` | `true` | unset | Enables the headless jobs ([06](06-jobs-that-run-by-themselves.md)). Provider-agnostic; replaced the old `RAILWAY_ENVIRONMENT_NAME` gate. |
| `AUTO_TRADE_LIVE_ENABLED` | `true` | unset | Key #1 of the two-key live rule (below). |
| `FYERS_POLLER_DISABLED` | unset | `true` | Laptop never runs the market loop → never trades the live account. |
| `APP_PASSWORD` | set | set (same) | Operator/admin login; also HTTP Basic for server-to-self + tooling. |
| Auth.js vars | set | — | `AUTH_GOOGLE_ID/SECRET`, `AUTH_SECRET`, `AUTH_URL` (public origin, required in prod). |

The laptop also stays on the **old** Fyers app; the box uses the **new** live one — so
their tokens never collide.

## Two-key live rule

Real order placement requires two independent switches, so no single flag flip goes
live by accident:

1. **Env (box):** `AUTO_TRADE_LIVE_ENABLED=true`.
2. **Runtime (app):** trading mode = `live` on `/auto-trade`.

Both must hold. Turning off either stops live orders immediately. (The money-side gates
are covered in [09](09-brokers-and-safety.md).)

---

**Takeaway:** secrets via env-file, DB on a persistent volume (deploys never touch it),
and a few flags kept different between box and laptop so dev can't trade real money.
Live needs two keys at once.

Next: [what the box runs on its own →](06-jobs-that-run-by-themselves.md)
