# What lands in the Verlauf – and what doesn't

The **Verlauf** is the human-readable incident chronicle. It is *not* a log of every operator
action, and that is deliberate: a journal that records every nudge of a symbol is one in which
you can no longer find the Funkspruch.

This page pins down **which action lands where**, so nobody relies on something being in the
Verlauf that was never written there. As of 2026-08-24.

## There are two records, not one

| | Verlauf | Audit/replay stream |
|---|---|---|
| Written by | `log()` / `logPlan()` → `journal.append` | `emit(op, payload)` (`src/lib/useAuditEvents.ts:36`) |
| Lands in | `POST /api/incidents/{id}/journal` | `POST /api/incidents/{id}/events` |
| Form | plain-text rows, append-only | machine-readable, **hash-chained** |
| Visible | in the Verlauf, on the printed Rapport | only in replay / review |

`backend/app/models.py:523-532` says it itself: the audit stream is *"the hash-chained AUDIT
record of committed domain actions"*, the journal store *"the operational journal store"*.

**Important:** `emit()` creates **no** Verlauf row. Everything listed below as *audit only* is
legally on the record, but invisible to anyone reading the Verlauf.

On top of that there is a third, small source: the server writes lifecycle rows itself
(`append_system_row`, `backend/app/api/journal.py:96`) – incident closed, reopened,
Nachalarm, automatic archival.

## Atemschutz: the full cycle is on the record

A newly registered Trupp creates a Verlauf row – «Trupp {name} angemeldet»
(`useTruppActions.ts` · `logRegister`). Whoever thinks it's missing is usually just not looking
at the Verlauf while registering: Atemschutz is its own view.

**Closed since 2026-08-17** (this used to be listed here as a gap): deleting (`logRemoved`),
restoring (`logRestored`) and the Trupp color change (`logColor`) write their row.
A deleted Trupp is only soft-removed anyway (`removedAt`) and keeps printing on the
Rapport as «Von Tafel entfernt».

Everything else on the Atemschutz board is in the Verlauf: placing, radio contact, pressure
report, status change, editing, returning, linking/unlinking a Leitung, alarm escalation.

⚠️ **Two contact kinds have been kinds of their own since 2026-08-19**, no longer «Kontakt»: the
**exit** («Ausgerückt») and the **re-entry** after a Rückzug. The safety clock is untouched by
this – a re-entry resets it just like a contact does – but the printed Atemschutz journal now
reads as a chronology instead of breaking off mid-deployment.

⚠️ **The alarm is written once per cycle**, not per tick. An overdue contact clock used to write
the same row every few seconds; the next one is only due after a radio contact that has reset
the clock. Sound and system notification deliberately do **not** hang off it.

## Deliberately silent

| Area | Why |
|---|---|
| Zeitplan / shifts | `src/lib/useShiftActions.ts:16-19`: *«attendance is a RECORD … a plan is not, and logging each nudge of a chip would bury the operational journal under bookkeeping»* |
| Checklists | only milestones create a row (`src/lib/useChecklistActions.ts:34`) |
| Editing drawings (color, style, geometry) | operator action, not an event – see the doctrine note below |

The doctrine lives in the AdFU workflow description: *«Der Verlauf ist keine automatische
Einsatzchronik … Der AdFU sollte nicht jede Bedienhandlung protokollieren.»*

## The Meldeleiste (23.08.) writes nothing of its own

The Meldeleiste – the single message strip under the top bar that replaced the nine banners –
is a **display, not a record**: that a message appeared or was swiped away is written nowhere.
What is *done* on it runs through the same handlers as everywhere else and therefore writes
the same rows:

- **«Erledigt»** on a due Wiedervorlage (follow-up reminder) appends the done row
  (`useReminders.ts` · `doneLog`), **«+10 min»** the postpone row – exactly the rows the
  check-off ring in the Verlauf writes. One obligation per row: since 23.08. **every** due
  Wiedervorlage has its own row on the strip («2 Erinnerungen fällig» named two and
  completed one).
