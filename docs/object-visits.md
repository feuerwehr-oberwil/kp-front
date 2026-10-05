# Objektbesuche (object visits)

Status: in development (feature branch `feat/object-visits`, 2026-10-03). Product rationale and
mockups: the design pack `firefighting-app-review-2026-10-02/design/object-visits/` (PLAN.md).
This file is the **technical contract** the backend, the field app, the admin and any outside
organizer (e.g. fwo-admin) build against. Change it in the same change as the code.

## What it is

An optional module (`objectVisits.enabled`, off by default). A member opens **Objektbesuche** from
the launcher — no Einsatz — picks an object (from a work list, search or «In der Nähe»), answers
a station checklist, writes Bemerkungen, takes photos and records **Korrekturvorschläge**
(proposed master-data changes, never applied by KP Front), then «Abschliessen». Everything is
saved on the device first (IndexedDB), sent at save points, and — if a destination is configured —
filed one-way to SharePoint by the server. KP Front owns the visit record and its photos; a
destination only receives copies.

Naming: the code domain is `object_visits` / `objectVisits` / `ov`. **`backend/app/visits.py`,
`api/visits.py`, `admin_visits.py` are web analytics and unrelated** — never touch or reuse them.

## Ids

House rule (AGENTS.md · «IDs are prefixed timestamps»): every id the client mints is
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
(`GET /api/objects/{id}` through the offline cache, `src/objectVisits/plans.ts`); a row opens
`/api/reference/<plan id>?v=<version>` in the in-app reader (PdfScroller, one history entry so
the back gesture closes it). Nothing about plans is stored in the visit.

**Changing the checklist.** A draft's ⋯ menu offers «Checkliste wechseln»
(`doc.ts · switchChecklist`): the new snapshot replaces the old, answers of an item with the same
id AND input type stay, the others are counted and confirmed before they go, photos stay (one
linked to an item the new checklist lacks becomes general). The server already accepts a changed
snapshot while the visit is a draft.

**From an Einsatz.** Opened through the Einsatz menu, the Übersicht lists the Einsatz's active
object (`useObjectPlans · activeObjectId`) first under «Im Einsatz»; from the launcher there is
no such row.

## The visit document (`schema: "kp-front.object-visit/1"`)

What the client PUTs as `doc` and what every reader receives (server fields added on read):

```jsonc
{
  "schema": "kp-front.object-visit/1",
  "id": "ov…",
  "object": { "id": "<front object uuid>", "name": "Gemeindeverwaltung", "address": "Hauptstrasse 24",
              "folder": "Hauptstrasse 24 - Gemeindeverwaltung", "refs": [{ "source": "fwo", "id": "…" }] },
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
`error` only while `failed`/`pending`).

Validation (422 with a German `detail`): no string anywhere (keys included) holds a NUL or a lone
surrogate (Postgres cannot store either — same rule on the organizer's object/list bodies and
path ids), schema string, id matches path, object id exists (for a NEW object reference: a visit
whose recorded object was later deleted keeps saving; its link goes to wherever a merge/re-key
moved it, else NULL, and the document keeps the snapshot),
`lifecycle` transitions: `draft→draft|completed|discarded`, `completed→completed` (a correction),
`discarded` is terminal; **no reopen**. Photo/proposal ids unique; ≤ 200 photos, ≤ 100 proposals,
text fields bounded (notes ≤ 20 000 chars, caption ≤ 300). The checklist snapshot may only change
while the visit is a draft.

## Field API — `/api/object-visits` (session; never a link/terminal/poster session)

Reads: any account session (`editor`, `el`, `viewer`) and the admin session.
Writes: account whose role is in `objectVisits.captureRoles` (default `["editor","el"]`).
Module off ⇒ every route 404 `{code: "object_visits_disabled"}` except for the admin session.
Incident-link guest sessions (`LINK_GUEST_ID`: alarm, view, Atemschutz, terminal) ⇒ 403, with or
without `X-Incident-Link: use`; a request carrying only the poster's `X-Capture-Token` ⇒ 403; no
session at all ⇒ 401. The integration bearer key opens nothing here. Tests assert all of it.

Refusals carry a `code` at the top of the body **and** a German `detail`:
`{code, detail, …extra}` — `invalid` / `lifecycle` (422), `forbidden` / `link_session` (403),
`not_found` / `visit_not_found` / `object_visits_disabled` (404), `revision_conflict` /
`attachment_conflict` (409). `by`, `createdBy`, `updatedBy`, `acceptedBy` are always `{id, name}`
(`by` = the visit's creator).

| Route | Answer |
|---|---|
| `GET /catalogue` | `{generatedAt, canCapture, objects:[{id,name,address,lat,lng,folder,refs,hasPlans,lastVisit:{id,visitedAt,lifecycle}\|null}], templates:[visit templates], lists:[{ref,title,note,closesAt,scheduledOn,archived,objectIds:[…],unresolved:[{source,id}],done:{"<objectId>":{at,by?,source?,note?}}}], proposalFields:[{id,label}]}` |
| `GET /?object=&workRef=&mine=1&lifecycle=&limit=` | `[{id,objectId,objectName,workRef,lifecycle,revision,ready,visitedAt,updatedAt,by,with,findings}]` newest first (`with`: the document's people, `[string]`) |
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
| `GET /object-visits/changes?after=<seq>&limit=<≤500>` | `{items:[FeedItem], nextAfter}`; `FeedItem = {seq, id, objectId, objectRefs, objectName, workRef, revision, lifecycle, ready, visitedAt, updatedAt, by, with, findings, proposals:[…], deliveries:[…], url}` — one item per visit at its latest state, ordered by `seq`. `objectRefs` is read LIVE from `object_refs`, so a ref attached later (an object upsert matching by folder) appears on the next poll. `nextAfter` = the last item's `seq`, or `after` when empty |
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
  "proposalFields": [{ "id": "owner_contact", "label": "Kontakt Eigentümer" }],
  "destinations": [{
    "id": "sharepoint-fu", "kind": "sharepoint", "enabled": true,
    "timing": "every-sync",                      // every-sync | completed
    "siteUrl": "https://fwoberwil.sharepoint.com/sites/FWO", "library": "Dokumente",
    "root": "FÜHRUNGSUNTERSTÜTZUNG/Einsatzpläne",
    "objectFolder": "{object.folder}",
    "visitFolder": "Objektbesuche/{date} {checklist} ({short})"
  }]
}
```

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
proposal field ids unique. Nothing in the section is secret — `GET /api/config` is public.

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
- Entry: launcher secondary button «Objektbesuche» (module on + role can capture or read);
  routes `/besuche`, `/besuche/<id>`, `/besuche/neu?object=<source>:<id>|<uuid>&ref=<workRef>`.
  The `neu` launch resumes this device's/user's open draft for `(object, workRef)` before
  minting a new id; nothing is sent until the first save point.
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
