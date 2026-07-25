# The ingest host

This directory describes the receiving end: a GlitchTip instance that accepts sanitised error
reports from the KP Front and KP Rück installations that have opted in. It is **not** part of a
station's deployment — a self-hoster never needs anything in here. It is checked in because the
promise made in [`PRIVACY.md`](../../PRIVACY.md) is only as good as the configuration behind it,
and that configuration should be readable by the people being asked to trust it.

## Threat model

The client credential is public (see `backend/app/telemetry/dsn.py`). Anyone who reads this
repository can post events into the project. That is the entire attack surface, and it is a
nuisance, not a breach:

- **They cannot read anything.** A Sentry public key authenticates ingestion only.
- **They can waste storage and quota.** Handled by rate limiting and a project quota, below.
- **They can post lies.** True, and unimportant: this data informs bug triage, not decisions.

What must *not* happen is the ingest host being a foothold into anything else. So:

1. **A dedicated host.** No shared VPS with the demo, the landing pages, or anything holding
   station data. No shared database server, no shared Docker network, no shared credentials.
2. **Outbound only where needed.** Postgres and Redis are not published; only Caddy's 80/443
   are reachable.
3. **Treat every payload as hostile input.** The sender is a station we do not control and,
   for all we know, someone else entirely.

## Rate limiting

Two buckets, both in `Caddyfile`:

- **Per IP** — 60 events/minute. A station's backend batches on a 5-minute timer and sends a
  handful at a time; 60 is generous for the honest case and useless for flooding.
- **Per install** — 200 events/hour, keyed on the `install` tag. Stops one wedged or malicious
  installation from consuming the whole project quota, which a per-IP limit alone would allow
  from a botnet.

The client cooperates: on `429` it stops the batch rather than draining it, and retries on the
next tick with backoff (`backend/app/telemetry/forwarder.py`). A well-behaved client backing off
is what makes a modest limit sufficient.

Additionally set, in GlitchTip itself:

- **Per-project event quota** — hard ceiling per month, so a sustained flood costs storage and
  nothing more.
- **Spike protection** — on.
- **Store the client IP: off.** The payload never contains one; this stops the *server* from
  adding one. `Caddyfile` also drops `X-Forwarded-For` before proxying, so it cannot be
  reconstructed downstream.
- **Retention: 90 days**, matching what PRIVACY.md promises.

## Bringing it up

```sh
cp .env.example .env      # set the secrets
docker compose up -d
```

Then, once: create the organisation, create a project per app (`kp-front`, `kp-rueck`), copy
each DSN, and set the *public key* half into `UPSTREAM_DSN` in the corresponding repository's
`backend/app/telemetry/dsn.py`. Until that happens the shipped placeholder deliberately fails to
parse and every installation's forwarder is a no-op.

**Turn off open registration** (`GLITCHTIP_ENABLE_OPEN_USER_REGISTRATION=false`, already set in
the compose file) before pointing DNS at it. It defaults to on, and an ingest host with open
signup is an ingest host with someone else's account on it.
