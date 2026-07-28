# Changelog

All notable changes to KP Front are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What the version number means for a deployment** – KP Front is a self-hosted app, not a
library, so the number answers one question: *how much attention does this update need?*

| Bump | What it means for you |
| --- | --- |
| **MAJOR** | Operator action required – a breaking config change, a migration that can't be rolled back, a new mandatory env var, a Postgres major. Read the notes before updating. |
| **MINOR** | New features. Migrations run automatically on boot; `docker compose pull && docker compose up -d` is enough. |
| **PATCH** | Fixes only. Always safe to take. |

Releases are labels on a `main` commit that CI already proved green – prod and the demo deploy
continuously from `main`, so a tag exists for *other* stations, not for us. Put differently:
every published image has already been carrying live incidents at Feuerwehr Oberwil before it
was tagged.

**Why still 0.x?** Because exactly one fire station runs this in production, and a 1.0 claims
more than that. It becomes **1.0 when a second station is running it in the field** – not when
the feature list feels complete. Until then, read 0.x as *"not yet proven anywhere but
Oberwil"*, **not** as *"we may break things without warning"*: the table above holds today and
will keep holding.

`0.1.0` is the initial public release: the git history was squashed for the open-source launch,
so this file – not the log – is the record of what shipped up to that point.

## [Unreleased]

A recovery release. The app was already hard to crash; the gap was **getting back out** – a
handful of states could only be cleared by restarting the app, or in one case by resetting the
browser. Everything below has been running in production at Feuerwehr Oberwil.

### Added
- **Rückmeldung – the app asks after a mishap, and can now send it.** After a crash the launcher
  offers to file a report. It could previously only be copied or mailed; there is now a **Senden**
  button, and afterwards the sheet shows what the *server* actually stored – a preview written by
  the sender is a promise, one returned by the receiver is a check.

  Alongside it, and deliberately separate, is a second channel for **background crashes**, which
  a deployment has to switch on first. The distinction is the whole design: pressing Senden by
  hand *is* the consent, the same as sending an e-mail. Nobody is watching when a background
  crash fires, so that channel defaults to off – and off means a NULL column, which is what every
  existing installation updates into. It is enabled in the **admin area, never on the device**:
  the fire service is the controller, not whoever happens to be holding the tablet.

  What leaves the building is built field by field in `app/telemetry/scrub.py` – nothing is passed
  through or spread, so a field nobody wrote a line for cannot leak. Free text is scrubbed too,
  because the value is usually *in* the message: paths, e-mails, phone numbers, IPs, coordinates
  (WGS84 and LV95), UUIDs, tokens, street names with house numbers, and the full user agent
  reduced to «iPad Safari» so it can't fingerprint. Every payload is written to the station's own
  log before it is sent and kept verbatim in `telemetry_outbox` – two copies on your own
  infrastructure, and the admin sheet shows the same table. `KP_TELEMETRY_ENABLED=0` overrides
  every switch in the UI. See [`PRIVACY.md`](PRIVACY.md), which also answers the IP question
  honestly, including the part that can't be solved in code.
- **arm64 images.** The published image builds for `linux/arm64` as well as `linux/amd64`, so an
  ARM host (Hetzner CAX, Oracle Ampere, a Raspberry Pi) can run it. The Vite stage builds on the
  native build platform, so the multi-arch build doesn't emulate the slow part.
- **Zeitplan – the Schichtenplanung, as a second view of the Anwesenheit.** A long incident is not
  a staffing problem you can hold in your head at 04:00, and the question it asks – *who is still
  going to be here at six, and how many is that?* – had no surface. The Anwesenheit answers *who is
  here now*; this answers *who will be*, on the same list of people, one tap away on the same
  screen.

  It is a grid of who × when: one row per person, one lane of time each, worked directly the way
  the paper Führungsformular is filled in. A shift carries one of three states, and the distinction
  is the whole point of the surface: **verfügbar** (they said they could), **eingeteilt** (you are
  counting on them), and **anwesend** – which is not a plan at all but the recorded attendance,
  drawn in from the Anwesenheit and read-only here. **The Zeitplan never writes attendance.** You
  can plan a shift for somebody who never turns up, and the record will keep saying so; ticking
  people in and out stays exactly where it was.

  Underneath runs the **Deckung**: three step lines counting available, planned and actually
  present across the whole span, so a gap is something you see the shape of rather than something
  you work out. It folds open to the numbers, because the curve says *where* and only a digit says
  *how many*. Multi-day incidents get day boundaries and dates on the axis – past midnight, «07:29»
  alone never said which morning.

  It prints as the **Führungsformular «Zeitplan»** (A4 landscape, monochrome – it is rules and bars,
  and a colour cartridge is a consumable), rendered server-side like the rapport, and a viewer may
  print it: somebody arriving to take over the shift should be able to print the sheet they are
  walking into without an editor PIN.

