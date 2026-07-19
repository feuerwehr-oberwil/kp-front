# Security Policy

KP Front is an Einsatzführungs-app for fire-service command. It holds operational incident
data and a personnel roster, so we take security seriously and welcome responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via one of:

- A **GitHub private security advisory** (Security → Report a vulnerability).
- **Email:** bastian@eichenbergers.ch — the maintainer's stable address, also for reporters
  without a GitHub account.

Please include a description, reproduction steps, affected version/commit, and any impact
assessment. We aim to acknowledge reports promptly and will keep you informed as we
investigate and fix.

## Supported versions

KP Front is under active development; security fixes land on `main`. Self-hosters should track
the latest tagged release (or `main`) and update promptly — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

| Version | Supported |
| --- | --- |
| latest release / `main` | ✅ |
| older tags | ❌ (please update) |

## Security model

- **Auth:** PIN-roster login — pick your name, enter your PIN. PINs are **peppered (with
  `SECRET_KEY`) and hashed with bcrypt**; they are never stored or logged in plaintext.
- **Sessions:** short-lived JWT access tokens + refresh tokens delivered as **httpOnly
  cookies** (Secure in production), with refresh rotation and revocation.
- **Roles:** incident users are `editor` (FU / can mutate incident state) and
  `viewer` (read-only). The stored backend value was migrated from the legacy `commander` name to
  `editor` on 2026-06-30.
- **Deployment admin is separated from the incident role:** the `/admin` UI and admin-write API
  (config, branding, system, user CRUD, geodata/objects) require an admin session unlocked by the
  `ADMIN_SECRET` env var — not the editor PIN. It is **fail-closed**: with `ADMIN_SECRET` unset the
  admin surface returns 403 and never falls back to the editor PIN.
- **Single-origin, no CORS:** one deployment = one station (single-tenant). The FastAPI
  service serves the SPA same-origin, so there is no cross-origin surface; it is also the only
  component that reaches external services (Divera, Traccar, geocoder, weather).
- **Secrets in env only:** `SECRET_KEY`, `ADMIN_SECRET`, `DATABASE_URL`, and integration
  credentials live in environment variables and **never** in the repo. Self-hosters **must set a
  strong, stable `SECRET_KEY`** (≥32 chars, e.g. `openssl rand -hex 32`) — it signs JWTs and
  peppers PINs, so rotating it invalidates all sessions and PIN hashes. `just init-env` generates
  both secrets for a fresh `.env`.

## Data protection

KP Front holds operational incident data and a personnel roster. **Self-hosters are the data
controllers** for their deployment:

- Each station runs its own isolated instance and database — all of your station's data stays
  in your DB (a strong story for cantonal data-protection / DSG compliance).
- Keep `SECRET_KEY` and the database/asset volume secure and backed up (see
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §6).
- **Per-station data is not in this repo** — configs (`backend/private/`) and reference geodata
  live outside it and must never be committed.
- If you process personal or operational data, follow your canton's data-protection (DSG)
  guidance.
