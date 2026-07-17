# 02 — The server box

[← Why we moved](01-why-we-moved-to-aws.md) · Next: [Getting a secure website →](03-getting-a-secure-website.md)

---

## What it is

One EC2 instance ("the box") running 24×7 in AWS Mumbai. It hosts the app, the SQLite
database, and the broker token caches. We reach it over SSH for admin; everything else
is automated.

| Property | Value | Note |
|---|---|---|
| Type | `t3.small` | 2 vCPU, 2 GB RAM |
| Region | `ap-south-1` | Mumbai (low latency to NSE/broker) |
| Public IP | Elastic IP `3.108.33.64` | Permanent; whitelisted at Fyers |
| OS / user | Ubuntu / `ubuntu` | |
| Runtime | Docker; container name `projectr` | |
| Working dir | `/opt/projectr/` | scripts, env-file, data volume mount |

## Why 2 GB is enough

The box never builds the image — GitHub Actions does that (see
[04](04-building-and-shipping-the-app.md)). The box only pulls and runs the finished
image, which is light. Next.js + SQLite sit comfortably in 2 GB.

## Elastic IP

A regular instance gets an ephemeral public IP that changes on stop/start. We attached
an **Elastic IP** instead — fixed, account-owned, and retained even while the instance
is stopped. This is the address Fyers whitelists.

> ⚠️ **Never release/disassociate the Elastic IP.** It's the registered algo IP.
> Releasing it breaks live trading until a new one is re-whitelisted.

A **stopped** instance keeps its Elastic IP *and* its EBS volume, so we can power it
off to save money and bring it back with the address and data intact.

## Cost

~₹1,000–1,500/month running non-stop. Stopped, you only pay a small amount for the
retained EBS volume (no compute charge). That's the basis for the auto power-off in
[07](07-saving-money-auto-onoff.md).

## SSH access and its catch

Admin login is over SSH, and port 22 is locked to the operator's current public IP for
safety. If your ISP-assigned IP changes, SSH silently times out until you add the new
IP to the security group (AWS console → EC2 → Security Groups → inbound → port 22).

> This IP-allowlist fragility is exactly why `db:pull-prod` was moved off SSH onto the
> always-open HTTPS port — see [08](08-everyday-commands.md).

---

**Takeaway:** a small, always-on EC2 instance in Mumbai with a permanent Elastic IP.
Small because it only runs (never builds). The IP is sacred. Stopping it is cheap and
lossless.

Next: [DNS + HTTPS →](03-getting-a-secure-website.md)
