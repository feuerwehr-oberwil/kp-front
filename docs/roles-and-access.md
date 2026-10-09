# Roles and access

Who may write what: the incident roles, the separate deployment admin, and the incident links. The
allowlists live in `backend/app/auth/incident_link.py`. Moved here from AGENTS.md on 2026-10-08,
wording unchanged.

## Incident roles, the deployment admin and links

- **Role gating** – product model is three incident roles: `editor` (FU / can mutate incident
  state), `el` (Einsatzleiter function, 07.09.2026 – reads everything, writes ONLY the record
  domains: Anwesenheit/Zeitplan, Mittel, Checklisten, Rapport + Beilagen, via the
  server-enforced `PUT …/workspace/record` slice (`RECORD_WORKSPACE_KEYS`), journal/event
  appends limited to the record vocabulary (`EL_EVENT_PREFIXES`), media uploads, and — since
  10.09.2026 — the EINSATZDATEN at the head of that record: `PATCH /incidents/{id}` limited to
  the fields «Einsatzdaten bearbeiten» sends (`EL_META_FIELDS`); the full workspace PUT, the
  trupps slice, the incident lifecycle (`status`, `is_archived`, `report_done_at`) and
  everything tactical stay 403 for it), and `viewer`
  (read-only). The Führungsansicht is the LOGIN's (`el_view_default`, the admin's Benutzer · «Führungsansicht»);
  the per-device toggle in the Einstellungen is gone (05.10.2026, owner: «drop Führungsansicht in settings. We
  can use users») and a stored `prefs.elView` is ignored. Frontend: `isEl` behaves like an editor's Führungsansicht (`tacticalLocked`
  on, `readOnly` off) with `canEditRecord` unlocking the four surfaces, `canEditMeta` the
  Einsatzdaten panel, and the sync pushing `slice: 'record'`. ⚠️ **A door the role cannot go
  through is not drawn** — hidden, never disabled-without-a-reason (3am test, 25.09.2026). A
  READ-OUT is not a door: it stays, disabled in the `.wb-object:disabled` recipe (full opacity,
  its own words and tone, no tap). So a locked session (el, Führungsansicht, viewer, replay) keeps
  the building's name, the Massstab and the linked «⌖ Karte» chip as read-outs — an unchecked
  automatic fit must never look like a checked one, whoever is looking — but gets no «Anderes
  Gebäude wählen» (the locked picker has no «Übernehmen»), no Passung, no «Gebäude drehen». Every
  session that cannot share links (`canShareLink` false: el, Führungsansicht, viewer, link) gets
  no «Weitergeben» section, and so sends no GET for a link it may not read. The `el` also gets no
  saved-view writes, no vehicle override, no object switch, no «Wieder öffnen», no transcription
  and no checklist «Zeichnen» link. The legacy `commander` value has been migrated away: the stored role,
  the `Literal`/type unions, the `CurrentEditor` dependency, and `user?.role === 'editor'` checks
  all use `editor` now. Do not reintroduce `commander`, and do not add deployment-admin power to the
  incident role model. Deployment administration is **separated** behind the `ADMIN_SECRET` env var:
  the `/admin` UI and admin-write API (config, branding, system, user CRUD, geodata/objects) gate on
  `get_current_admin` / `CurrentAdmin` (a secret-backed admin-session cookie via `/api/admin/login`),
  not the editor role; the `admin_geodata`/`admin_objects` `push` CLI uses `KP_ADMIN_SECRET`. It's
  **fail-closed** – unset `ADMIN_SECRET` → admin endpoints 403, never the editor PIN. Incident
  endpoints stay on `CurrentEditor`, with ONE exception: the Atemschutz-Link (a QR minted from a
  running Einsatz that lets a non-FU operate only the Atemschutzüberwachung) writes through
  `CurrentAtemschutzWriter` on exactly three routes – `PUT …/workspace/trupps`, `POST …/journal`
  (`kind: 'team'` rows only) and `POST …/events` (`atemschutz.*` only); the allowlist and the
  liveness rules live in `backend/app/auth/incident_link.py`. ⚠️ Every link kind may also
  `POST /api/diag/client-error` (24.09.2026), even with a dead session (liveness-exempt). The
  route needs no session and is throttled per source in its own handler. Without it, a crash on
  a responder's phone got a 403 and never reached the log. Its read half, `GET /api/diag/export`,
  stays off every list. A refusal logs its reason server-side (`kpfront.linkscope`) and never
  sends it to the holder. Never widen the full workspace PUT
  to a link session. **A link is the literal page and touches nothing on the device** (02.09.):
  its cookie has to be site-wide (an `<img>` carries no header), so the PAGE says which session
  it is asking with — `X-Incident-Link: off` from the app and `/admin`, `use` from the
  handed-over Atemschutz board, nothing from a subresource or an alarm/view link page
  (`src/lib/linkMode.ts` ↔ `LINK_MODE_HEADER`). Consequences to keep true: the bare site after a
  link visit is whoever it was before, an Atemschutz link no longer signs the phone out to win
  precedence, `logout` is off the allowlist, and **no link surface offers «Abmelden»** — leaving
  a link is closing the page, and coming back is the link URL. Two rules that fall out of the
  same model and are easy to break: a page sending `use` with no live link session is **401, never
  the device's login** (falling through would turn a lapsed board into the phone owner's account),
  and the device's own «Abmelden» **does** clear the link cookie — headerless requests (typed
  address, `<img>`, service worker) answer as the link guest otherwise. That «Abmelden» **always
  confirms** (23.09.2026, `lib/logoutConfirm`), in one card that adds the offline and the
  unsent-entries cost when there is one.
