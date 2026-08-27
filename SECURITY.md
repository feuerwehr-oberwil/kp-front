# Security Policy

KP Front is an Einsatzführungs-app for fire-service command. It holds operational incident
data and a personnel roster, so we take security seriously and welcome responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via one of:

- A **GitHub private security advisory** (Security → Report a vulnerability).
- **Email:** bastian@eichenbergers.ch – the maintainer's stable address, also for reporters
  without a GitHub account.

Please include a description, reproduction steps, affected version/commit, and any impact
assessment. We aim to acknowledge reports promptly and will keep you informed as we
investigate and fix.

## Supported versions

KP Front is under active development; security fixes land on `main`. Self-hosters should track
the latest tagged release (or `main`) and update promptly – see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

| Version | Supported |
| --- | --- |
| latest release / `main` | ✅ |
| older tags | ❌ (please update) |

## Security model

- **Auth:** PIN-roster login – pick your name, enter your PIN. PINs are **peppered (with
  `SECRET_KEY`) and hashed with bcrypt**; they are never stored or logged in plaintext.
- **Sessions:** short-lived JWT access tokens + refresh tokens delivered as **httpOnly
  cookies** (Secure in production), with refresh rotation and revocation.
- **Roles:** incident users are `editor` (FU / can mutate incident state) and
  `viewer` (read-only). The stored backend value was migrated from the legacy `commander` name to
  `editor` on 2026-06-30.
- **Deployment admin is separated from the incident role:** the `/admin` UI and admin-write API
  (config, branding, system, user CRUD, geodata/objects) require an admin session unlocked by the
  `ADMIN_SECRET` env var – not the editor PIN. It is **fail-closed**: with `ADMIN_SECRET` unset the
  admin surface returns 403 and never falls back to the editor PIN.
- **Single-origin, no CORS:** one deployment = one station (single-tenant). The FastAPI
  service serves the SPA same-origin, so there is no cross-origin API surface. It proxies the
  configured integrations, geocoder, and weather; map/WMS tiles are fetched by the browser so
  they can be cached offline.
- **Secrets stay out of the repo:** host-root secrets (`SECRET_KEY`, `ADMIN_SECRET`,
  `DATABASE_URL`) live in environment variables. Integration credentials can live there too,
  or in the deployment's encrypted credential store managed through `/admin`; an environment
  value wins. Self-hosters **must set a strong, stable `SECRET_KEY`** (≥32 chars, e.g.
  `openssl rand -hex 32`) – it signs JWTs, peppers PINs, and seals that credential store, so
  rotating it invalidates sessions and PIN hashes and makes stored integration credentials
  unreadable. `just init-env` generates the required host secrets for a fresh `.env`.
- **One credential *is* in the repo, deliberately:** the telemetry DSN in
  `backend/app/telemetry/dsn.py`. It is a Sentry **public key** – write-only by construction,
  able to submit an event and nothing else. It cannot read stored events, reach another project,
  or authenticate to anything. It is in the clear so that an auditor grepping this repository
  finds it and can rule it out in thirty seconds, rather than finding it hidden behind an env var
  and wondering. If you would still rather it did not exist on your instance, set
  `KP_TELEMETRY_ENABLED=0` – see [`PRIVACY.md`](PRIVACY.md).

## Accepted single-station deployment constraints

- **Station-supplied tactical SVG is trusted administrator input.** A deployment admin can
  replace a `symbols:*` reference dataset, and the browser renders its SVG markup inline. The
  current self-hosted/custom model accepts that risk because the station administrator and its
  private data repository are inside the same trust boundary as the deployment itself. Do not
  give this upload path to untrusted users. Before KP Front is offered as managed hosting or a
  multi-customer service, require strict SVG sanitization at ingestion and rendering plus a
  tested application-wide Content Security Policy; tenant isolation alone is not a substitute.
- **Whole-incident deletion is destructive maintenance.** Deleting a **real Einsatz** needs a
  deployment admin and the Einsatz must first be archived. It deletes Verlauf, hash-chained audit
  events, attendance and media together, so the in-database chain cannot prove the deletion
  afterwards. This is accepted for station-operated cleanup for now. A hosted service needs an
  explicit retention policy and deletion evidence outside the deleted incident record.
  **Übungen are deliberately outside this rule** — any editor may delete one in any state. An
  exercise is not an operational record, and a Wehr that cannot clear its own practice runs
  stops marking them as practice runs, which costs more evidence than it preserves.

## Data protection

KP Front holds operational incident data and a personnel roster. **Self-hosters are the data
controllers** for their deployment:

- Each station runs its own isolated instance and database – all of your station's data stays
  in your DB (a strong story for cantonal data-protection / DSG compliance).
- Keep `SECRET_KEY` and the database/asset volume secure and backed up (see
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §6).
- **Per-station data is not in this repo** – configs (`backend/private/`) and reference geodata
  live outside it and must never be committed.
- **Nothing is sent to the maintainer unless you switch it on.** There is no cloud account,
  licence check or usage beacon. Map tiles, geocoding, weather, and optional integrations do
  contact their configured providers; [`PRIVACY.md`](PRIVACY.md) documents those separately.
  The two channels for reporting problems to the maintainer are off or manual by default and
  show the exact payload first; the same document explains how to verify and disable them.
- If you process personal or operational data, follow your canton's data-protection (DSG)
  guidance.
