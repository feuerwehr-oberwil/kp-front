# Sync, offline and the closed Einsatz

Rules for the sync engine, the outboxes and the record that span modules. The short model
(IndexedDB, «Saved», merge by id, ids, append-only) is in [`AGENTS.md`](../AGENTS.md); the
per-module rules sit at the top of the module they concern (`lib/connectivity`, `lib/eventScope`,
`lib/jsonEqual`, `lib/mergeWorkspace`, `lib/api/workspaceSync`, `lib/serverClock`, …). Moved here
from AGENTS.md on 2026-10-08, wording unchanged.

## Review regression contracts (02.10.2026)

- Journal lifecycle boundaries and the `sys` id namespace belong to the server. Neither a
  client row nor a patch targeting a system row may create, retract or edit them; the client
  alarm clock ignores ordinary journal rows carrying lifecycle-looking metadata.
- A failed conflict PUT still hands the merged union to the live view before another edit.
  Re-sending parked workspace saves first commits their replacement cache entry, with transfer
  markers for crash-safe retry, before clearing the parked originals.
- Blob data never falls back to JSON storage. Failed local media persistence retains bytes in
  memory and reports storage failure. Pending uploads retry with a bounded delay; exhausted
  uploads wait for explicit retry. Rendering the queue must never trigger an upload loop.

## A closed Einsatz

