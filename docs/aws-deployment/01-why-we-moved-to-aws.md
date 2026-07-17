# 01 — Why we moved to AWS

[← Start](README.md) · Next: [The server box →](02-the-server-box.md)

---

## The one-line reason

SEBI requires that software placing automated trades runs from **one fixed IP that's
pre-registered with the broker**. Railway couldn't guarantee a stable egress IP, so we
moved to EC2 where we own a permanent one.

## The mechanics

Fyers whitelists a single source IP for **algo** order placement. When our app sends an
order, Fyers checks the source IP against that whitelist:

- Right IP → order accepted.
- Different IP → rejected with `-50` ("algo not allowed").

On Railway, the egress IP could change at any time (normal for that platform). Each
change silently dropped us off the whitelist and killed order placement, with no way to
pin it. On EC2 we attach an **Elastic IP** — an account-owned address that stays fixed
across restarts and even stops. We registered it with Fyers once; it's stable now.

> Our Elastic IP is `3.108.33.64`. It's whitelisted at the broker — **never release it**,
> or live trading breaks until a new one is re-registered (locked until ~2026-07-24).

## The other half: a type-200 broker app

Beyond the IP, Fyers requires an **App of type 200** (the "algo" type) for automated
order placement — a type-100 app returns `-50`. We created a new type-200 Fyers app
specifically for the box. (More in [09](09-brokers-and-safety.md).)

## Status of the move

Railway is **fully decommissioned** (`railway down`; 404). The EC2 box is the sole
production server. Nothing should point at Railway anymore.

---

**Takeaway:** fixed-IP algo rule + a stable Elastic IP is the entire reason for AWS.
Everything else in these docs is just how we run cleanly on that box.

Next: [the EC2 box →](02-the-server-box.md)