- The **Atemschutz alarm row** reads the same fold that plays the sound and writes nothing
  new – the alarm's Verlauf row is created once per cycle as before (see above).
- **Swiping away (✕), take-over navigation, «Zum Trupp»** write nothing – view, not
  content. Taking over an alarm itself writes through its existing path.

## Drawings: creating, naming and deleting are on the record – arranging is not

The review of 21.08. noted that the word **«Fläche»** did not appear on this page. The finding
was a gap in the *docs*, not in the Verlauf – this is what the truth looks like
(`src/lib/useMapDrawing.ts`, copy keys in `config/copy/de.ts` · `log`):

- **Creating writes:** «Fläche gezeichnet» (`areaDrawn`), «Zeichnung erstellt»
  (`drawingCreated`, lines/freehand), cordon circle (`circleDrawn`). On the Plan: «Fläche auf
  Plan gezeichnet» / «Linie auf Plan gezeichnet» (`Whiteboard.tsx`) – **since 23.08. with
  annotation, point and floor**, so that the jump from the row selects the object instead of
  merely opening the building. Older rows stay without coordinates (append-only) and keep
  opening only the Plan, as before.
- **Naming writes one row** – «Fläche «Sammelplatz»» (`drawingLabelSet` /
  `drawingLabelCleared`), on leaving the field, not per keystroke: the name is the one edit
  that says what the shape *is*, and it used to reach the document silently.
- **Deleting writes** «Zeichnung entfernt» / «{n} Objekte entfernt».
- **Arranging does not write:** color, style, geometry, vertices are operator actions and
  land only in the audit stream (`draw.edit`) – that's the deliberate silence from the table
  above, and it applies to the Fläche just like to every other drawing.

Why a real log can still show 0 «Fläche» hits: on the Lage people draw mostly with lines and
symbols – the row appears the moment somebody drags out a Fläche.

## What a Verlauf row can carry since 17.08.

The row is no longer just text and a timestamp. Four properties have been added, and all four
are **properties of an entry**, not row kinds of their own – which is why they fit existing
incidents without a migration:

| Property | What it means | Where it shows |
|---|---|---|
| **Pendenz** (open ring) | the row is not done; its own thread of **Meldungen** | at the top of the Verlauf, urgent first; on the Rapport as «Aufträge / Pendenzen» with «offen» |
| **Fälligkeit** (reminder) | Wiedervorlage with **day** and time; a moment in the past is rejected | clock in the meta row; on the Rapport «fällig HH:MM» |
| **Korrektur** | a typed row was rewritten; both wordings stay in the record and in the hash chain | «korrigiert HH:MM»; on the Rapport additionally «ursprünglich: ‹…›» |
| **Transcript sections** | the words of a voice memo, each with an offset into the recording | subtitle lines under the row, same on paper |

⚠️ **Only what a human typed is correctable** – composer entries, Meldungen,
Nachdokumentation. **Never** what the app wrote about an action: «Trupp 2 eingerückt»
is the record of an event, and rewriting that sentence would mean letting the journal claim an
action that never happened that way. The entry kind alone cannot tell the two apart (a
checklist tick is a row too), the icon has to weigh in.

⚠️ **A Pendenz hangs off the lifecycle event, never off `entryType: 'auftrag'`.** Bound to the
field, every Auftrag row ever written – running incidents and archive alike – would have
become a forever-open Pendenz nobody can check off.

⚠️ **Repetitions are collapsed on READ**, not on write (`lib/verlauf` ·
`repeatRuns`): the first row appears with a «6×» marker, all repetitions stay in the
append-only record. **Hand-written rows are never collapsed** – whoever types the same thing
twice meant it twice.

**Since 23.08. the chip in front of the row is gone** – the row is a grid of
time · disc · sentence · trailing footnotes. The 26px disc carries the **section the printed
Rapport names** (Anwesenheit, Mittel, Atemschutz, Auftrag …; the mapping itself arrived
on 19.08.), and becomes the check-off ring on a Pendenz; Nachtrag, «korrigiert» and «6×» sit as
footnotes after the sentence instead of before it. ⚠️ **Only what is drawn changed** – what is
written, printed and hashed did not: the row renders `e.text` byte for byte, and old rows with
old icons keep being classified by the existing rules exactly as before (both nailed down by
tests, `Journal.test.tsx`).