⚠️ **A closed Einsatz keeps its RECORD, not its operation, and every device hears the close**
(25.09.2026, staging N3: two devices ran a closed Einsatz for minutes and wrote a Kontakt and
two «Überfällig» rows into it). Server (`api/incidents · incident_closed`): once `is_open` is
false, a live write MADE AFTER THE CLOSE is 409 `{code: 'incident_closed', closed_at}` — judged
by when it happened (rows `at`, events `occurred_at`, saves `edited_at`, all on the
server-aligned clock, +120 s tolerance; no stamp ⇒ by arrival), never by when it arrived: a
Kontakt from before the close is a true fact and prints as a Nachtrag. Live = events outside
the record vocabulary (`EL_EVENT_PREFIXES`), Verlauf rows of kind `team`/`symbol`/`layer`/
`vehicle` without a `conflict` payload, the trupps slice, and a full save that changes a key
outside `RECORD_WORKSPACE_KEYS` and `VIEW_WORKSPACE_KEYS` (the revision check runs FIRST, and an
entry the server already holds is the idempotent success, not a refusal). The record slice,
record events, Meldungen/patch rows, `PATCH`, media and «Wieder öffnen» are untouched. Every
workspace read — the 304 too — carries `X-Incident-Open`/`X-Incident-Closed-At`; a lifecycle
`PATCH` and the auto-archive sweep wake the parked followers, and a poll carrying `open=` that
no longer matches is answered at once. Client (`lib/incidentClosed`): the poll header, a
refusal and the list watch (a suspicion, verified) all `reportIncidentClosed`; App flips the
meta IN PLACE (`closedMetaFor`, never for the Einsatz this device is closing, never a jump
elsewhere), and `IncidentWorkspace` derives `readOnly` from `isIncidentRunning` live, so the
alarm, the GPS pass, the presence log, the weather stamp and the Wiedervorlagen stop, with one
Meldeleiste row («… auf einem anderen Gerät abgeschlossen (hh:mm)»). The closing device drains
its Verlauf and audit outboxes before the archive `PATCH`. The outboxes keep DELIVERING on a
closed view (`outboxReadOnly`), and a refused write is parked — journal `refused`, audit
`closed` (apart from the role bucket `refused`), the workspace's `::__refused__` slots, whose
record part is re-saved at once through the record route and whose ancestor goes straight
back on screen. Parked entries are exported by «Einträge sichern», keep the lamp amber until
then, and are SENT again once the Einsatz runs again. A plain 409 on the workspace is still
the revision conflict: test the code first. «Wieder öffnen» elsewhere comes back the same way
(`X-Incident-Open: 1`, the same wake, the list watch, `reopenedMetaFor`) on EVERY device that
shows the Einsatz closed, however it came to (a close signal, its own close, «Alle Einsätze» —
forceReadOnly goes too), with its own row naming the reopen row's time. The live poll claims
`open=` from the server's last `X-Incident-Open`, never only from the view, and a held poll that
answers at once with nothing new eases off — a closed view must never spin (it did, 3.4/s). «Anhängen» is never offered onto a closed Einsatz.
**«Wieder öffnen» needs the server — there is no offline reopen** (05.10.2026, asked for after an
Übung in airplane mode). The reopen boundary row is server-owned (`sys` namespace, review
contract above), the Atemschutz alarm HOLDS until it has arrived (`reopenPending`), and the
crews' restart rows derive their ids from it — so an Einsatz reopened offline would run its
Tafel with no Überfällig alarm for as long as the device stays offline. Offline the doors stay
(useOnline is a hint) but say so: «Braucht Verbindung zum Server» under the chip's row, one
line over «Alle Einsätze», and an unreachable server answers with `reactivateNeedsServer`, not
a raw network error. An offline reopen would need a client-stamped reopen time and a
precondition on the close it saw (`last_closed_at`, so a later close elsewhere wins), a local
provisional boundary for the alarm, the reopen sent BEFORE any outbox on reconnect, and closed
signals for that Einsatz ignored until then — a design, not a patch.
After the close the RAPPORT stays editable (`canEditRapport`, one line at its top: «Änderungen
… erscheinen als Nachträge»); the Tafel, Karte, Anwesenheit/Mittel/Checklisten stay read-only
until «Wieder öffnen». Every row the server accepts on a closed Einsatz is stamped
`receivedAfterClose` and prints as a Nachtrag whatever its time — except a row the Abschluss
itself wrote between the confirm and the close (`atClose`, set by `useAbschluss · markClosing`;
honoured up to 120 s past the close, `verlauf · isNachtrag`). A reopen clears
`report_done_at` (a running Einsatz is not «Rapport fertig»), keeps `closed_at` (the first
Einsatzende, which marks the Nachträge — so the Einsatzuhr ignores it while the Einsatz runs),
and writes its boundary row with `lifecycle: 'reopened'`; every crew still inside restarts its
contact clock at that row's `at`, one `azro-<row>-<Trupp>` row each, and the alarm holds until
the row has arrived (`lib/reopenClocks`); the alarm that restart ends names the reopen
(`contactRestartedAt`), never a Funkkontakt — read off the Trupp the alarm engine EVALUATED
(`logAlarmCleared(id, turnus, seen)`), not the parent's state, which gets the restart one effect
later, so every tablet writes the same reason under the one derived id — and the pressure estimate skips the closed
interval (`pausedFrom` → `contactRestartedAt`, `atemschutz · estimatePressure`). The Atemschutz-Link of a closed Einsatz says «diese
Tafel zeigt nur noch an» and follows once a minute (`pollBackoff · minDelayMs`): a link
session on a closed Einsatz is answered 409 `incident_closed` + `X-Incident-Open: 0` on the
Einsatz's own routes (before any key check — every close, the second too), and a link page
refused 403 on its workspace/Verlauf/events freezes read-only (`api · LINK_REFUSED_EVENT`). A
per-Einsatz Atemschutz link RELOADED while closed gets the same 409 from the exchange (no cookie;
the alarm link's (src, ref) exchange keeps its one 404) and shows «Einsatz abgeschlossen», asking
again once a minute so a reopen opens the board by itself (`link/LinkApp · ClosedCard`). The
link KEY is not revoked by a close, on purpose: the QR panel shows it standing and a reopen
revives it. `closed_at` is the FIRST close (Nachträge only); `last_closed_at` is stamped on
every close and is the Einsatzende the clock, the Rapport and the Anwesenheit ends default to
(`api/incidents · closeTimeOf`); the PDF prints the Nachtrag mark under the row's time. A
closed Tafel alarms nothing (no badge, no red; «Stand beim Abschluss»), the lifecycle row
expires after two minutes and never covers the Rapport.

## Observed facts get derived ids

- ⚠️ **What every device OBSERVES is recorded under a DERIVED id, once** (24.09.2026). One
  login is routinely open on three devices, and each runs the same engines — the Atemschutz
  alarm clock (the one observation still on the devices: it is about the device's own Tafel,
  not the outside world). A row or event such an engine writes must carry an id every device
  computes identically from the fact itself, so the server's idempotency keeps one: Verlauf
  rows `azal-`/`azcl-<trupp>-<turnus>` (alarm), and the audit event beside an observed row
  `observedEventId(rowId, actor)` with a payload free of anything device-local. The server's
  own observers derive theirs the same way (`vps-<n>-<zone>-gps-<device>`, `wx:<incident>:<observed_at>`,
  `wxd-<observed_at>`), so a restart or a second worker converges.
  Audit ids are ACTOR-scoped (the server binds a `client_id` to its author; two accounts each
  observed it). The server treats a same-id, same-author, same-op, same-payload event with a
  different `occurred_at` as the duplicate (the first observation's time is kept) — a
  different payload under one id stays a 409. A hand-performed act keeps a fresh `newId`.
