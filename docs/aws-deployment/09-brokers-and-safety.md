# 09 — Brokers and safety

[← Everyday commands](08-everyday-commands.md) · [Back to Start](README.md)

---

The broker specifics that the AWS setup exists to satisfy, and the safety layers around
real money.

## The Fyers app on the box

- Live algo order placement requires a Fyers **App of type 200** (the "algo" type). A
  type-100 app is rejected with `-50` ("algo not allowed"). A `-99` means the order hit
  a circuit limit.
- We created a **new type-200 app** just for the box, separate from the laptop's old
  type-100 app — so their tokens never collide and dev can't touch the live session.
- The box's outbound traffic exits via the **Elastic IP** (`3.108.33.64`), which is
  whitelisted at Fyers. This is the whole reason for the fixed-IP setup
  ([01](01-why-we-moved-to-aws.md)).

## The safety layers around real orders

Defence in depth — no single failure or prompt can place or lose money uncontrolled.

1. **Two-key live** — needs `AUTO_TRADE_LIVE_ENABLED=true` (env) **and** mode `live`
   (app). Either off → no live orders. See [05](05-settings-and-secrets.md).
2. **Kill switch** — an instant "no new orders" toggle. Exits still run (reducing risk
   is always allowed).
3. **Hard gates in code** — trade windows, max trades/day, max open lots, capital cap,
   daily-loss halt. These live in code (`lib/auto-trade/risk/`), not in prompts, so the
   AI cannot talk its way past a limit. "The AI proposes, code disposes."
4. **Deterministic position guard** — runs every ~60s (and at each pass start) to
   enforce stop / target / forced square-off. Works with the LLM down and under the kill
   switch. It only ever *reduces* risk.
5. **Deploy guard** — the auto-deploy cron won't restart the box while a trade is open
   ([04](04-building-and-shipping-the-app.md)).

## The honest caveat

The real broker order APIs have had **limited live exercise** (a ₹0 smoke test plus the
first live entries). Watch the first orders of any session manually. If an exit order
keeps failing, the guard escalates after 3 consecutive failures with a Telegram
**"MANUAL INTERVENTION NEEDED"** alert — treat that as "close it by hand in the Fyers
app now."

## What AWS covers, at a glance

- ✅ Compute: EC2 `t3.small`, `ap-south-1`, Elastic IP `3.108.33.64` (Fyers-whitelisted)
- ✅ HTTPS: DuckDNS + Caddy + Let's Encrypt (auto-renew)
- ✅ Build + registry: GitHub Actions → ghcr.io (box only pulls)
- ✅ CI/CD: `prod`-only build; box cron auto-deploy (position-guarded)
- ✅ Runtime config: `--env-file` + persistent EBS volume (secrets/DB never in image)
- ✅ Headless jobs: poller, capture, guard, token warm-up, EOD bhavcopy + scorecard
- ✅ Logs: file tee → `/logs`
- ✅ Data pull: `db:pull-prod` over HTTPS
- ✅ Power control: `box:*` scripts; automatic 08:15 start (EventBridge) + guarded 16:30/weekend stop, behind the `AUTO_SHUTDOWN` toggle (OFF by default)
- ✅ Live-order safety: two-key rule, type-200 app, deterministic guard, kill switch
- ❌ Railway: fully decommissioned — nothing points at it

---

**Takeaway:** the fixed IP + type-200 app make live orders *possible*; the two-key
rule, kill switch, code gates, and deterministic guard make them *safe*. The order path
is still lightly tested — watch the first orders and trust the escalation alert.

[Back to Start →](README.md)
