# The ingest host — retired

This directory used to hold the full configuration of `ingest.kp-front.ch`: a GlitchTip
instance run by the maintainer, which received the sanitised error reports that KP Front and
KP Rück installations sent when an admin opted in. Caddy at the edge stripping forwarding
headers, GlitchTip behind it, a Celery worker, Postgres and Redis — plus a docker-compose
variant of the same design for anyone who wanted to run it off Railway.

**It was shut down in September 2026.** It cost more to keep running than the handful of
reports it received were worth, and every installation that had opted in belonged to the
maintainer anyway.

The configuration is not preserved here because a checked-in config for a host that no longer
exists is worse than no config: it reads as current, and someone would eventually deploy it.
It remains in this repository's history if you want it — `git log -- deploy/ingest/`.

## What replaced it

Nothing, on the network. `KP_TELEMETRY_DSN` now defaults to the empty string, so a fresh
install has no destination even with every switch turned on. Crashes are written to the
station's own log and held in a small in-memory buffer on its own server
([`backend/app/telemetry/recent.py`](../../backend/app/telemetry/recent.py)).

A bug report reaches the maintainer when a person decides it should: the Rückmeldung sheet
saves that buffer as a **Diagnose-Datei**, and the operator attaches it to an e-mail or a
GitHub issue. See [`PRIVACY.md`](../../PRIVACY.md) § *Getting a bug report to the maintainer*.

## If you want an ingest of your own

The forwarder still works — it just has nowhere to point by default. Set `KP_TELEMETRY_DSN`
to a GlitchTip or Sentry you run and every part of the old arrangement applies again, with
your server as the destination. Nothing in this repository needs to change for that;
[`backend/app/telemetry/dsn.py`](../../backend/app/telemetry/dsn.py) explains the contract.
