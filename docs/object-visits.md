# Objektbesuche (object visits)

Status: 🟢 shipped 2026-10-03 (optional module, off by default). Product rationale and
mockups: the design pack `firefighting-app-review-2026-10-02/design/object-visits/` (PLAN.md).
This file is the **technical contract** the backend, the field app, the admin and any outside
organizer (e.g. fwo-admin) build against. Change it in the same change as the code.

## What it is

An optional module (`objectVisits.enabled`, off by default). A member opens **Objektbesuche** from
home's «Einsätze ▾» sheet (or an object in «Karte & Objekte», docs/karte-objekte.md) — no Einsatz — picks an object (from a work list, search or «In der Nähe»), answers
a station checklist, writes Bemerkungen, takes photos and records **Korrekturvorschläge**
(proposed master-data changes, never applied by KP Front), then «Abschliessen». Everything is
saved on the device first (IndexedDB), sent at save points, and — if a destination is configured —
filed one-way to SharePoint by the server. KP Front owns the visit record and its photos; a
destination only receives copies.

Naming: the code domain is `object_visits` / `objectVisits` / `ov`. **`backend/app/visits.py`,
`api/visits.py`, `admin_visits.py` are web analytics and unrelated** — never touch or reuse them.

## Rules that are easy to break

- **Objektbesuche live beside the Einsatz, never inside it** (03.10.2026). The module
  (`objectVisits.enabled`, `src/objectVisits/`, `src/components/objectVisits/`, backend
  `object_visits*.py`, `api/integrations.py`) owns standalone visits: no incident, no workspace
  blob, no media row. Its contract is [`docs/object-visits.md`](object-visits.md) — change
  it with the code. Rules that are easy to break: `visits.py` / `admin_visits.py` are web
  analytics and unrelated; checklist templates of `kind: "visit"` never reach an Einsatz surface
  (`loadTemplates` drops them) and Einsatz kinds never reach a visit; a visit is «Gespeichert»
  only when the server holds the latest revision AND every photo it references; a full photo
  leaves the device only after a fresh server read says it is stored; revisions are cut at save
  points, not keystrokes; a completed visit is corrected, never reopened; the SharePoint
  IMPORTER stays GET-only (`sharepoint_graph.py`) and filing writes only through
  `object_visit_sharepoint.py` with the separate `sharepoint_export_*` credentials; nothing
  remote is ever deleted. Alarms and the new-Einsatz banner stay on the Objektbesuche surface.
  «Neuer Objektbesuch» (05.10.2026) pushes once, at a visit's first completion, ONLY to the
  accounts an admin ticked (`users.notify_object_visits`, default nobody) — never widen it to
  every subscription; received visits are listed first on /admin › Objektbesuche.

- **Visit planning keeps templates separate from rounds** (03.10.2026): `visit_programmes`
  holds reusable organizer routes, never visible to crews. Annual publication is one
  transaction with a stale-revision guard; a round's stable ref and stop snapshot survive
  rescheduling/withdrawal. Never copy last year's completions into a new round. `scheduledOn`
  is a calendar day, separate from `closesAt`; archived rounds retain visits and accept late
  offline sync. Field history is collapsed, overdue work stays visible. Contract:
  `docs/object-visits.md` · Visit programmes.

## Ids

