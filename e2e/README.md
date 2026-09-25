# e2e – Playwright against the built app

The browser tests drive the real, built app against a running stack. The unit suite pins
`src/lib` logic from the inside; these catch what only a browser shows: a surface that throws on
mount, a wedged session, a render loop on the Karte.

| Spec | What it guards | Runs |
| --- | --- | --- |
| `smoke.spec.ts` | every core surface renders and survives a reload; session renewal; offline journal | CI, chromium + WebKit |
| `field-scenario.spec.ts` | the Übung of 23.09.2026: a Leitung coupled to a parked vehicle that reports GPS, a tapped Trupp; then three devices on one login | CI, chromium |
| `admin-row-menu.spec.ts` | the admin row menu is on top and its actions fire | CI (needs `E2E_ADMIN_SECRET`) |
| `demo.spec.ts` | the public demo's entry fits a phone | only against a demo deployment |
| `workspace-flows.spec.ts` | undo, timeline, keyboard, Abschluss, replay across the workspace seams | opt-in, `E2E_WORKFLOWS=1` |

CI runs all of them in the *Image* job against the production container it has just built
(`.github/workflows/ci.yml`); `playwright.config.ts` starts no servers.

## The client-error guard

Every test fails when the app reports a client error or a render storm, even when everything
it asserts still holds (`guard.ts`, re-exported by `helpers.ts`). It watches two things in every
browser context of the test:

- each `POST /api/diag/client-error`, the report `lib/reportError` sends for a render throw, an
  uncaught error, a map error, a SurfaceBoundary recrash or a `lib/useRenderStorm` storm;
- console errors and uncaught errors that name the loop itself (React #185, «Maximum update
  depth exceeded», «render storm»).

A failing test attaches `client-errors.json` (the report bodies). CI then prints the
`kpfront.clienterror` lines from the container log before the full log.

So a spec **must import `test` from `./helpers`**, never from `@playwright/test` (eslint
enforces this). A test that provokes a report on purpose lists it, and only it:

```ts
test.use({ expectedClientErrors: [/^error: Failed to fetch$/] }) // matched against «kind: message»
```

The offline smoke is the one user today. Since 24.09.2026 `lib/reportError` drops a bare fetch
failure while `navigator.onLine` is false (`isOfflineNetworkNoise`), because being offline is not
a client error. But Chromium's offline emulation reports `navigator.onLine === true` in a document
reloaded while offline, so that drill's basemap tiles still report «error: Failed to fetch».
The loop's own console line is never excused, and nothing turns the guard off.

A test that needs more devices asks for `openDevice('device 2')`. That gives another browser
context with the same base URL and viewport, guarded the same way.

## The field scenario

The post-mortem of 23.09.2026 (root cause A): the live-GPS pass put every device into a render
loop, and tapping a Trupp then threw React #185 and took the Karte down. That only happened
with a Leitung coupled to a vehicle that was standing still and sending GPS, a shape no test
had ever produced. The spec builds exactly that:

1. It opens its own Übung with a coordinate, over the API (`POST /api/incidents`). Each device
   gets it the way a device remembers its last Einsatz (the prefs cookie), so other open
   incidents on the stack do not matter. The spec archives it again at the end.
2. It parks a TLF about 45 m from the Einsatzort through the backend's fake fleet
   (`POST /api/traccar/fake`). The Fahrzeuge layer polls `/api/traccar/positions`, the same
   route it polls in the field.
3. Device 1 draws a Linie that starts on the TLF with the line tool (`l`). A press on a live
   vehicle couples the start at once. The server must hold `startAttachment.gps.state ===
   'guarded'`.
4. Every device places a «Neuer Trupp» with the Trupp tool (`t`) at the same moment.
5. For 22 s the fleet re-reports the same fix every 5 s, as a parked Traccar device does. Each
   device must have seen at least two feed answers.
6. Every device taps its Trupp. The Trupp's action bar must open, and there must be no
   SurfaceBoundary card and no client error.
7. Every Trupp must be on the server and on every device (the edit lost in a re-merge, #204).
   The coupling must still be `guarded`.

It runs twice: on one device, and on three devices with one login, as in the Übung. It is
**chromium only**. The loop lives in our React code, not in anything an engine does
differently, and the three-device run is the expensive half of the suite. WebKit keeps running
the smoke under the same guard. Runtime is about 35 s plus 50 s, and 20 s for the test below.

Before every press the spec waits until the TLF's screen position holds still for 300 ms. The
Karte's first framing can land after the marker is already visible, and on a loaded box a press
measured before it went 18 px beside the TLF, so the Linie started uncoupled.

**A known bug, pinned as an expected failure.** The third test has three devices tap «Neuer
Trupp» within milliseconds of each other. Each takes the next number from its own view of the
Einsatz, so all three are «Trupp 1», against docs/trupp-naming.md §1 (that doc accepts the race
only for devices that are offline). The test marks itself `test.fail` only when the duplicate
actually shows and no client error is on record. When the numbering is fixed it passes; then
delete that line.

**Proof that it catches the bug** (24.09.2026): with the #200 fix reverted locally (the
idempotent pass, the stable `setDocRaw`, TwinTeamPill's guard), both tests fail. The failures
carry the field's own reports: React #185 with `surface=map`, and «render storm:
IncidentWorkspace · tab=map · changed: objects×200».

## Running locally

```bash
# a throwaway database on the dev compose db (just db), migrated, and the built SPA served by
# the backend. TRACCAR_FAKE + ALARM_WEBHOOK_SECRET only for the field scenario.
pnpm build
cd backend && DATABASE_URL=postgresql+asyncpg://kpfront:kpfront@localhost:5434/kpfront_e2e \
  SECRET_KEY=<32+ chars> ENVIRONMENT=production COOKIE_SECURE=false SEED_PIN=194731 \
  ADMIN_SECRET=<16+ chars> TRACCAR_FAKE=1 ALARM_WEBHOOK_SECRET=<any> \
  MEDIA_STORAGE_DIR=/tmp/kp-e2e-storage SPA_DIR=$PWD/../dist \
  sh -c 'uv run alembic upgrade head && uv run uvicorn app.main:app --port 8016'

E2E_BASE_URL=http://localhost:8016 E2E_PIN=194731 E2E_ADMIN_SECRET=<same> \
  E2E_FLEET_SECRET=<the ALARM_WEBHOOK_SECRET> pnpm test:e2e --project chromium
```

Without `E2E_FLEET_SECRET`, the field scenario skips locally. In CI it fails instead: CI must
never quietly drop it. It writes to its own Übung and to the server's fake fleet, so never run
it against a station in use or a production deployment.
