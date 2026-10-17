# CI and local validation

CI keeps the production-container, browser, visual, performance, coverage and security gates.
Independent work runs alongside other checks; browser suites share an image, never a database
or fake fleet. Workflow definitions live in `.github/workflows/ci.yml`.

## Fast local feedback

Use `just dev` for the running application, `just test-changed` while editing, and `just ci`
before pushing a complete change. `test-changed` only reruns the backend's previously failed
tests; a green result does not mean the backend suite passed.

`just ci` requires just 1.56 or later. Its three dependencies run in parallel:

- `just ci-frontend`: lint, browser-spec types and inventory, production build (including app
  types), hidden sourcemaps, bundle/site checks, vulnerability and license audits.
- `just ci-unit`: the whole frontend suite with its unchanged global coverage floor. It uses
  four workers so it can coexist with TypeScript and pytest on a developer machine.
- `just ci-backend`: migration/model drift, PostgreSQL tests, Ruff, mypy and dependency audits.

Use `just --jobs 1 ci` on a memory-constrained machine or to diagnose a timing-sensitive test.
TypeScript's incremental cache lives under `node_modules/.cache/typescript/`, with distinct app
and browser-spec files. It is disposable and confined to the checkout; delete that directory
to force a cold typecheck. Changed source/configuration still invalidates the relevant checks.

For targeted backend checks, `just test-backend -n 0 -x tests/test_example.py` uses a database
named for that invocation, with a separate database per xdist worker. Parallel worktrees must
not create/drop a shared `kpfront_test_gwN`. The parent test database is removed on exit; the
test fixtures own worker cleanup. Development data is never the test target.

## What runs in GitHub

The required checks retain their names, so branch protection needs no migration:

| Required check | Execution |
| --- | --- |
| Frontend (tsc + build) | Requires both static/build checks and the complete coverage run; they start in parallel. |
| Backend (ruff + alembic + pytest) | Locked Python install, real PostgreSQL, migrations/schema check, four-worker pytest and audits. |
| Image (hadolint + build + smoke) | Requires the image build and all three isolated browser suites. |
| Visual (screenshots vs baseline) | Loads that run's image into its own stack; unchanged screenshot thresholds. |
| Performance (user journeys vs baseline) | Loads that run's image into its own stack; unchanged journeys, calibration, confirmation and budgets. |
| Secrets (gitleaks) | Scans the tracked tree. |
| Shared files match KP Rück | Compares the shared manifest against the paired/default sibling branch. |

The two aggregate checks run even after a dependency fails and accept only `success` from
every child. A failed, skipped or cancelled child cannot make the required check green.

The image producer exports a Docker archive, compresses it once with fast Zstandard, and stores
it as a one-day artifact (without recompressing it in the artifact action). Consumers
download only from their own workflow run and verify the image's revision label against
`GITHUB_SHA` before booting. PR code receives no registry-write token. The producer is the only
CI job exporting the `ci-amd64` layer cache. It also reads the old default scope during the
transition; release builds can read both scopes. The standalone «Visual baselines» workflow
still builds its own image through the same composite action.

The frontend Docker stage copies only its actual inputs: source, public assets, package/lock
files, TypeScript/Vite config, `index.html`, and the coverage floor read by Vite's config. Add a
copy when introducing another build-time input. Backend/docs/workflow changes should reuse the
SPA layer; frontend changes must invalidate it. Python dependencies are installed as the runtime
user so copying a new SPA does not recursively re-own the entire virtualenv.

## Browser suite selection

Set `E2E_SUITE=field`, `recovery`, or `workspace` only against a disposable stack configured for
that suite. With no value, local project selection is unchanged. Do not set it for journeys or
screenshots: those retain their separate projects and measurement environments. Run
`node scripts/check-e2e-suites.mjs` after changing project/spec selection. It discovers the real
Playwright inventory, including new files/projects, without launching a browser or app, and
rejects empty suites, duplicate cases or missing cases.

Every suite retains the client-error/render-storm guard, the field scenario's no-retry policy,
and the browser's own observation windows. Parallelize by isolated stacks, not additional
workers mutating one shared incident or fleet.

## Measure the delivery path

Measure PR push to mergeable, merge to server readiness, and client update activation separately.
Sum job execution times across all attempts when estimating paid compute; do not count a
workflow's queue, human waiting, or later manual rerun delay as runner execution. Public standard
GitHub runners are free, while a paid provider may normalize minutes by machine size.

Compare warm and cold image paths, artifact export/download/load, browser installation, tests
and cache export separately. A shared producer saves repeated builds but introduces transfer
and a dependency edge; retain it based on complete-workflow measurements. Job timeouts bound
hangs and leave room for cold builds, rather than dropping checks to enforce a target duration.

This workflow does not change Railway's deployment trigger, main branch protection, service
worker update activation, or the release publication policy. A verified production deployment
gate and promotion by tested image digest remain separate deployment changes.