### Fixed
- **A Modul-5 sub-sheet's label fits the plan rail again.** The rail read
  «RWA · Migros – modul5-rwa» and ran straight off its 216px edge. Modul 4 and the Modul-5
  sub-sheets have no fixed tile in the catalog, so their label comes from the data — the PDF's
  filename. A station that names its file `Wasser.pdf` hands over exactly the right word; ours
  carry the object name plus the raw module key, which is neither short nor a name. The filename
  is now taken only when it *looks* like a sub-sheet name, and otherwise the sub-slot key out of
  the id is used, which is the structural part and always clean: `modul5-rwa` → «RWA»,
  `modul5-wasser` → «Wasser». The monogram in the chip is unchanged, so the collapsed rail still
  reads as before. A long label additionally truncates with an ellipsis instead of being sliced
  off mid-word — what stands in that tile is station data, and "it fits today" is not a property
  we control.
- **No more states that only an app restart could clear.** A sweep across every state and
  transition that could strand the app turned up three classes, none of which offered a way out
  on screen:
  - **Boot could hang forever with nothing to tap.** No `fetch` had a timeout, and the field
    failure isn't a refused connection but a half-open one – a dying access point, one bar of
    LTE, a captive portal – where `fetch` hangs for minutes. The deployment config is awaited
    *before* the first render, so the result was a literally blank white page: no splash, no
    error boundary, nothing. Killing the app didn't help, because it hung again. Requests now
    time out (20 s; uploads 5 min), boot is bounded by a 4 s budget after which the offline cache
    is used and the app renders anyway, and the splash grows a status line and a **«Neu starten»**
    action after 9 s. Verified against a real blackhole server that accepts TCP and never answers:
    first paint after 4.8 s instead of never.
  - **A crash could loop.** The error boundary's only action was «Neu laden» – and boot reopens
    the last incident automatically, so if *that* incident's data threw during render, reloading
    landed straight back in the same crash. Crashes are now counted per incident and survive the
    reload: the first offers **«Einsatz schliessen»** (loses nothing), a second crash on the same
    incident adds **«Lokale Kopie verwerfen»** with a warning and demotes «Neu laden», which is
    demonstrably the action that does not help.
  - **A lost WebGL context left a blank map.** iPadOS releases the context under memory pressure
    or after a long spell in the background, and MapLibre does not rebuild itself – so the map
    became an empty rectangle surrounded by working chrome, which doesn't even read as a crash.
    The first loss now heals silently and keeps your current view; a second within 60 s offers
    **«Karte neu aufbauen»** rather than looping through remounts.
- **A full device no longer loses incident data.** The offline cache wasn't just unprotected
  against a full disk, it was **silent** about it – worse than a visible crash for an
  Einsatzrapport. Three defects, each reproduced against a fake IndexedDB before being fixed: a
  failed write was swallowed so the *old* value was served back as current (including a stale
  "nothing to sync" flag), the localStorage fallback threw on every save because a workspace blob
  never fits there, and the fallback turned out to be **write-only** – the copy was written and
  never found again. Now: map tiles are evicted before incident data (a tile reloads in seconds,
  the Lagekarte never), the sync indicator gains a **storage** state that is loud only while
  there is unsynced work, Offline-Bereitschaft shows the free space it actually has, and
  «Alles für offline laden» checks first and offers **«Reduziert laden»** if the download won't
  fit.
- **Replay no longer throws on a long incident.** A `RangeError` could end the scrub.