## Closed (2026-08-07)

- **The Erfassung writes to the Verlauf.** Every poster mutation runs through `saveAction`
  (`src/lib/captureClient.ts`), which appends a row after the accepted workspace write –
  with «(QR)», because the legal document has to state that no signed-in person is behind it.
  Best effort: the state is already saved, and a poster is a phone at the station door – a
  failed journal write must not make the tap fail, but it is logged loudly.
- **Rapport details and partner organisations write a row** – one per save, naming
  *which* fields changed (`changedReportMetaFields`, `src/lib/report.ts`).
- **The Atemschutz safety values write a row, with old and new value**
  (`changedSafetySettings`, `src/lib/workspace.ts`). Contact interval and grace period decide
  when a Trupp counts as due and as overdue – whoever moves one of them mid-incident moves
  every clock on the Atemschutz board at once. «Geändert» alone would not say whether the
  threshold got stricter or looser.

## Closed since then (2026-08-17 to 2026-08-19)

Three of the six gaps below are closed. They are named here so nobody reopens them from an old
version of this file:

- **Removing an attendance block** writes its row (`useAttendanceActions.ts` ·
  `abschluss.attendanceRemoved`). On top of that, **attendance as a whole is now undoable**,
  with its own stack and a correction row in the Verlauf that names who was moved.
  ⚠️ That row carries the icon `people`, **not** `undo`: the section is derived from the icon,
  and `undo` is also the icon of the Atemschutz-Rückzug – so the row used to print under
  «Atemschutz». Older rows are retroactively classified correctly via the copy template.
- **Naming a drawing** writes **one** row instead of one per keystroke. The field patches
  silently while typing (one undo step for the whole edit) and writes, on leaving or with
  Enter, what the label *is* – instead of narrating the way there.
- **The remark of a partner organisation** reaches the Verlauf and thus the printed
  Journal. It used to go only into the Rapport field. **Deleting** a remark now says so too.

**Partially closed:** corrections to the alarm time, address, Stichwort (dispatch keyword) and
priority create an audit event (`meta.change`, `_TRACKED_META` in `backend/app/api/incidents.py`) –
but still **no Verlauf row**. Whoever reads the Verlauf does not see the correction.

## Gaps – known, not yet closed

These are **not** covered by the doctrine: they concern the content of the record itself,
not operator actions. Ordered by operational impact.

1. **Corrections to the incident data** are in the audit, not in the Verlauf (see above).
   `started_at` is a field of the legal document and even carries its own
   `started_at_source = "manual"` – but nobody can look the change itself up in the Verlauf.
2. **Changing the line number of a drawn hose line** – audit only (`useTruppActions.ts` ·
   `atemschutz.line.renumber`). This number is what maps which Trupp works on which
   Leitung – so the mapping can be shifted silently. ⚠️ Since 19.08. a renumber pulls the
   number onto the Trupp (**via the anchor, never via the number**), so the mapping *is*
   correct – but the shift is still recorded only machine-readably.
3. **Deleting a single Plan annotation** – audit only (`src/components/useBoardDoc.ts` ·
   `removeAnno`), while group deletion writes a row (`Whiteboard.tsx`).
4. **Rapport attachments** – adding/removing audit only, the image caption not at all
   (`src/IncidentWorkspace.tsx`, Rapport attachments block).
5. **Driver of a GPS vehicle** and **creating a building/floor** have no channel.

*(The file paths deliberately carry no line numbers: this file has gone stale twice because
`IncidentWorkspace.tsx` moved, not because the behavior changed.)*

## If you add something

- An action that changes the **content of the record** belongs in the Verlauf.
  An action that only changes the **view** belongs at most in the audit stream.
- Deleting and creating belong in the same channel. The asymmetry is what makes people
  believe nothing is recorded at all.
- The Verlauf is append-only: a correction is a new row, never an edited one.
