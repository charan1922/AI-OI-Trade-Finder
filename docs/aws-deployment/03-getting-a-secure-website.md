# 03 — Getting a secure website

[← The server box](02-the-server-box.md) · Next: [Building and shipping the app →](04-building-and-shipping-the-app.md)

---

## Goal

Serve the app at **`https://charan-projectr.duckdns.org`** with a valid TLS cert —
no raw IP, no browser warnings. Two parts: a domain, and TLS termination.

## The domain: DuckDNS

We didn't buy a domain. **DuckDNS** (free dynamic-DNS) gives us the subdomain
`charan-projectr.duckdns.org` pointed at the Elastic IP `3.108.33.64`. That's the whole
DNS story — a free name mapped to our fixed IP.

## TLS: Caddy + Let's Encrypt

**Caddy** runs on the box as a reverse proxy in front of the app. On top of proxying,
Caddy **automatically obtains and renews a Let's Encrypt certificate** for the domain —
no cron, no certbot, no manual renewal. That's the main reason we chose Caddy over
nginx here: TLS is zero-maintenance.

## Request flow

```
client ──HTTPS :443──▶ Caddy (TLS terminate) ──HTTP──▶ app on 127.0.0.1:5001
```

- The public only ever hits Caddy on **443**.
- Caddy terminates TLS and reverse-proxies to the app on **5001**, which is bound
  locally and not exposed to the internet.
- Responses go back out through Caddy, encrypted.

We picked this over CloudFront/CDN because the app has a live backend and SSE streams —
a CDN in front adds complication for no benefit here.

## Open ports (security group)

| Port | Source | Purpose |
|---|---|---|
| 443 | `0.0.0.0/0` | HTTPS via Caddy — the only real public entrance |
| 80 | `0.0.0.0/0` | Let's Encrypt HTTP-01 challenge + redirect to 443 |
| 22 | operator IP only | SSH admin |
| 5001 | not exposed | app; reachable only through Caddy locally |

> The **Caddyfile** lives on the box (`/opt/projectr/`), not in this repo. It maps the
> DuckDNS host to `reverse_proxy 127.0.0.1:5001`.

---

**Takeaway:** DuckDNS = free name → fixed IP. Caddy = reverse proxy that also
auto-manages Let's Encrypt TLS. App stays on local-only 5001, public only via 443.

Next: [Docker image → ghcr → CI/CD → auto-deploy →](04-building-and-shipping-the-app.md)
