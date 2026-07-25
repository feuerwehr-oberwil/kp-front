# Running KP Front and KP Rück on one host

Some stations run both: **KP Front** at the incident (the tactical picture on a tablet) and
**KP Rück** in the command post (the board behind it). This page is for the person who has to
put both on the same Docker host without them fighting each other.

**The two systems are independent.** Separate databases, separate images, separate releases, no
shared library and no runtime coupling – neither one calls the other, and either runs perfectly
well without the other. Nothing here is about making them talk. It is about the three places
where two otherwise-unrelated stacks collide on one machine: **host ports**, **environment
variable names that mean different things**, and **alarm intake secrets**.

If you run only one of the two, you can ignore this entire page.

---

## 1. Ports: only one stack can own 443

Both stacks ship a Caddy that wants port 443, and the second one to start simply fails to bind.
The fix is to stop asking either of them to be the public entrance and put **one reverse proxy**
in front of both.

Recommended layout for two public domains on one host:

| What | Owns | Notes |
| --- | --- | --- |
| Your reverse proxy | `80`, `443` | Terminates TLS for both domains, forwards to the two plain-HTTP ports below. Caddy, nginx, Traefik – whatever you already run. |
| KP Front | `APP_PORT` (default `8000`) | Run it **without** `--profile tls`. Its Caddy is optional and only exists for the standalone case; the base stack publishes the app directly. |
| KP Rück | `HTTP_PORT` (default `8080`) | Leave `DOMAIN` empty so its Caddy serves plain HTTP on `:80` internally. Set `HTTPS_PORT` to a free port (see below). |

```bash
# KP Rück .env
DOMAIN=                  # empty: the outer proxy terminates TLS, Caddy stays plain HTTP
HTTP_PORT=8080           # what your reverse proxy forwards to
HTTPS_PORT=8443          # NOT 443 – see the warning below
COOKIE_SECURE=           # leave blank; the browser still speaks HTTPS to the outer proxy
```

```bash
# KP Front .env
APP_PORT=8000            # what your reverse proxy forwards to
DOMAIN=                  # unused without --profile tls
```

> **`HTTPS_PORT` must be changed even when unused.** KP Rück's Caddy publishes it
> unconditionally – it is the single origin the Caddyfile routes and is deliberately *not*
> behind a compose profile, because gating it would leave the stack with nothing published at
> all. So even behind an outer proxy that never touches it, leaving `HTTPS_PORT=443` keeps the
> binding and the collision. Point it somewhere free.

> **`HTTPS_PORT` is not a second automatic-HTTPS setup.** Caddy's certificate flow needs to be
> reachable from the public internet on `80` (HTTP-01) or `443` (TLS-ALPN). Moved to `8443`, it
> cannot get its own certificate. This knob is for *getting out of the way* of whatever owns
> 443, not for running two ACME clients side by side.

**Keeping it simpler:** if only one of the two is published and the other stays on the LAN, skip
the outer proxy. Let the public one keep `DOMAIN` and 80/443, and move the other onto plain
high ports. `COOKIE_SECURE=false` then applies to the LAN-only stack, whose browsers really are
on plain HTTP.

---

## 2. `PUBLIC_URL` means two different things

This one breaks things silently, and it bites exactly the person who is being careful – copying
a working `.env` from one stack to the other as a starting point.

| Variable | In KP Rück | In KP Front |
| --- | --- | --- |
| `PUBLIC_URL` | The deployment's own URL, passed to the backend as the **allowed CORS origin**. | The public origin used as the base for **absolute links in outbound incident webhooks**. Nothing to do with CORS. |

Same name, unrelated jobs. Cross-copy the value and KP Rück's CORS origin becomes KP Front's
address – the browser starts refusing API calls, with no message in the app and nothing obvious
in the logs.

**As of 0.2 KP Rück's variable is called `CORS_ORIGINS`**, which is what the backend reads
anyway. `PUBLIC_URL` is still accepted as a fallback so existing installations keep working, but
rename it when you touch the file:

```bash
# KP Rück .env
CORS_ORIGINS=https://rueck.example.org     # was PUBLIC_URL
```

```bash
# KP Front .env
PUBLIC_URL=https://front.example.org       # unchanged meaning, different purpose
```

Set each to **its own** stack's public URL. They are never the same value.

---

## 3. Alarm intake: two secrets, two contracts

Both systems accept `POST /api/alarms` from a dispatch system. They are **not** the same
endpoint and must be configured separately.

**Separate secrets.** `ALARM_WEBHOOK_SECRET` is per deployment. Generate one for each; do not
share a value between the two stacks:

```bash
openssl rand -hex 24     # once per stack
```

In KP Rück the secret can now be set in `.env` and **wins over the database value**, so a
deployment can be provisioned entirely from the file. Left blank, the old behaviour stands: one
is auto-generated on first boot and has to be read back out with
`SELECT value FROM settings WHERE key = 'alarm_webhook_secret';`. KP Front has always taken it
from the environment.

**The payloads differ.** The two contracts overlap but are not interchangeable – a body one
accepts, the other may reject:

| | KP Rück | KP Front |
| --- | --- | --- |
| `source_id` | optional | **required** |
| `source` | ≤ 20 chars | ≤ 16 chars |
| Extra fields | `number` | `type`, `priority` (`HIGH`/`LOW`), `started_at` |

Configure your dispatch system with **one webhook per system**, each against its own URL, secret
and payload. Do not point one webhook at both and expect parity. Each system's intake is
documented in its own `docs/ALARM-INTEGRATIONS.md` (in each repository).

---

## 4. What does *not* collide

Worth stating, so you don't go looking for problems that aren't there:

- **Databases.** Each stack runs its own Postgres in its own compose project, on no published
  port. Different default `POSTGRES_USER`/`POSTGRES_DB`, and they never see each other.
- **Compose projects.** Two directories means two project names, so container names, networks
  and volumes are already namespaced. Nothing to rename.
- **Secrets other than the alarm one.** `SECRET_KEY`, `AUTH_SECRET_KEY`, database passwords,
  Divera and Traccar credentials – per stack, no coordination needed. (Both may legitimately use
  the *same* Divera access key; that is a Divera account detail, not a collision.)
- **Login.** KP Front authenticates with a station PIN, KP Rück with accounts (and optionally
  Entra SSO). Different models on purpose; there is no shared session.
- **Printing.** There is **one** agent for both systems, so this is not duplicated work either.
  Give it a `backends` list with one entry per system and run a single service; it speaks each
  system's protocol and drives each kind of printer. See
  [kp-rueck `tools/print-agent/`](https://github.com/feuerwehr-oberwil/kp-rueck/tree/main/tools/print-agent).

  > ⚠️ If you are migrating from the two separate agents, **stop the old ones first**. Two
  > agents polling one queue both claim jobs, and each job then prints once, from whichever
  > asked first — prints that "sometimes don't arrive" while both logs look healthy.

---

## 5. The environment-variable mapping

The two projects grew separately and name some identical concepts differently. These are **not**
collisions — nothing breaks — but if you keep both `.env` files open you will reach for the
wrong name. Only `PUBLIC_URL` (§2) was actually dangerous, and that one is fixed; the rest is a
translation table.

| Concept | KP Front | KP Rück |
| --- | --- | --- |
| Signing secret | `SECRET_KEY` | `AUTH_SECRET_KEY` signs logins, `SECRET_KEY` is the app secret |
| Secure-cookie override | `COOKIE_SECURE` | `AUTH_COOKIE_SECURE` |
| Host HTTP port | `APP_PORT` (the app publishes it) | `HTTP_PORT` (Caddy publishes it) |
| Host HTTPS port | fixed `443`, only with `--profile tls` | `HTTPS_PORT` |
| Allowed CORS origin | *not configurable — same origin* | `CORS_ORIGINS` |
| Base for outbound webhook links | `PUBLIC_URL` | *not applicable* |
| Print-agent shared secret | `PRINT_AGENT_SECRET` | `PRINT_AGENT_TOKEN` |
| First login | `SEED_DATABASE` seeds a PIN user | `ADMIN_SEED_PASSWORD` + `VIEWER_PASSWORD` |
| Image tag pin | `KP_FRONT_TAG` | `KP_RUECK_TAG` |

**Identical in both, and safe to reuse the same value:** `POSTGRES_PASSWORD`, `POSTGRES_USER`,
`POSTGRES_DB` (per stack, but the same names), `DOMAIN`, `DIVERA_ACCESS_KEY`, `TRACCAR_URL`,
`TRACCAR_EMAIL`, `TRACCAR_PASSWORD`, `KP_TELEMETRY_ENABLED`, `KP_TELEMETRY_DSN`.

One Divera access key in both is fine and expected — they poll the same account. It does **not**
make the two systems share anything: each keeps its own roster copy, and there is no bridge
between them (they already agree on person identity because both derive it from the same Divera
`pull/all` keys).

`ALARM_WEBHOOK_SECRET` has the same name in both and must hold **different** values — see §3.

---

## 6. Checklist

Before you start the second stack:

- [ ] One reverse proxy owns `80`/`443`; neither stack does.
- [ ] KP Front runs **without** `--profile tls`; `APP_PORT` is free.
- [ ] KP Rück's `HTTP_PORT` **and** `HTTPS_PORT` are both free – `HTTPS_PORT` is not `443`.
- [ ] `CORS_ORIGINS` (KP Rück) and `PUBLIC_URL` (KP Front) each point at their **own** stack.
- [ ] `ALARM_WEBHOOK_SECRET` is a **different** value in each `.env`.
- [ ] The dispatch system has a separate webhook per stack, each with its own payload shape.
- [ ] `docker compose up -d` on the second stack, then confirm the **first** one is still
      answering. A port collision shows up as a container that won't start; a CORS mistake only
      shows up in the browser.

---

*This file is deliberately identical in both repositories ([kp-front](https://github.com/feuerwehr-oberwil/kp-front/blob/main/docs/RUNNING-BOTH.md), [kp-rueck](https://github.com/feuerwehr-oberwil/kp-rueck/blob/main/docs/RUNNING-BOTH.md)) — a station hits these problems before it knows which repository to look in. Change one, copy it to the other.*