House rule ([`sync-and-offline.md`](sync-and-offline.md#the-model) · «IDs are prefixed timestamps»): every id the client mints is
`newId(prefix)` from `src/lib/ids.ts`.

| Record | Prefix | Example |
|---|---|---|
| visit | `ov` | `ov1759473240123-0kf9` |
| attachment (photo) | `ova` | `ova1759473250456-1a2b` |
| proposal | `ovp` | |
| write operation | `ovo` | |

Server validation for all four: `^[a-z]{1,4}[0-9a-z-]{6,64}$` (store as `Text`). Server-minted ids
(delivery rows, log rows) are UUIDs.

## Checklist templates of kind `visit`

Same distribution as every checklist (`checklists:<slug>` reference dataset, `admin_checklists`
CLI or `/admin › Checklisten` upload; no form builder). New `kind: "visit"`; uses `phases`
(each phase = one section). Items gain answer types:

```jsonc
{
  "id": "schluesselhuelse", "kind": "visit", "version": 1,
  "title": "Kontrolle Schlüsselhülse", "subtitle": "…", "source": "FU Oberwil",
  "phases": [{ "id": "huelse", "title": "Schlüsselhülse", "items": [
    { "id": "zugaenglich", "text": "Schlüsselhülse zugänglich", "input": "check" },
    { "id": "gereinigt",   "text": "Grob gereinigt",            "input": "yesno" },
    { "id": "zustand",     "text": "Zustand",                    "input": "choice",
      "options": [{ "id": "gut", "label": "Gut" }, { "id": "mittel", "label": "Mittel" }] },
    { "id": "anzahl",      "text": "Anzahl Schlüssel",           "input": "number", "unit": "Stk." },
    { "id": "foto",        "text": "Foto Schlüsselhülse",        "input": "photo", "required": true }
  ]}]
}
```

`input` ∈ `check` (OK / Mangel / n. a.) · `yesno` · `text` · `number` · `choice` · `photo`;
missing `input` = `check`. `required` only drives the «trotzdem abschliessen?» confirm.
Answer values (`answers[itemId].v`): `check` → `"ok"|"defect"|"na"`, `yesno` → `"yes"|"no"`,
`text` → string, `number` → number, `choice` → option id, `photo` → `"photo"` (set when ≥1 photo
links the item). A missing key = **nicht geprüft** (never «Nein»). `defect` answers may carry
`note`. The server validator accepts `kind: "visit"` and checks item `input`/`options` shape.
**Incident surfaces ignore `kind: "visit"`** (`loadTemplates` callers that render incident
checklists filter it out), and visit surfaces only use `kind: "visit"`.

**Plans on a visit.** The visit page lists the object's Modul-PDFs above the checklist
(`GET /api/objects/{id}` through the offline cache, `src/objectVisits/plans.ts`), each by the
plan's name alone, exactly as the object on the Karte names it («Modul 1», «Wasser», «PV» –
`lib/navRail · planLabel`; owner, 27.10.2026: no «· Übersicht», no subtitle); a row opens
`/api/reference/<plan id>?v=<version>` in the in-app reader (PdfScroller, one history entry so
the back gesture closes it). Nothing about plans is stored in the visit.

**Changing the checklist.** A draft's ⋯ menu offers «Checkliste wechseln»
(`doc.ts · switchChecklist`): the new snapshot replaces the old, answers of an item with the same
id AND input type stay, the others are counted and confirmed before they go, photos stay (one
linked to an item the new checklist lacks becomes general). The server already accepts a changed
snapshot while the visit is a draft.

**From an Einsatz.** Opened through the Einsatz menu, the Übersicht lists the Einsatz's active
object (`useObjectPlans · activeObjectId`) first under «Im Einsatz»; from home there is
no such row. The Einsatz stays open and MOUNTED behind the surface (`IncidentWorkspace · covered`):
its Atemschutz alarm keeps ringing and its rows stand in the strip over the visit, «Zum Trupp»
bringing the Einsatz back (docs/atemschutz-board.md · «The alarm while another surface is in
front»).

**Where a checklist may be used** (16.10.2026). A visit template may carry
`"targets": ["object", "location"]` — at a catalogue object, at a place (below), or both. Absent
means `["object"]`, so every template written before stays where it was. The validator
(`checklist_templates · template_problem`) refuses an empty list, an unknown or repeated target,
and `targets` on a non-visit kind. The chooser of a visit at a place offers only the templates
whose `targets` include `location`, plus «Ohne Checkliste»; «Checkliste wechseln» filters the
same way (`src/objectVisits/place.ts · templatesFor`). A station's «Fehlermeldung» checklist is
station data like every other (kp-front-data), never code.

## The target — a visit at an object, or at a place (16.10.2026)

A visit is AT a catalogue object or at a PLACE — a pin or an address the station has no object
for («Fehlermeldung bei Talholzstrasse 15»), without registering anything permanent. Karte &
Objekte starts the latter (`/besuche/neu?lat=&lng=&label=[&address=][&from=karte]`, below).

```jsonc
"target": { "kind": "object", "objectId": "<uuid>" }            // + "object": {…, "lat"?, "lng"?}
"target": { "kind": "location", "label": "bei Talholzstrasse 15",
            "address": "Talholzstrasse 15, 4103 Bottmingen" | null, "lat": 47.52015, "lng": 7.57175 }
                                                                 // + "object": null
```

- **A place needs no object**: `object` is `null` (and the server refuses one), `label` is
  required (≤ 200), `address` is optional — **a failed reverse geocode never blocks a pin** — and
  `lat`/`lng` are a WGS84 position (both, finite, in range). An object target's `objectId` must be
  the document's `object.id`. A visit keeps its kind of target: an object visit never becomes a
  place visit or back (422).
- **An object visit records where it was too**: the client's snapshot carries the catalogue's
  `object.lat/lng` when known; the server stores the position on the row
  (`object_visits.target_kind / lat / lng`, Alembic `b7c4d2e9f1a3`, which backfilled the object
  visits on record from their objects) — the snapshot's, else the object's at the time of writing.
- **A document without `target`** is at its `object` (every visit before 16.10.2026). ⚠️ The
  builds before this date rebuild a document key by key on a merge and drop `target`; a PUT
  without `target` and without an object, for a stored visit at a place, gets the stored place put
  back (`object_visits · _check_target`) — a passenger, never a refusal of the only copy. The
  client merge never merges `target` away either (`merge.ts`).
- **The stop.** A place has no object id. The open draft a launch link resumes is found by the
  place rounded to 5 decimals, ~1 m (`place.ts · draftKeyOf`), so a reload never makes a second
  draft. But a place visit is a **stop of its own** (`stopKeyOf`): two reports that happen to sit
  on the same pin are independent and never share a read view (lead review of #368). «Weitere
  Checkliste» starts a new, independent visit at the same place; its chooser marks only the
  checklist of the visit it came from (`&nach=<id>`). A place visit belongs to no work list.
- **Screens.** The visit is called «Meldung {label}»; where an object visit shows its address
  line, a place visit shows the **«Ort» card** — a small aerial snippet (plain raster tiles of
  the station's «Satellit» base around the point, offline whatever the device has), the label
  with a «Pin»/«Adresse» badge (`placeKind`: «Adresse» when the label is the address's first
  part), LV95, and «Kein Stationsobjekt. Ablage: Allgemeine Meldungen. …» — and once finished,
  one line «label · LV95 …». A checklist without OK/Mangel questions (a Fehlermeldung) shows what
  was reported on the visit card («Hydrant · Neuer Hydrant fehlt im Plan»), never «Keine Mängel».
  The Übersicht lists the finished place visits under «Meldungen an Orten» (drafts stay under
  «Meine Entwürfe»).
- **`from=karte`.** A launch with `&from=karte` keeps it on the visit's address
  (`/besuche/<id>?from=karte`); «Zurück» then leaves the surface to `/karte` instead of the
  Übersicht, and a finished visit offers «Zurück zur Karte» (route · `KARTE_PATH`).
- **Report.** The fact panel of a place visit reads «Objekt: – (Ort ohne Stationsobjekt)», «Ort:
  label (Pin|Adresse)», «Adresse» (when known), «Koordinaten: LV95 … · WGS84 …» and «Ablage» (the
  folder of the first enabled destination). No map picture: the report renders on the server,
  offline-safe, and fetching tiles there is neither.
- **Filing**: below (`locationFolder`), `Allgemeine Meldungen/` with the normal per-visit layout
  and no year level.
- **Readers** get `target_kind` and `location` on every visit read, every list row and every
  feed item (below).

## The visit document (`schema: "kp-front.object-visit/1"`)

What the client PUTs as `doc` and what every reader receives (server fields added on read):

```jsonc
{
  "schema": "kp-front.object-visit/1",
  "id": "ov…",
  "object": { "id": "<front object uuid>", "name": "Gemeindeverwaltung", "address": "Hauptstrasse 24",
              "folder": "Hauptstrasse 24 - Gemeindeverwaltung", "refs": [{ "source": "fwo", "id": "…" }],
              "lat": 47.51, "lng": 7.56 },               // null for a visit at a place
  "target": { "kind": "object", "objectId": "<front object uuid>" },  // or a place — «The target»
  "workRef": "fwo-admin:fu-2026/B4",            // optional, opaque, echoed
  "visitedAt": "2026-10-03T08:14:00+02:00",
  "with": ["Frei Nina"],                          // optional companions, free text
  "lifecycle": "draft",                           // draft | completed | discarded
  "checklist": { /* full template snapshot {id, version, title, phases…} or null */ },
  "answers": { "zugaenglich": { "v": "ok" }, "oeffnen": { "v": "defect", "note": "klemmt" } },
  "notes": "…",
  "photos": [{ "id": "ova…", "caption": "Deckel klemmt", "item": "oeffnen",
               "sha256": "<hex>", "size": 412233, "type": "image/jpeg" }],
  "proposals": [{ "id": "ovp…", "field": "owner_contact", "label": "Kontakt Eigentümer",
                  "current": "Hr. Brunner", "proposed": "Hr. Keller", "reason": "…",
                  "base": { "source": "kp-front", "asOf": "2026-10-01T03:00:00Z" } }],
  "conflicts": [ /* client-only bookkeeping of unresolved merges; server stores it opaquely */ ]
}
```

Server-added on read: `revision`, `ready`, `missing` (photo ids not yet stored), `createdBy`
`{id, name}`, `createdAt`, `updatedAt`, `updatedBy`, `findings` (count of `defect` answers),
`url` (`<PUBLIC_URL>/besuche/<id>`; relative `/besuche/<id>` when `PUBLIC_URL` is unset),
`deliveries` (`[{destination, state, revision, at, error?}]` — `revision` is the delivered one,
`error` only while `failed`/`pending`), `target_kind` (`"object" | "location"`) and `location`
(`{label, address, lat, lng}` — the place, or the object's name, address and position; `null`
when nothing is known), `completedAt` (the moment the FIRST revision said `completed`; `null`
otherwise) and `lockedAt` (from when corrections are refused — `completedAt` +
`objectVisits.lockAfterHours`; `null` where no lock applies).

Validation (422 with a German `detail`): no string anywhere (keys included) holds a NUL or a lone
surrogate (Postgres cannot store either — same rule on the organizer's object/list bodies and
path ids), schema string, id matches path, the target (see «The target»: a place has no object,
a label and a position), object id exists (for a NEW object reference: a visit
whose recorded object was later deleted keeps saving; its link goes to wherever a merge/re-key
moved it, else NULL, and the document keeps the snapshot),
`lifecycle` transitions: `draft→draft|completed|discarded`, `completed→completed` (a correction,
and only while the lock window is open — see «The lock»), `discarded` is terminal; **no reopen**. Photo/proposal ids unique; ≤ 200 photos, ≤ 100 proposals,
text fields bounded (notes ≤ 20 000 chars, caption ≤ 300). The checklist snapshot may only change
while the visit is a draft.

## The lock — a completed visit goes view-only (20.10.2026)

A completed Objektbesuch may be corrected for a while and then stands as the record (owner:
«currently open for editing indefinitely … this plan is open for more than a week and it still
hasn't closed»). The window is `objectVisits.lockAfterHours`, **24 hours by default**; `0` locks
the visit the moment it is completed, `null` never locks it.

- It is counted from the **completion**, not from the last change: `completedAt` is the first
  revision whose lifecycle was `completed`, so a correction never buys another day.
- The **server** enforces it (`object_visits · refuse_locked_correction`): a `completed→completed`
  write after `lockedAt` is refused `422 {code: "locked", detail, lockedAt}`. A resend of the
  document the server already holds is still the no-op answer — only a real change is refused.
- The **admin session / the organizer** (a write with no account behind it) still corrects: a
  station must be able to fix its own record afterwards.
- **Drafts are untouched**: a draft is not finished, and `draft→completed` is never a correction.
- The app draws it off the server's `lockedAt` (`objectVisits/lock · visitLocked`), never off its
  own clock-and-config arithmetic: the read view then has no «Bearbeiten» row but a line saying
  since when the visit is view-only (`StopCards · LockedRow`). A completion the server has not
  seen yet (finished offline) has no `lockedAt` and is not locked on the device — the correction
  is sent and the server decides.
- **«Weitere Checkliste» stays**: a new visit at the same object is not a correction of the old one.

## Field API — `/api/object-visits` (session; never a link/terminal/poster session)

Reads: any account session (`editor`, `el`, `viewer`) and the admin session.
Writes: account whose role is in `objectVisits.captureRoles` (default `["editor","el"]`).
Module off ⇒ every route 404 `{code: "object_visits_disabled"}` except for the admin session.
Incident-link guest sessions (`LINK_GUEST_ID`: alarm, view, Atemschutz, terminal) ⇒ 403, with or
without `X-Incident-Link: use`; a request carrying only the poster's `X-Capture-Token` ⇒ 403; no
session at all ⇒ 401. The integration bearer key opens nothing here. Tests assert all of it.

Refusals carry a `code` at the top of the body **and** a German `detail`:
`{code, detail, …extra}` — `invalid` / `lifecycle` / `locked` (422, `locked` also carries
`lockedAt`), `forbidden` / `link_session` (403),
`not_found` / `visit_not_found` / `object_visits_disabled` (404), `revision_conflict` /
`attachment_conflict` (409). `by`, `createdBy`, `updatedBy`, `acceptedBy` are always `{id, name}`
(`by` = the visit's creator).

| Route | Answer |
|---|---|
| `GET /catalogue` | `{generatedAt, canCapture, objects:[{id,name,address,lat,lng,folder,refs,hasPlans,lastVisit:{id,visitedAt,lifecycle}\|null}], templates:[visit templates], lists:[{ref,title,note,closesAt,scheduledOn,archived,objectIds:[…],unresolved:[{source,id}],done:{"<objectId>":{at,by?,source?,note?}}}], proposalFields:[{id,label}]}` |
| `GET /?object=&workRef=&mine=1&lifecycle=&limit=` | `[{id,objectId,objectName,target_kind,location,workRef,lifecycle,revision,ready,visitedAt,updatedAt,by,with,findings,checklist}]` newest first (`with`: the document's people, `[string]`; `checklist`: `{id,title}` of the visit's checklist, null without one; `objectId`/`objectName` null for a visit at a place) |
| `GET /{id}` | the visit (document + server fields) |
| `PUT /{id}` | body `{opId, baseRevision: int\|null, doc}` → `200 {revision, ready, missing, visit}` · `409 {code:"revision_conflict", revision, visit}` · `422` · same `opId` again ⇒ the stored first answer (idempotent replay, even if newer revisions exist) |
| `PUT /{id}/attachments/{attId}` | raw bytes; headers `Content-Type`, `X-Content-SHA256` (hex). `201 {id, sha256, size}` new · `200` same id+hash already stored · `409 {code:"attachment_conflict"}` same id other hash · `422` hash/body mismatch, type not jpeg/png/webp (magic bytes), > 15 MB. The visit must exist (send the doc first). |
| `GET /{id}/attachments/{attId}[?thumb=1]` | the bytes (thumb: 320 px JPEG, derived, regenerable) |
| `GET /{id}/revisions` · `GET /{id}/revisions/{n}` | `[{revision, lifecycle, acceptedAt, acceptedBy, ready}]` · the full document of revision n |
| `GET /{id}/report.pdf[?revision=n]` | the readable report (ReportLab), latest revision by default |

`baseRevision: null` creates; it is a 409 if the visit already exists (unless it is an `opId`
replay). A non-null `baseRevision` for a visit the server does not hold (e.g. after a restore) is
accepted as the create it has to be — refusing it would strand the only copy on a device.
`GET /{id}/revisions/{n}` answers the document plus `{revision, ready, acceptedAt, acceptedBy}`. Every accepted PUT writes an immutable `object_visit_revisions` row (revision = previous
+1) even if the doc is unchanged? **No:** a PUT whose doc equals the current doc is answered
`200` with the current revision and writes nothing.

Catalogue details: objects are every `objects` row (with or without plans) ordered by name;
`lastVisit` is the newest non-discarded visit by `visitedAt`; `templates` are the `checklists:<id>`
datasets whose JSON has `kind: "visit"`, ordered by `order` then title; `lists` resolve their refs
live through `object_refs`.

**Readiness.** A revision is ready when every `photos[].id` it references is stored. Storing the
last missing attachment marks every waiting revision of that visit ready **and enqueues delivery in
the same transaction**. `visit.ready` = latest revision ready.

## Integration API — `/api/integrations` (organizer key)

Auth: `Authorization: Bearer <key>`; key = credential `object_visits_integration_key` (group
`object_visits`, secret, set from `/admin`, ≥ 24 characters). Constant-time compare. Unset key ⇒
403, missing/wrong key ⇒ 401 (a browser session is not the key). Works even when the module is
off? **No** — with a valid key, module off ⇒ 404 like the field API.

⚠️ `{externalId}` and `{ref}` are matched as PATHS (`{external_id:path}`, `{ref:path}`): a list
ref like `fwo-admin:fu-2026/B4` contains «/», and the server decodes `%2F` before routing, so
either form arrives as the same id.

| Route | Purpose |
|---|---|
| `GET /object-visits/catalogue` | same as the field catalogue (`canCapture` false), plus `cartoBasemapKey` (nullable public browser credential) for the organizer's map. Allow the organizer's domain at CARTO too. |
| `PUT /objects/{source}/{externalId}` | body `{name, address?, lat?, lng?, folder?}`. Resolve: existing ref → that object; else an object whose `filing_folder` (or derived folder) equals `folder` → attach the ref; else create an `ObjectSite` (`source_note = "Integration: {source}"`, no plans). Updates `filing_folder` / lat / lng when given and the object has none (never renames a plan-carrying object; renames only a plan-less object this same `source` created). Folder comparison is Unicode-composed, case- and whitespace-insensitive. `200 {objectId, created}`. Path segments URL-encoded; `externalId` ≤ 300 chars. |
| `DELETE /objects/{source}/{externalId}` | removes that ref; the OBJECT goes too only if this integration created it (`source_note` «Integration: …»), it has no plan, no visit (any lifecycle) and no other ref. Lists that named the ref then report it under `unresolved`. `200 {removed: "ref" \| "object" \| "none"}` — idempotent (`none` = no such ref) |
| `GET /objects/by-ref/{source}/{externalId}` | resolve the organizer's id: `200 {objectId, name, address, lat, lng, folder, refs, hasPlans}` · `404` unknown ref. (The catalogue's `objects[].refs` resolves the same way in bulk.) |
| `GET /objects/{objectId}/plans` | the object's plans, read-only, one per Modul-Slot: `200 [{module, title, revision, contentType, size}]` (`revision` = the plan's current version) · `404` unknown object. Plan-less object ⇒ `[]` |
| `GET /objects/{objectId}/plans/{module}[?revision=n]` | the plan bytes (`application/pdf`, inline, header `X-Plan-Revision`) — current, or the pinned revision `n` (the same immutable revision store an Einsatz pins) · `404` unknown object/module/revision |
| `PUT /visit-lists/{ref}` | body `{title, note?, closesAt?, objects:[{source, id, done?}]}` (ordered, ≤ 500). `done` = a completion the ORGANIZER already holds for that stop (e.g. last round in SchlüHü): `{at: "YYYY-MM-DD", by?: ≤120, source?: ≤60 (e.g. "SchlüHü"), note?: ≤500}`; unknown keys, a non-date `at` or NUL/surrogates ⇒ 422. Stored as sent and shown — KP Front never turns it into a visit. Unresolved refs (and their `done`) are kept and reported. `200 {ref, objectIds, unresolved, done: {"<objectId>": {…}}}` (resolved stops only; first entry wins if two refs name one object) · `DELETE /visit-lists/{ref}` → `200 {ref, deleted}` (idempotent) |
| `GET /object-visits/changes?after=<seq>&limit=<≤500>` | `{items:[FeedItem], nextAfter}`; `FeedItem = {seq, id, objectId, objectRefs, objectName, workRef, revision, lifecycle, ready, visitedAt, updatedAt, by, with, findings, proposals:[…], deliveries:[…], url, target_kind, location}` — one item per visit at its latest state, ordered by `seq`. `objectRefs` is read LIVE from `object_refs`, so a ref attached later (an object upsert matching by folder) appears on the next poll. `nextAfter` = the last item's `seq`, or `after` when empty. **Downstream contract (C2, 16.10.2026):** `target_kind` is `"object"` or `"location"`; for `"location"` the object fields are null (`objectId`, `objectName`, `objectRefs: []`); `location` = `{label, address, lat, lng}` — the place as captured, or for an object visit the object's name, address and position. A reader tolerates both an item without them (an older server) and one with them |
| `GET /object-visits/{id}` · `/report.pdf` · `/attachments/{attId}` | read-only copies for review |

### Visit programmes — reusable routes and scheduled rounds

Organizer-key endpoints (module must be enabled):

- `GET /visit-programmes/{programme_ref}` → `{revision, routes, years}`. Unknown ref answers revision 0
  with empty arrays; reading creates nothing. Ref is ≤100 letters/digits/`:`/`.`/`_`/`-`.
- `PUT /visit-programmes/{programme_ref}/routes`, body `{revision, routes}`. Route =
  `{code, title, objects:[{source,id}], retired:false}`. Codes are stable, unique (≤40
  letters/digits/hyphens); 200 routes, 500 ordered unique stops each. Existing routes can be
  retired/reactivated, not deleted. Templates never appear in the field catalogue.
- `PUT /visit-programmes/{programme_ref}/years/{year}`, body
  `{revision, assignments:[{code,scheduledOn:"YYYY-MM-DD"}]}`. Each route once, all dates in
  the supplied year (2000–2200). Empty selection withdraws the year's rounds. All changes
  and the revision increment commit atomically; stale revision → 409 `planning_conflict`.

Publication creates work refs `{programmeRef}-{year}/{code}` (e.g.
`fwo-admin:fu-2027/A1`). First publication snapshots ordered object refs. An existing work
list is adopted intact, including organizer `done` entries. Republish changes dates and
visibility only; editing a template never rewrites a published snapshot or any visit.
Unselected lists in that exact programme/year become `archived:true`, retaining visits,
completions and reports. Re-selecting restores the same ref/snapshot. A new year has new refs
and no imported completion ticks. Direct legacy list PUT/DELETE against a managed year
returns 409 `managed_list`; use the programme endpoint.

Catalogue lists add `scheduledOn` (calendar date, no timezone conversion) and `archived`.
The existing `closesAt` deadline remains separate. Field overview groups Today, Overdue,
Upcoming and Undated, then «Kürzlich erledigt»: a complete round whose last stop was done in
the last 7 days. Withdrawn rounds and older complete ones are not listed in the field app —
the organizer holds that record (fwo-admin, the filed reports). An archived list (reached by
link) opens existing visits but offers no new capture. Already captured/offline visits remain
syncable after withdrawal. Old cached catalogues lacking these fields remain usable.

Storage: `visit_programmes` plus `visit_lists.scheduled_on/archived`, Alembic
`e2f3a4b5c6d7`. Old lists are undated/unarchived; migrations do not select or schedule them.
The existing whole-database backup includes the programme. Deploy this API before its
organizer UI. No new key or operational service is needed.

**Progress on a list, and its precedence.** A stop is complete when a visit with the list's `ref`
as `workRef` and lifecycle `completed` exists for its object — that real visit always wins in
display (its date, its people, its report). Only where none exists does the organizer's `done`
show the stop as complete («erledigt 14.10.2025 · SchlüHü · Frei Nina»). A draft for the stop does
not hide a `done`; the stop then reads as done-before and in progress.

**Several visits at one stop** (14.10.2026). A stop may hold more than one visit — typically a
second checklist after the first was the wrong one. A completed visit offers «Weitere Checkliste»
(a new visit, same object, same `workRef`; the route resumes this person's open draft for the stop
instead, so it never makes a third). The stop counts once; its row says «n Checklisten» and opens
the newest completed visit, whose page shows every visit at the stop as its own card (below). The
checklist chooser marks the checklists already completed at the stop.

**The read view** (15.10.2026, owner: «just the information we care about»). A work list's row is
the stop: a finished stop's number turns into a green tick, the chip says only what still needs an
eye (Mängel, photos on the way, a draft), and a date appears only where it is not the round's own
day; an open stop keeps «zuletzt …/noch nie besucht». A finished visit's page is one card per visit
at the stop, oldest first — checklist, when, who, the Mängel by name or «Keine Mängel» — with its
own rows: «Bearbeiten» (on another visit's card: that visit, opened straight into the correction,
`?bearbeiten=1`), «Bericht (PDF)», and ONE line: «Abgeschlossen …», or «Korrigiert …» once
corrected, which opens the completed revisions, each its report. The drafts' save points before
the completion are not history. The card's head opens the visit's answers on a screen of their own
(`/besuche/<id>/antworten`: the checklist one line per question, then Bemerkungen, Fotos,
Vorschläge) — they are off the visit page because the full output usually leaves through the
filing. Under the cards: «Weitere Checkliste», the next stop, the plans. The head says only
«Abgeschlossen» while the visit is on the server; anything still owed (not sent, photos, a failed
filing) shows there in its tone.

**Who.** Accounts are generic (a station tablet, «fu»), so the document's free-text people
(`with`, wire key unchanged) are the primary «who»: the report prints «Von: <with>» and the
account smaller as «Konto: <createdBy.name>»; with `with` empty, «Von» falls back to the account.
`by` (the creating account) stays in every summary; `with` sits beside it.

`seq` is a global sequence bumped whenever a visit's revision, readiness or a delivery state
changes. The organizer polls; no webhooks. It is a one-row counter (`object_visit_seq`) bumped
LAST inside the writing transaction, not a bare Postgres `SEQUENCE`: a sequence hands numbers out
in call order but they become visible in commit order, so a poller could read 6 before 5 committed
and skip 5 forever. The row lock makes numbers visible in the order they were handed out.

**Objects created here stay off incident surfaces.** An object whose `source_note` starts with
`Integration:` and that has no plan (a key box) is left out of `GET /api/incidents/{id}/objects`
and, for field sessions, of `GET /api/objects` (the plan pickers). The admin session's
`GET /api/objects` and the Objektbesuche catalogue list it. They are also left out of the station box the
building snapshot is fetched for (`reference_buildings.station_bbox`). A merge or re-key in
`admin_objects` moves a removed object's visits and refs to the survivor; removing an object
clears its visits' link (the visits stay) and drops its refs.

## Admin — `/api/admin/object-visits` (admin session)

`GET /` (all visits, filters as the field list, each with its `deliveries` — see «Received visits»
below) · `GET /notify` · `PUT /notify` (see «Notification») · `GET /deliveries[?state=&destination=]`
(`[{destination, visitId, objectName, wantedRevision, deliveredRevision, state, attempts,
nextAttemptAt, lastError, updatedAt}]`) · `POST /deliveries/retry {destination, visitId?}` →
`{retried: n}` (failed → pending, attempts reset; with `visitId` it also enqueues that visit if the
destination does not hold it yet — e.g. a destination added later) ·
`POST /destinations/{id}/test` → `{ok, status, detail, webUrl?}` (touches no visit and deletes
nothing: uploads one small `_kp-front-test.txt` into the destination root and reports the Graph
answer; works for a disabled destination too) ·
`GET /export.zip?…` (visits as JSON + photos + reports, for a station without a destination;
written entry by entry to a temporary file; a visit that cannot be exported gets `FEHLER.txt` in
its folder and the export goes on).

**Received visits** (owner, 05.10.2026: «where do filled out object visits show»): the admin page
Station › Objektbesuche opens on «Besuche» — every visit newest first with date, object, «Von»,
state, findings, **Ablage** (per destination: state, the folder path below the library from
`remote_items._path`, copyable, and the error while it fails) and the report PDF, which is the
visit's detail view. `GET /` therefore adds `deliveries: [{destination, state, revision, at,
folder, error?}]` to each summary (admin list only; same «owed nothing» rule as the visit's own
`deliveries`).

### Notification — «Neuer Objektbesuch»

Web Push (the app's VAPID push, `app/push.py`) to the accounts an admin picked —
`users.notify_object_visits` (Alembic `f9b8c7d6e5a4`, default false: **nobody** until somebody is
ticked; never every account, never every installed device).

- Fires once per visit, when an accepted PUT first takes it to `completed` (a create that is already
  completed counts). Never for a draft save point, a correction or a discard. Queued with
  `after_commit`; the audience is read in the sending session after the commit, so it is the list
  that holds when the push leaves. Push off (no VAPID keys) ⇒ nothing is queued.
- Audience: the picked ACTIVE accounts' browsers only (`broadcast(user_ids=…)`) — no kiosk rows, no
  other account, nobody for an empty list. A shared account reaches every device signed in with it.
- Payload: title «Neuer Objektbesuch», body «<Objekt> · <Von> · <n> Mängel» (findings only when
  there are any), tag `ov-<id>`, target `besuch:<id>`. A tap opens `/besuche/<id>` — the service
  worker opens that address on a cold start (`public/sw-notify.js`), a running app navigates there
  (`App.tsx`).
- Admin: `GET /notify` → `{pushEnabled, accounts: [{id, name, username, role, notify, devices}]}`
  (active accounts; `devices` = that account's unexpired push registrations) · `PUT /notify
  {userIds: [uuid…]}` → the same answer; exactly these accounts are told (unknown ids are ignored,
  a non-list or a non-uuid is 422). UI: the «Benachrichtigung» card under «Besuche».

## Deployment config — section `objectVisits`

```jsonc
"objectVisits": {
  "enabled": false,
  "captureRoles": ["editor", "el"],
  "lockAfterHours": 24,                          // see «The lock»; 0 = at once, null = never
  "proposalFields": [{ "id": "owner_contact", "label": "Kontakt Eigentümer" }],
  "destinations": [{
    "id": "sharepoint-fu", "kind": "sharepoint", "enabled": true,
    "timing": "every-sync",                      // every-sync | completed
    "siteUrl": "https://fwoberwil.sharepoint.com/sites/FWO", "library": "Dokumente",
    "root": "FÜHRUNGSUNTERSTÜTZUNG/Einsatzpläne",
    "objectFolder": "{object.folder}",
    "visitFolder": "Objektbesuche/{date} {checklist} ({short})",
    "locationFolder": "Allgemeine Meldungen/{date} {checklist} ({short})"   // default; a visit at a place
  }]
}
```

A visit at a place has no object folder: it is filed under `root` / `locationFolder` instead of
`objectFolder` / `visitFolder` — one general folder with the normal per-visit layout and **no year
level** (`object_visit_delivery · folder_segments`). The other placeholders work there too, plus
`{location.label}` and `{location.address}` (for an object visit they are its name and address).

Placeholders: `{object.folder}` (`objects.filing_folder`, else the folder the object's
`source_note` names — «OneDrive: Einsatzpläne/<folder>», «SchlüHü hub: Einsatzplaene/<folder>», or
«<address> - <name>» for an object the SharePoint pull created — else `{object.address} -
{object.name}`, else the name), `{object.name}`, `{object.address}`, `{date}` (YYYY-MM-DD of `visitedAt`, Europe/Zurich),
`{checklist}` (title or «Besuch»), `{short}` (last 4 chars of the visit id). Path segments are
sanitised for SharePoint (`" * : < > ? / \ |` and leading/trailing dots/spaces removed).

Credentials (group `sharepoint_export`, separate from the read-only import group):
`sharepoint_export_tenant_id`, `sharepoint_export_client_id`, `sharepoint_export_client_secret`.
The importer's credentials are never used for writing. Admin labels: group `object_visits` →
«Organizer-Schlüssel» (`object_visits_integration_key`, secret); group `sharepoint_export` →
«Azure Tenant-ID (Ablage)», «Azure Client-ID (Ablage)» (readable, GUIDs), «Azure Client-Secret
(Ablage)» (secret). Setup: [`object-visits-sharepoint.md`](object-visits-sharepoint.md).

Validation: destination `id` lower-case `[a-z0-9_-]`, unique; `siteUrl` https; `root`,
`objectFolder`, `visitFolder` plain paths (no `..`); `captureRoles` ⊆ `editor, el, viewer`;
`lockAfterHours` an integer 0…8760 or `null`; proposal field ids unique. Nothing in the section is secret — `GET /api/config` is public.

**Filing folders.** `objects.filing_folder` is set by the SharePoint plan pull — on every run,
for every folder it lists: objects the pull created follow the folder name (a rename in
SharePoint moves it), any other object gets it only where it has none — by the manifest import (`folder`, optional) and by an
organizer's object upsert (`folder`); the migration backfilled it from `source_note`. A manifest
entry may also carry `refs: [{source, id}]`, and `PUT /api/objects/{id}` accepts optional
`filing_folder` and `refs` — written only when sent, refs only ever added.

## Delivery

- Outbox row per `(destination, visit)`: `wanted_revision`, `delivered_revision`, `state`
  (`pending|delivered|failed|paused`), `attempts`, `next_attempt_at`, `lease_owner`,
  `lease_until`, `last_error`, `remote_folder_id`, `remote_items` (`{"<attId>": driveItemId,
  "_folder": …}`), plus an append-only `object_visit_delivery_log`.
- Eligibility: `every-sync` = every ready revision; `completed` = ready revisions with lifecycle
  `completed` (corrections included) and a `discarded` revision of a visit that was delivered
  before.
- Worker: APScheduler job every 30 s on the scheduler leader; claims due rows with
  `FOR UPDATE SKIP LOCKED` and a 5-minute lease (plan-alignment pattern). For each revision
  `delivered+1 … wanted` that is eligible, in order: write `Verlauf/r{n} {YYYY-MM-DD HHmm}.pdf`
  and `.json`; then the current `Objektbesuch.pdf` + `Objektbesuch.json` (after checking the
  remote `Objektbesuch.json`'s `revision` is not higher — a higher one means a newer worker won:
  stop), then photos not yet in `remote_items` into `Fotos/{NN} {caption} ({att4}).jpg`; photos
  no longer in the doc are moved to `Entfernt/`. `delivered_revision` advances by CAS only.
- The visit's folder path is fixed at its first delivery (`remote_items._path`): a correction
  that changes the date or the checklist lands in the SAME folder. The destination `root` must
  exist (404 → `failed`); object and visit folders below it are created. Photos keep their type's
  extension (`.jpg`/`.png`/`.webp`); moved ones are remembered in `remote_items._removed`.
- Lost responses: before creating a folder, look it up by path (and a 409 on create is answered by
  looking up again); upload is a PUT of `…:/content` (idempotent by path), the current
  `Objektbesuch.json` with `If-Match` on the eTag read at the fence.
- A worker that finds a newer remote revision stops. If it LOST A RACE (its lease is gone and
  another pass moved the row on), a `delivered` row goes back to `pending` once, after the first
  backoff step, so one heal pass rewrites the current files at the delivered revision. If it still
  holds the lease, the remote is simply ahead of this server (a restored database, a second
  deployment): `failed` with «Ablage hat neuere Revision r8 als der Server (r6) – prüfen». A 412 on
  the `If-Match` while holding the lease is a backoff retry. The folder path learned on the way is
  kept (`remote_items._path`) and the feed's `seq` is bumped either way.
- No eligible revision in `delivered+1 … wanted` (drafts queued under `every-sync`, then the
  destination switched to `completed`) is not an error: the row rests as `delivered` at what it
  delivered (`wanted` lowered to it), and such a row that never delivered anything is left out
  of a visit's `deliveries`.
- A report that cannot be rendered is `failed` («Bericht r{n} konnte nicht erstellt werden: …»),
  never retried blindly. Reports render one revision at a time, each photo is downscaled once per
  pass and uploaded alone, so a pass holds one report and one photo in memory.
- Moving a removed photo to `Entfernt/` uses `conflictBehavior=rename` (a photo removed, re-added
  and removed again lands as «… 1.jpg»); a 404 (removed by hand) counts as done.
- Failures: 401/403/404 → `failed` (actionable, no automatic retry until «Erneut versuchen», a
  config change or a credential change); 409/412/429/5xx/network → backoff 1 min · 5 min · 15 min ·
  1 h · 6 h (cap), stays `pending`. A disabled/removed destination — or the module switched off —
  pauses its rows (kept); re-enabling resumes from `delivered_revision`. «A config change» is
  measured: the row keeps a fingerprint of the destination + the `sharepoint_export` credentials
  at failure, and any difference puts it back to `pending`.
- Ready-but-not-yet-eligible revisions (drafts under `completed`) create no row at all.
- Nothing remote is ever deleted.

## Device (field app)

- Code: `src/objectVisits/` (store, outbox, merge, catalogue, api, types — each with tests) and
  `src/components/objectVisits/` (UI). Copy: `appConfig.copy.objectVisits.*` in all four locales.
- Entry: the «Objektbesuche» row in the «App» group of the app menu — home's «Einsätze ▾» sheet
  and the Einsatz menu render the same rows (`panels/AppMenuRows`, 17.10.2026; module on + role
  can capture or read) —, and
  «Karte & Objekte» (`…&from=karte`: leaving lands on the viewer again);
  routes `/besuche`, `/besuche/<id>`, `/besuche/neu?object=<source>:<id>|<uuid>&ref=<workRef>`,
  and for a visit at a place `/besuche/neu?lat=<lat>&lng=<lng>&label=<label>[&address=<address>]`
  (an `object=` wins over a position); any of them may carry `&from=karte` («The target»).
  The `neu` launch resumes this device's/user's open draft for `(object, workRef)` — or for the
  place — before minting a new id; nothing is sent until the first save point. `&checkliste=<id>`
  (the Karte's «Melden», 17.10.2026: `fehlermeldung`) asks for that checklist up front: taken when
  the catalogue has it — and then only an open draft OF it is resumed — else the chooser as without.
- IndexedDB keys: `kp-front-ov-catalogue`, `kp-front-ov-index` (list of local visit ids),
  `kp-front-ov-<visitId>` `{doc, base:{revision, doc}|null, dirty, savedAt, sent:{revision,
  ready, missing}, lastError}`, `kp-front-ov-att-<attId>` `{blob, thumb, type, sha256, size}`.
  `idbSet` must return durable or the UI shows «Nicht gespeichert»; a failed read is never empty;
  blobs never go to the localStorage fallback.
- «Von» starts with the names last typed on this device (localStorage `kp.ov.with`, editable on
  every visit; no setting). Not the prefs cookie: Safari caps a script-written cookie at 7 days, so
  the name was gone by the next tour (05.10.2026). «Besucht am» starts as now and is the shared
  wheel picker (`DateTimeField`, «Jetzt», no «Leeren»).
- Save points (a revision): leaving the visit, `visibilitychange → hidden`, «Abschliessen»,
  «Jetzt senden», and every 2 min while dirty. Photos upload as soon as the visit exists on the
  server.
- Cross-tab: Web Locks `kp-ov-<visitId>` around a flush; `BroadcastChannel('kp-ov')` to refresh.
- Conflict (409): three-way merge against `base` per key (each answer, notes, visitedAt, with,
  each photo by id incl. caption, each proposal by id, lifecycle by rank discarded > completed >
  draft). Disjoint ⇒ resend silently. Same key both sides ⇒ keep the server value, push the local
  one into `conflicts[]` and show «Zwei Fassungen» (Meine / Andere / Beide behalten for text).
- Auth expiry: work stays; status «Anmeldung nötig»; outbox resumes after login.