### Changed
- **Atemschutz has one pressure threshold, not two: the Alarmdruck (100 bar).** There were briefly
  two — amber from the Rückzugsgrenze, red from a Mindestdruck — and the lower one was never
  agreed doctrine anyway. The reason for dropping it isn't thrift: someone below their turn-back
  pressure is already on the way out, so a second colour further down says nothing new and only
  teaches that the first one was survivable. One threshold, and it is the loud one.

  `rueckzugBar` + `mindestBar` become a single **`alarmBar`**, surfaced in the admin area as
  «Alarmdruck (bar)»; **`0` switches it off**. The louder of the logged Druck and the projection
  counts, and when only the projection has crossed, the card says so. Still silent — the contact
  clock remains the one audible alarm.

  > **No action required.** An older config carrying `mindestBar` / `rueckzugBar` is ignored
  > rather than rejected, so there is nothing to migrate; set `alarmBar` if 100 isn't your number.
- **The station print agent moved, and now serves both KP systems.** `tools/print_agent.py` is
  retired; the agent lives in kp-rueck at
  [`tools/print-agent/`](https://github.com/feuerwehr-oberwil/kp-rueck/tree/main/tools/print-agent)
  and speaks both protocols, so a station running KP Front *and* KP Rück runs one service
  instead of two agents on the same box reaching the same printer room.

  **KP Front's endpoint contract is unchanged** — the agent was ported to it, not the other way
  round — including the behaviour that matters: a queued CUPS job counts as pending rather than
  failed, and `lp` options still append after the A4/duplex/monochrome defaults. Writing your own
  agent against the documented endpoints remains entirely reasonable.

  > **No action required.** An existing Pi keeps working, and the environment variables it
  > already uses are read unchanged. When you do migrate, **stop the old agent first** — two
  > agents polling one queue both claim jobs, so each job prints once, from whichever asked
  > first. See [`tools/PRINT-AGENT.md`](tools/PRINT-AGENT.md).
- **[`RUNNING-BOTH.md`](https://github.com/feuerwehr-oberwil/kp-rueck/blob/main/docs/RUNNING-BOTH.md)**
  for stations running both systems on one host: the places two independent stacks collide
  (ports, variable names that mean different things, alarm secrets), plus a mapping table for
  the variables the two projects name differently. It lives in the kp-rueck repository as a
  single copy and is linked from here — a second copy drifted within a day, and half-right
  instructions about a silent port collision are worse than none.
- **The generic alarm intake reserves the same `source` slugs as KP Rück.** Both now reject the
  union of the two lists, so a station feeding one dispatch system into both apps can't pick a
  name that one accepts and the other rejects.
- **Day-one documentation for a station that isn't us.** A new
  [`docs/SETUP.md`](docs/SETUP.md) walks the ordered path from an empty Docker host to a usable
  board, [`SUPPORT.md`](SUPPORT.md) says plainly what may be expected from a one-person project
  and what 1.0 will mean, and [`docs/ALARM-INTEGRATIONS.md`](docs/ALARM-INTEGRATIONS.md) now
  carries a stability promise for the intake contract plus the real differences to KP Rück.
- **Managed hosting is no longer implied.** The deployment docs promised something that isn't on
  offer; they now give the honest answer instead.
- `docs/openapi.json` had drifted **31 endpoints** behind the code. It is current, and a test
  now fails if it drifts again.
- Dead code removed across the frontend (236 → 214 lint warnings), and the DCO sign-off check is
  enforced again after being lost in a rebase.

## [0.2.0] – 2026-07-25

The first release with **published container images**: self-hosting no longer needs a Node/uv
toolchain on the VPS. Everything else here has been running in production since `0.1.0`.

### Added
- **Published images on GHCR.** `ghcr.io/feuerwehr-oberwil/kp-front:0.2.0` (plus `0.2` and
  `latest`) is built, booted and smoke-tested by CI on every tag. `docker-compose.yml` now pulls
  by default and `KP_FRONT_TAG` in `.env` pins the version, so updating is
  `docker compose pull && docker compose up -d`. Building from source stays supported – see
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §5.
- **Keyboard control of the whole surface:** number keys address the modules, letters switch
  surfaces, and tools, undo/redo and the panels all have shortcuts – so a station with a
  keyboard-equipped tablet dock can drive KP Front without touching the screen.
- **Phone/mobile editing round 2:** swipe to page between sections and through the individual
  plan documents (including an edge-swipe over the canvas), the tool-option dock became a
  horizontal bar that hugs its content, the Einsatzuhr got a distinct icon per mode, and Mittel
  gained an «Alle» tab.
- **Symbol pack grown:** VKF **Rauch** as a real symbol with detail modal and spread, **Boot**,
  **Drohne**, Lüfter airflow toggle (Einblasen/Absaugen), and Drehleiter/Hubretter as composite
  symbols with an independent slewing boom you drag by the cage tip (reach + bearing). Every
  driven vehicle now has a **Fahrer** picker, and the EL card leads with the name plus a deputy.
- **Atemschutz: expected-pressure Schätzung** derived from the Trupp's own consumption history
  (labelled as *Schätzung*, with its assumptions visible), a free-text Funkkanal, and an opt-in
  soft pip on «Kontakt fällig» (off by default).
- **Print relay status you can trust:** the «An Stationsdrucker» button now reports
  gesendet → wird gedruckt → gedruckt as a live toast, the agent claims jobs by long-poll
  (near-instant, ~10× less traffic from the station Pi), and the editor prewarms map tiles.
- **Persistent plan-scale calibration** per station: a Massstab measured once on a plan document
  is remembered instead of being recalibrated at every incident.
- **Per-team Spuren toggle:** each Trupp's trail is switched on its own eye icon, replacing the
  single global trail switch.
- **Replay trims its scrub range** to the span where changes actually happened, so an 8-hour
  incident with 20 minutes of drawing doesn't scrub through hours of nothing.
- **Optional scheduler heartbeat** (dead-man's-switch) for deployments that want external
  alerting when the background scheduler dies.
- **Demo-mode deployment support:** `DEMO_RESET_SECONDS` runs the incident/roster reset
  in-process (fail-closed, default off – production stays off), seeding a pre-filled example
  incident, with auto-login and a welcome modal explaining what a visitor can and can't do.
- **Help content** for Rapport & Abschluss, Erfassung per QR, and Massstab in Funktionen & Hilfe.

### Changed
- **All modal surfaces now sit on [Base UI](https://base-ui.com/)** (sheets, confirm dialogs,
  menus, popovers) behind the existing `src/lib/overlays/` wrappers, so focus trap/restore,
  scroll-lock, Esc, outside-click and ARIA behave identically everywhere instead of being
  hand-rolled per surface. The non-modal map tool-docks stay bespoke on purpose – a focus trap
  would break map interaction.
- **Lage ↔ Plan parity** pushed further: identical selection halo and pop, the same drag deadzone
  and orb touch-pad, teams that rest as a compact dot and expand to a pill on selection, and one
  shared placement dock (close · keep-placing lock · info hint) for both surfaces.
- **One control vocabulary** in the details modals and the Einsatzrapport: a single segmented
  control and a consistent row rhythm instead of per-modal variations.
- **Left rail and top bar decluttered:** duplicate glyphs removed, plan tabs grouped, and the
  Einsatzuhr menu labelled.
- **Touch/text sweep** toward the 3am tenet: rank chips and time inputs to 44px, shared 44px
  hit-pads on dock and journal buttons, symbol captions to 12.5px.
- **Sync got cheaper on tablets:** the 304 poll reads only `workspace_rev` instead of the whole
  workspace blob, and the incident list defers its heavy JSONB column.
- **Wind arrow follows map rotation** like the compass does.

### Fixed
- **Undo gaps closed** (the standing rule is that every mutation is undoable): logging an
  Atemschutz pressure, taking an alarm with one tap, and «Raus» + clearing Anwesenheit are all
  undoable now, and «Eröffnen» can no longer dead-end.
- Dismissing an alarm on the landing screen with «×» is **per-device** and no longer hides it
  for the whole crew.
- **Speech-to-text re-transcribe race:** a re-transcribe started after a delete could leave the
  job stuck in `running` until the orphan check force-failed it («Serverneustart …»). The job row
  is committed before the background task reads it, and a failing transcription now logs
  server-side instead of being swallowed.
- **Line/hose drawing polish:** fork-aligned Teilstück ports, a sticky (de-twitched) magnet,
  endpoints that move instead of detaching, fill-circle snapping, clearer red indicators, and a
  centred × on the detach chip.
- **Plan documents recover from a failed load** – PDF/Umrisse loading has a timeout, evicts a bad
  cache entry, and offers «Erneut laden» instead of a permanent blank board. The board canvas is
  also measured whenever it remounts, fixing a plan that rendered at the wrong size.
- A **viewer-only** plan no longer reserves an empty tool-bar lane, and the Ebenen dock closes
  when focus moves elsewhere.
- Mobile layout fixes: update-banner sizing, views-popover height, the team-time stack, the
  Mittel toggle, uniform settings rows, and a PIN pad whose bottom row stayed reachable on short
  viewports.
- Personnel dropdowns in the Einsatzrapport render above the modal instead of behind it.
- Batch from the field-feedback round: BMA red dot, plan centring, Trupp on plan, Mittel,
  readiness modal, demo create-block, rapport spinner, and the outline cache.
- Hubretter boom heading is independent of the vehicle's and stays drawn on top (it is
  turntable-mounted), and the Drohne glyph matches the size of the rest of the pack.

## [0.1.0] – 2026-07-19

### Added
- Deployment-admin auth separated from the incident role: the `/admin` UI and admin-write API
  (config, branding, system, user CRUD, geodata/objects) gate on an `ADMIN_SECRET` session, with
  the `admin_geodata`/`admin_objects` push CLIs authenticating the same way. Fail-closed.
- `just` task runner covering the full lifecycle (setup, dev DB, dev servers, lint/test both
  stacks, build, config-as-code helpers, demo data), plus `just init-env` to generate a `.env`
  with strong secrets.
- Committed config/manifest templates (`backend/config.example.json`,
  `backend/geodata.manifest.example.json`, `backend/objects.manifest.example.json`) and a
  synthetic Musterdorf demo dataset (`examples/demo-data/`, `just demo-load`).
- API reference: committed OpenAPI schema (`docs/openapi.json`, `just openapi`), `docs/API.md`,
  and an `EXPOSE_API_DOCS` flag to opt the interactive docs into production.
- `NOTICE`, `CODE_OF_CONDUCT.md`, and this `CHANGELOG.md`.
- `/ready` readiness endpoint (probes the database and the storage volume, 503 on failure);
  the compose healthcheck and Railway `healthcheckPath` now use it instead of the static
  `/health`.
- Backup tooling: `scripts/backup.sh` (Postgres dump + storage-volume tarball with retention,
  cron-ready) and an automatic pre-migration `pg_dump` in `start.sh` whenever a migration is
  pending (newest 5 kept on the storage volume).
- Confirm-with-undo on the two lossy Gebäude operations (remove floor, replace building) –
  the removed storey/stack and its sketches are restorable from the toast.
- Automatic sync retry with backoff: a failed workspace flush (server error or network drop)
  now re-flushes on 5s→60s backoff instead of waiting for the next manual edit.
- CI security scanning: a blocking gitleaks secret scan of the tracked tree, an advisory
  `pnpm audit` (mirroring the backend's `pip-audit`), and a CodeQL workflow that activates
  automatically once the repository is public.
- Single-editor tab lock (Web Locks): a second browser tab on the same incident is read-only
  with an "In einem anderen Tab geöffnet" banner and a one-tap "Hier bearbeiten" take-over –
  two tabs can no longer race the shared sync cache.
- The Verlauf is now a first-class append-only journal store (server rows + offline outbox)
  instead of an array inside the synced workspace blob – the one unbounded domain no longer
  re-syncs wholesale on every edit. Older incidents migrate lazily and losslessly (the blob
  echoes their rows until each is on the server, then ships empty); transcripts and uploaded
  media URLs are appended enrichment patches, never in-place edits.
- The sync channel is gzip-compressed in both directions (responses via middleware, large
  request bodies via CompressionStream) – repetitive workspace JSON shrinks ~8–10× on
  field LTE.
- The Einsatzende is now first class: archiving stamps `closed_at` (confirm dialog; reopen
  keeps it), both transitions self-document in the Verlauf, post-closure rows carry a
  Nachtrag badge and print in their own Rapport section, the Verlauf gains calendar-day
  separators, and reminders due before closure no longer alarm on reopen.
- Journal Textbausteine: while typing, standard phrases fuzzy-complete the current fragment
  (tap or Tab to accept); the phrase list is station-editable in the admin Journal section.
- Mittel capture + Retablierung: placing a matching tactical symbol (Lüfter, Pumpe, …) on
  Lage or Plan offers logging the material with one tap (never automatic); equipment lines
  carry a Retablierung status (zurück / vor Ort geblieben / defekt) and the Rapport gains a
  «Retablierung / Nachschub» worksheet – refill list, flagged equipment, and still-open
  lines. Catalogue items take optional `symbol` and `verbrauchbar` keys in the deployment
  config; without a `symbol` key a label↔symbol-name match still applies.
- Web Push (VAPID) for killed-app alarms: a server-side sweep recomputes Atemschutz
  überfällig + due Wiedervorlagen from the synced data (same doctrine fallbacks as the
  client) and notifies every subscribed browser – the "tablet stays foregrounded" rule
  becomes a fallback once a deployment sets its VAPID keys.
- New-alarm push: a NEW Divera alarm (webhook or poll) immediately pushes «Neuer Einsatz:
  Stichwort – Adresse» to every subscribed browser, best-effort (a broken push path never
  breaks the intake). VAPID pair generation without Node:
  `cd backend && uv run python -m app.gen_vapid`.
- Tactical symbols: FKS damage signatures (Beschädigung, Teil-/Totalzerstörung) and
  Überschwemmung added to the own-artwork pack (70 signs).

### Changed (assets)
- The tactical symbol pack is now KP-Front-authored artwork (`public/tactical-symbols.json`,
  generated by `tools/gen_symbols.py`, corps-reviewed against the official FKS Faltkarte
  11/2022) – all 66 signs redrawn as clean geometric primitives, same names/categories. The
  backend overlay dataset id moved from `symbols:firegis` to `symbols:tactical`; the legacy
  dataset in existing deployments is simply no longer fetched.

### Removed
- The real station plan PDFs (`public/plans/modul*.pdf`) and the FireGIS symbol-extraction
  tools – station plans are deployment data served from the database; the module tiles in the
  bundled catalog no longer reference any repo asset.
- `public/firegis-symbols.json` and the FireGIS curation scripts, replaced by the authored
  pack above (the last FireGIS-derived asset in the tree).

### Changed
- Smoother app updates: an update discovered right after launch (before any interaction) now
  applies silently instead of asking – the banner only appears for deploys landing mid-work.
  Applying an update shows a calm "Neue Version wird geladen" cover, a watchdog guarantees the
  reload, and the next launch confirms the new build with a toast. The menu's update check
  reports its verdict inline on the button (with a distinct offline message), and standby
  tablets re-check on wake instead of waiting for the hourly poll.
- Incident roles migrated from the legacy `commander` value to `editor`/`viewer` end to end.
- Atemschutz contact timing: the amber "Kontakt fällig" now starts AT the 5-min interval
  (FKS standard) and the hard überfällig alarm fires after a configurable Nachfrist
  (`contactGraceSec`, default 60 s ⇒ red at 6:00). Replaces the previous pre-warning model;
  the old `contactWarnLeadSec` doctrine/setting key is ignored.
- The container now runs as a non-root user (uid 10001). **Existing self-hosted volumes
  created by older root containers may need a one-time
  `docker compose run --rm --user root app chown -R app:app /data/storage`.**

### Fixed
- The Divera webhook now fails closed: with no `DIVERA_WEBHOOK_SECRET` configured it rejects
  all posts (403) instead of accepting unauthenticated alarms. Polling is unaffected.
- A render error on the login screen, landing list, or admin surface now shows the recoverable
  error card instead of a white screen (root-level error boundary + guarded boot init).

[Unreleased]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/feuerwehr-oberwil/kp-front/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/feuerwehr-oberwil/kp-front/releases/tag/v0.1.0
