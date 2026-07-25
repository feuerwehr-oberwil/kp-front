# The ingest host

This directory describes the receiving end: the GlitchTip instance that accepts sanitised
error reports from the KP Front and KP Rück installations that have opted in. It is **not**
part of a station's deployment — a self-hoster never needs anything in here. It is checked in
because the promise made in [`PRIVACY.md`](../../PRIVACY.md) is only as good as the
configuration behind it, and that configuration should be readable by the people being asked
to trust it.

**Live at `ingest.kp-front.ch`.** One GlitchTip, one project per app: kp-front is project `1`,
kp-rueck is `2`. Separate projects rather than separate hosts, so one app's quota or spike
protection can never silence the other.

## What actually runs

Railway, in a project of its own (`kp-ingest`), four services:

| Service | What it is | Public? |
| --- | --- | --- |
| `caddy` | The edge — rate limits, header stripping. Built from `railway/Caddy.Dockerfile` | **yes**, `ingest.kp-front.ch` |
| `web` | GlitchTip itself, `railway/Web.Dockerfile` | no — only via `caddy` |
| `worker` | Celery + beat, `railway/Worker.Dockerfile`. Without it events arrive and never become issues | no |
| `Postgres` / `Redis` | Railway plugins | no |

`railway/` is the configuration as deployed. The `docker-compose.yml` + `Caddyfile` +
`Caddy.Dockerfile` at the top level are the **VPS variant** — the same design for anyone
(including a future us) who wants to run this without Railway. The two differ only where the
platform forces it: Railway terminates TLS at its own edge, so its Caddyfile listens on plain
HTTP on `$PORT` with `auto_https off`, and reaches GlitchTip over Railway's internal network
instead of a compose network.

### Two things that are easy to get wrong

**Migrations.** The upstream compose runs them as a one-shot service; Railway has no
equivalent, and forgetting is quiet and nasty — the container comes up, uWSGI serves, and
every request dies on a missing table. `Web.Dockerfile` therefore runs `migrate` in front of
the normal start script, so a version bump applies itself.

**The rate-limit module.** Stock Caddy has no `rate_limit` directive and refuses to start on
a directive it doesn't know. That is the behaviour we want — an ingest that came up without
its limits would be worse than one that didn't come up — but it means Caddy must be *built*
(`xcaddy build --with github.com/mholt/caddy-ratelimit`), never pulled.

## Threat model

The client credential is public (see `backend/app/telemetry/dsn.py`). Anyone who reads this
repository can post events into a project. That is the entire attack surface, and it is a
nuisance rather than a breach:

- **They cannot read anything.** A Sentry public key authenticates ingestion only.
- **They can waste storage and quota.** Handled by the rate limits below.
- **They can post lies.** True, and unimportant: this data informs bug triage, not decisions.

What must *not* happen is the ingest becoming a foothold into anything else:

1. **Its own Railway project**, with its own database and Redis, sharing nothing with the
   kp-front / kp-rueck / demo projects. Be honest about the limit of that: it is the same
   provider and the same account, so this is project-level isolation, not host-level. A
   compromise of the Railway account reaches all of it. That is the trade-off of picking
   Railway, and [`PRIVACY.md`](../../PRIVACY.md) says so rather than implying more.
2. **GlitchTip is not publicly routable.** Only `caddy` has a domain; `web` is reachable
   solely over the private network.
3. **Treat every payload as hostile input.** The sender is a station we do not control and,
   for all we know, someone else entirely.

## Rate limiting

Two buckets, in `railway/Caddyfile`:

- **Per IP** — 60 events/minute. A station's backend batches on a 5-minute timer and sends a
  handful at a time; 60 is generous for the honest case and useless for flooding.
- **Per install** — 200 events/hour, keyed on the auth header. Stops one wedged or malicious
  installation from consuming the whole project quota, which a per-IP limit alone would allow
  from a botnet.

The client cooperates: on `429` it stops the batch rather than draining it, and retries on the
next tick (`backend/app/telemetry/forwarder.py`). A well-behaved client backing off is what
makes a modest limit sufficient.

## The dashboard

On a VPS the sensible thing is to keep the GlitchTip UI on a separate hostname behind a VPN.
Railway has no VPN, and an error tracker whose UI is unreachable is an error tracker nobody
reads — so the dashboard is served on the same host, gated by login, with **open registration
turned off** (`ENABLE_OPEN_USER_REGISTRATION=false`). The first account was created with
`manage.py createsuperuser` inside the container, so registration was never open to the
internet even briefly.

That is a weaker position than the VPS design and it is stated plainly here rather than
papered over. Only the envelope endpoint is rate-limited; the dashboard is protected by
authentication alone.

## Settings that are not in a file

Set in the Railway service variables, listed here so they are not invisible:

- `ENABLE_OPEN_USER_REGISTRATION=false` — the one that must never drift.
- `GLITCHTIP_MAX_EVENT_LIFE_DAYS=90` — matches the retention PRIVACY.md promises.
- `GLITCHTIP_DOMAIN` / `CSRF_TRUSTED_ORIGINS` — the public URL.
- `SECRET_KEY`, `DATABASE_URL`, `REDIS_URL` — generated / wired to the plugins.

Still worth doing in the GlitchTip UI: a per-project event quota and spike protection, so a
sustained flood costs storage and nothing more.
