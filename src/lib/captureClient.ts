// Station-capture data layer: fetch wrappers for /api/capture/* (poster token) plus the
// PURE workspace mutations the capture view applies. The capture client is deliberately
// not WorkspaceSync — it holds no offline cache and no undo stack; each action re-applies
// onto the freshest server blob and retries once through a 409, so it composes with a
// live KP tablet exactly like a second (slow, narrow) editor.

import type { AttendanceEntry, AttendanceOrt, MittelEntry, TimelineEvent } from '../types'
import type { ReportMeta } from './workspace'
import type { IncidentMeta, Workspace } from './incidents'
import { closePresence, currentIntervalIndex, isPresent, openPresence, setIntervalTime } from './attendanceIntervals'
import { ortOf } from './attendanceOrt'
import { currentLineFor } from './mittel'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from './format'
import { linkSessionHeaders } from './linkMode'

// --- pure mutations -------------------------------------------------------------------

export type CaptureAction =
  | { kind: 'cycleAttendance'; personId: string; name: string; vonIso?: string }
  // At the Einsatzort or still at the Magazin (see lib/attendanceOrt). The POSTER asks instead of
  // assuming: it hangs in the Magazin, which is why it would be tempting to default to
  // «Magazin» — but it is also scanned on the way back in, and a wrong Ort is invisible
  // to the person who caused it. One tap on a surface where a tap is cheap.
  | { kind: 'setAttendanceOrt'; personId: string; name: string; ort: AttendanceOrt }
  | { kind: 'restoreAttendance'; personId: string; entry: AttendanceEntry }
  /** correct ONE presence block's von/bis (`index`, default the current one) — not the derived
   *  checkedInAt/leftAt summary, which is recomputed from the blocks */
  | { kind: 'setTimes'; personId: string; index?: number; from?: string; to?: string }
  /** the free Bemerkung on a person's attendance row («Fahrer TLF», «Einsatzleiter») — the same
   *  per-incident field the Anwesenheit view writes; presence itself stays untouched */
  | { kind: 'setAttendanceNote'; personId: string; note?: string }
  | { kind: 'setMeta'; patch: Partial<ReportMeta> }
  /** `by` is what the tablet fills with the signed-in name. The poster has none — it stopped
   *  asking «Wer erfasst?» (2026-08-15) — so its lines carry no author and say «(QR)» instead. */
  | { kind: 'setMittel'; materialId?: string; label: string; unit: string; sourceId?: string; sourceLabel?: string; menge: number; by?: string }
  /** Rapport-Beilage: a photo that belongs to the report (an Ausweis, a damage close-up). The
   *  bytes are already on the server (captureApi.uploadPhoto) — this only records the row. */
  | { kind: 'addAttachment'; id: string; url: string; caption?: string }
  | { kind: 'removeAttachment'; id: string }

/** Human-readable names for the Rapportangaben the poster can touch — a Verlaufszeile that
 *  says «Rapportangaben geändert» and nothing else is a row nobody can act on. */
const META_FIELD_LABELS: Record<string, string> = {
  einsatzleiter: 'Einsatzleiter', kontaktperson: 'Kontaktperson',
  kontaktpersonTelefon: 'Telefon Kontaktperson', summary: 'Kurzbericht',
  remarks: 'Bemerkungen', lehren: 'Lehren', endedAt: 'Einsatzende', ausgeruecktAt: 'Ausgerückt',
  gerettete: 'Gerettete', rueckmeldungElz: 'Rückmeldung ELZ', partnerContacts: 'Partnerorganisationen',
  gruppen: 'Alarmzeiten', fahrzeuge: 'Fahrzeugzeiten', erfasser: 'Erfasser',
}

/** Which of those are short enough to quote, and which are prose — the tablet's rule, applied
 *  to the subset the poster can reach (lib/report · META_SHORT / META_PROSE). */
const META_SHORT = new Set(['einsatzleiter', 'kontaktperson', 'kontaktpersonTelefon', 'endedAt', 'ausgeruecktAt'])
const META_PROSE = new Set(['summary', 'remarks', 'lehren'])

/**
 * The Verlaufszeile for one capture action — the poster's half of the record.
 *
 * Everything the poster can change is incident RECORD (who was there, what was used, what the
 * rapport says), and all of it used to land in the workspace blob without a single journal row:
 * the same tap on the tablet logged, the same tap on the phone did not. `erfasser` is the one
 * exception — it is bookkeeping about the capture itself, not about the Einsatz.
 *
 * Pure, so the wording is testable without a server. Returns null for an action that records
 * nothing worth a line.
 */
export interface CaptureLogContext {
  /** what the attendance cycle actually DID — only knowable from the resulting entry */
  outcome?: 'station' | 'present' | 'left' | 'cleared'
  /** display name behind a personId, so a row reads «Meier Anna» and not a uuid */
  name?: string
}

export function captureJournalRow(
  action: CaptureAction, nowIso: string, seq = 0, ctx: CaptureLogContext = {},
): TimelineEvent | null {
  const C = appConfig.copy.capture
  const P = appConfig.copy.preflight
  const row = (icon: string, text: string): TimelineEvent => ({
    // `qr` prefix + a caller-supplied counter: two rows in the same millisecond must not share
    // an id, or the server's idempotency skip swallows the second one
    id: `qr${Date.parse(nowIso) || Date.now()}-${seq}`,
    t: hhmm(new Date(nowIso)),
    at: nowIso,
    icon,
    text,
    surface: 'map',
  })
  switch (action.kind) {
    case 'cycleAttendance': {
      // the poster cycles frei → anwesend → gegangen → frei; which one it just did is only
      // knowable from the resulting entry, so the caller hands the outcome in
      const tpl = ctx.outcome === 'cleared' ? C.logAttendanceCleared
        : ctx.outcome === 'left' ? C.logAttendanceLeft
          // the Magazin tick is its own line: «anwesend» for somebody who has not left the
          // building yet is the half-truth this whole feature exists to end
          : ctx.outcome === 'station' ? appConfig.copy.anwesenheit.logOrtStation
            : C.logAttendancePresent
      return row('user', fillTemplate(tpl, { name: action.name }))
    }
    case 'setAttendanceOrt':
      return row('user', fillTemplate(
        action.ort === 'station' ? appConfig.copy.anwesenheit.logOrtStation : appConfig.copy.anwesenheit.logOrtScene,
        { name: action.name },
      ))
    case 'restoreAttendance':
      return row('user', fillTemplate(C.logAttendanceRestored, {
        name: ctx.name ?? action.entry.displayNameSnapshot ?? '',
      }))
    case 'setTimes':
      return row('clock', fillTemplate(C.logTimes, { name: ctx.name ?? action.personId }))
    case 'setAttendanceNote':
      // same event and therefore the same wording as the tablet's Anwesenheit view — a
      // Bemerkung reads identically in the Verlauf no matter which surface wrote it
      return row('user', fillTemplate(appConfig.copy.anwesenheit.logNote, {
        name: ctx.name ?? action.personId, note: action.note ?? '–',
      }))
    case 'setMittel':
      return row('box', fillTemplate(C.logMittel, {
        label: action.label, menge: String(action.menge), unit: action.unit,
      }))
    // ⚠️ 'attach', not 'photo' (23.08.): a Beilage is a Rapport row, while #photo is also what a
    // composer photo entry wears, and that one is «Manuell». One glyph, two Bereiche — invisible
    // on paper (the print has a Bereich column) but fatal on the Verlauf, where the disc is now
    // the whole classification. Rows written before the change keep #photo and `journalArea`
    // keeps reading them as Rapport; the record is append-only.
    case 'addAttachment':
      return row('attach', C.logAttachmentAdd)
    case 'removeAttachment':
      return row('attach', C.logAttachmentRemove)
    case 'setMeta': {
      const keys = Object.keys(action.patch).filter((k) => k !== 'erfasser')
      // «Erfasser» alone is bookkeeping about the capture, not a change to the Einsatz
      if (!keys.length) return null
      // Same rule as the tablet (lib/report · changedReportMetaFields): a short field carries
      // its new value, free text says only that it was written. A row reading «Rapportangaben
      // geändert (QR): Bemerkungen» is one nobody can act on — the poster's whole point is that
      // the person at the magazine records something the command post has not seen.
      const patch = action.patch as Record<string, unknown>
      const fields = keys.map((k) => {
        const label = META_FIELD_LABELS[k] ?? k
        const v = patch[k]
        if (META_PROSE.has(k)) return `${label} ${typeof v === 'string' && v.trim() ? P.metaWritten : P.metaCleared}`
        if (META_SHORT.has(k) && typeof v === 'string' && v.trim()) {
          return fillTemplate(P.metaValue, { label, value: v.trim() })
        }
        return label
      })
      return row('clipboard', fillTemplate(C.logMeta, { fields: fields.join(', ') }))
    }
    default:
      return null
  }
}

/** frei → anwesend → gegangen → frei. «von» defaults to the ALARM time (`vonIso`, the
 *  field-classification's «Vorschlag ab Alarmzeit») — retro capture at the magazine would
 *  otherwise stamp everyone's arrival near the incident END. «bis» stays the tap moment.
 *  Writes presence BLOCKS like the tablet does; the narrow poster sheet deliberately keeps the
 *  three-step cycle, so a return is ticked on the tablet (which has the Zeitplan for it). */
export function cycleAttendance(
  cur: AttendanceEntry | undefined, name: string, nowIso: string, vonIso?: string,
): AttendanceEntry | undefined {
  // frei → MAGAZIN. The poster hangs in the Magazin, so that is where somebody scanning it
  // almost always is — and it is the state the command post needs to see, because a crew at
  // the Magazin is who can still be called forward.
  if (!cur) return { ...openPresence(undefined, vonIso ?? nowIso, name), ort: 'station' }
  if (isPresent(cur)) {
    // …→ VOR ORT. Still one tap, still no dialog: the modal that asked this was one decision
    // too many on a phone held at a door with a glove on (dropped 09.08.).
    if (ortOf(cur) === 'station') return { ...cur, ort: 'scene' }
    return closePresence(cur, nowIso, name) // → gegangen
  }
  return undefined // gegangen → frei (entry removed, same as the app's third tap)
}

/**
 * The attendance writes that picking a NAME in one of the poster's person pickers implies.
 *
 * Whoever takes on a function was there — the same rule the Trupp form follows in the app, so
 * nobody ends up leading an Einsatz they are not on the Personalblatt of. The pickers are
 * free-text Combos handing back a string, so the only safe resolution is an EXACT, unambiguous
 * match on the display name (trimmed, case-insensitive): a typed-in guest (Nachbarwehr,
 * Zivilist) or a name two members share resolves to nobody, and doing NOTHING is the right
 * outcome there, not a failure.
 *
 * Two deliberate silences, because the poster is a phone at the magazine door with no room to
 * argue: somebody already anwesend is not ticked again (that tap would CLOSE their block), and
 * somebody recorded as «gegangen» is left exactly as they are — that departure was a decision,
 * and the tablet is where it gets questioned. `note` lands only on an EMPTY Bemerkung; a
 * hand-written one always outranks a derived one.
 *
 * Pure, so the whole rule is testable without a server. Returns the actions in the order they
 * must run — an empty list means there is nothing to do.
 */
export function attendanceForPickedName(
  name: string,
  roster: CapturePerson[],
  attendance: Record<string, AttendanceEntry>,
  opts: { vonIso?: string; note?: string } = {},
): CaptureAction[] {
  const key = name.trim().toLowerCase()
  if (!key) return []
  const hits = roster.filter((p) => p.display_name.trim().toLowerCase() === key)
  if (hits.length !== 1) return []
  const p = hits[0]
  const cur = attendance[p.id]
  if (cur && !isPresent(cur)) return []
  const actions: CaptureAction[] = []
  if (!cur) actions.push({ kind: 'cycleAttendance', personId: p.id, name: p.display_name, vonIso: opts.vonIso })
  // the entry the cycle just opened carries no Bemerkung either, so «empty» reads the same in
  // both branches: there is nothing hand-written here that a derived remark could overwrite
  if (opts.note && !cur?.note) actions.push({ kind: 'setAttendanceNote', personId: p.id, note: opts.note })
  return actions
}

/**
 * Apply one capture action onto a server workspace blob, touching ONLY the capture
 * domains (attendance / mittel / reportMeta.endedAt) — every other key is passed through
 * untouched, so a concurrent KP tablet's map work survives the PUT.
 */
export function applyAction(ws: Workspace | null, action: CaptureAction, nowIso: string): Workspace {
  const base: Record<string, unknown> = { ...(ws ?? {}) }
  if (action.kind === 'addAttachment' || action.kind === 'removeAttachment') {
    const list = [...((base.attachments as { id: string }[] | undefined) ?? [])]
    base.attachments = action.kind === 'removeAttachment'
      ? list.filter((a) => a.id !== action.id)
      // append-then-dedupe by id: a retried save (409 → re-read → re-apply) must not add twice
      : [...list.filter((a) => a.id !== action.id), { id: action.id, url: action.url, caption: action.caption, at: nowIso }]
    return base
  }
  if (action.kind === 'cycleAttendance') {
    const attendance = { ...((base.attendance as Record<string, AttendanceEntry> | undefined) ?? {}) }
    const next = cycleAttendance(attendance[action.personId], action.name, nowIso, action.vonIso)
    if (next) attendance[action.personId] = next
    else delete attendance[action.personId]
    base.attendance = attendance
    return base
  }
  if (action.kind === 'setAttendanceOrt') {
    const attendance = { ...((base.attendance as Record<string, AttendanceEntry> | undefined) ?? {}) }
    // only ever on an entry that exists: the poster asks straight after the tick that created
    // one, but a retried save may land after somebody cycled that person back to «frei»
    const cur = attendance[action.personId]
    if (cur) attendance[action.personId] = { ...cur, ort: action.ort }
    base.attendance = attendance
    return base
  }
  if (action.kind === 'restoreAttendance') {
    // undo of the destructive third tap: put the removed entry (incl. its times) back verbatim
    const attendance = { ...((base.attendance as Record<string, AttendanceEntry> | undefined) ?? {}) }
    attendance[action.personId] = action.entry
    base.attendance = attendance
    return base
  }
  if (action.kind === 'setAttendanceNote') {
    const attendance = { ...((base.attendance as Record<string, AttendanceEntry> | undefined) ?? {}) }
    const cur = attendance[action.personId]
    if (!cur) return base // a Bemerkung annotates an existing entry, it never creates one
    attendance[action.personId] = { ...cur, note: action.note?.trim() || undefined }
    base.attendance = attendance
    return base
  }
  if (action.kind === 'setTimes') {
    const attendance = { ...((base.attendance as Record<string, AttendanceEntry> | undefined) ?? {}) }
    const cur = attendance[action.personId]
    if (!cur) return base // times only refine an existing entry, never create one
    const index = action.index ?? currentIntervalIndex(cur)
    attendance[action.personId] = setIntervalTime(cur, index, {
      ...(action.from !== undefined ? { from: action.from } : {}),
      ...(action.to !== undefined ? { to: action.to } : {}),
    })
    base.attendance = attendance
    return base
  }
  if (action.kind === 'setMeta') {
    base.reportMeta = { ...((base.reportMeta as Record<string, unknown> | undefined) ?? {}), ...action.patch }
    return base
  }
  // setMittel: append-only running total, no-op when unchanged (mirrors App.saveMittel)
  const mittel = [...((base.mittel as MittelEntry[] | undefined) ?? [])]
  const menge = Math.max(0, Math.round(action.menge))
  const probe = { materialId: action.materialId, label: action.label, unit: action.unit, sourceId: action.sourceId, sourceLabel: action.sourceLabel }
  const cur = currentLineFor(mittel, probe)
  if ((cur?.menge ?? 0) === menge) return base
  mittel.push({ id: `m${Date.parse(nowIso)}-${mittel.length}`, ...probe, menge, status: cur?.status, at: nowIso, by: action.by })
  base.mittel = mittel
  return base
}

// --- fetch layer (poster token in a header; the URL path carries it only for entry) -----

/**
 * Which incident the capture view opens without asking. The list now carries the whole
 * unreported backlog (any age), so "exactly one listed" is no longer the same as "the one
 * we just came back from": auto-open the single FRESH incident (started within the default
 * capture window) even when stale backlog rows sit below it. A lone backlog incident still
 * opens directly — with one row the picker adds nothing. Ties/ambiguity → show the list.
 */
export const CAPTURE_FRESH_MS = 12 * 60 * 60 * 1000 // mirrors alarms.captureWindowHours default
export function autoOpenTarget(incidents: IncidentMeta[], nowMs: number): IncidentMeta | null {
  if (incidents.length === 1) return incidents[0]
  const fresh = incidents.filter((i) => nowMs - Date.parse(i.started_at) < CAPTURE_FRESH_MS)
  return fresh.length === 1 ? fresh[0] : null
}

export class CaptureError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** true when the failure is transport-shaped (no connection / aborted / stalled request)
 *  rather than a server verdict — those route into the offline banner, not the generic error */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof CaptureError) return false
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) return true
  return e instanceof TypeError // fetch's network-error shape
}

/** race a promise against a timeout — for the PDF/print paths whose fetch lives in shared
 *  libs; a stalled request must never leave the capture form permanently disabled */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DOMException('timeout', 'TimeoutError')), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e as Error) },
    )
  })
}

// clock-skew watch: /api/capture/* responses may carry X-Server-Time (ISO-8601 UTC) — the
// view registers a listener and warns when the device clock drifts. Absent header → silent.
let serverTimeListener: ((iso: string) => void) | null = null
export function onServerTime(fn: ((iso: string) => void) | null): void { serverTimeListener = fn }

const REQ_TIMEOUT_MS = 15_000

async function req<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  // hard abort after ~15s: a stalled request fails into the retry banner instead of
  // hanging the form on a phone with one bar of signal
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS)
  try {
    // Not the api client: the poster token is this surface's whole identity and a 15 s abort
    // clock its own. It is still an /api call, so the session-mode header rides first — the
    // poster page is never a link page, and must not be read as one (api · rawFetch).
    const r = await fetch(`/api/capture${path}`, {
      ...init,
      signal: ctl.signal,
      headers: {
        ...linkSessionHeaders(),
        'Content-Type': 'application/json',
        'X-Capture-Token': token,
        ...(init?.headers ?? {}),
      },
    })
    const serverTime = r.headers.get('X-Server-Time')
    if (serverTime) serverTimeListener?.(serverTime)
    if (!r.ok) {
      let detail = ''
      try { detail = (await r.json())?.detail ?? '' } catch { /* non-JSON error body */ }
      throw new CaptureError(r.status, typeof detail === 'string' ? detail : '')
    }
    return (await r.json()) as T
  } finally { clearTimeout(timer) }
}

export interface CapturePerson { id: string; display_name: string; rank?: string | null }

export const captureApi = {
  incidents: (token: string) => req<IncidentMeta[]>(token, '/incidents'),
  roster: (token: string) => req<CapturePerson[]>(token, '/roster'),
  /** cross-visibility poll: has the KP tablet opened this incident (latched — once true,
   *  stays true, so the caller stops polling) */
  status: (token: string, id: string) => req<{ kp_active: boolean }>(token, `/incidents/${id}/status`),
  workspace: (token: string, id: string) =>
    req<{ workspace: Workspace | null; workspace_rev: number }>(token, `/incidents/${id}/workspace`),
  putWorkspace: (token: string, id: string, workspace: Workspace, base_rev: number) =>
    req<{ workspace: Workspace | null; workspace_rev: number }>(token, `/incidents/${id}/workspace`, {
      method: 'PUT', body: JSON.stringify({ workspace, base_rev }),
    }),
  verify: (token: string, id: string) =>
    req<{ intact: boolean; broken_at_seq: number | null; count: number; head?: string }>(token, `/incidents/${id}/verify`),
  journal: (token: string, id: string) =>
    req<{ entries: { seq: number; row: TimelineEvent }[]; latest_seq: number }>(token, `/incidents/${id}/journal`),
  /** Upload one Beilage photo. Multipart, so it bypasses `req`'s JSON envelope; the capture
   *  token still rides the same header, and the server keeps it to photos of ONE incident. */
  uploadPhoto: async (token: string, id: string, blob: Blob, filename: string) => {
    const form = new FormData()
    form.append('file', blob, filename)
    const res = await withTimeout(fetch(`/api/capture/incidents/${id}/media`, {
      method: 'POST', headers: { ...linkSessionHeaders(), 'X-Capture-Token': token }, body: form,
    }), 60_000)
    if (!res.ok) throw new CaptureError(res.status, `HTTP ${res.status}`)
    return (await res.json()) as { id: string; url: string }
  },
  appendJournal: (token: string, id: string, rows: TimelineEvent[]) =>
    req<{ latest_seq: number }>(token, `/incidents/${id}/journal`, {
      method: 'POST', body: JSON.stringify({ entries: rows }),
    }),
}

/**
 * Apply an action with fresh-read + one 409 retry: GET the blob, apply the pure mutation,
 * PUT; if a concurrent save won the race, re-read and re-apply once. Returns the saved blob.
 */
export async function saveAction(
  token: string, incidentId: string, action: CaptureAction,
): Promise<{ workspace: Workspace; rev: number }> {
  let attempt = 0
  for (;;) {
    const { workspace, workspace_rev } = await captureApi.workspace(token, incidentId)
    const nowIso = new Date().toISOString()
    const next = applyAction(workspace, action, nowIso)
    try {
      const saved = await captureApi.putWorkspace(token, incidentId, next, workspace_rev)
      const ws = saved.workspace ?? next
      void logCaptureAction(token, incidentId, action, nowIso, workspace, ws)
      return { workspace: ws, rev: saved.workspace_rev }
    } catch (e) {
      if (e instanceof CaptureError && e.status === 409 && attempt < 2) { attempt += 1; continue }
      throw e
    }
  }
}

/** monotonic within a session, so two rows in the same millisecond get distinct ids */
let captureRowSeq = 0

/**
 * Write the Verlaufszeile for a capture action — AFTER the workspace write has been accepted.
 *
 * Best-effort on purpose: the state change has already landed, and the poster is a phone at
 * the magazine door with the connectivity that implies. Failing the operator's tap because the
 * journal row could not be sent would be the worse trade — but a dropped row is a hole in the
 * record, so it is logged loudly enough to be noticed in the console.
 */
async function logCaptureAction(
  token: string, incidentId: string, action: CaptureAction,
  nowIso: string, before: Workspace | null, after: Workspace,
): Promise<void> {
  const att = (ws: Workspace | null, id: string) =>
    ((ws as { attendance?: Record<string, AttendanceEntry> } | null)?.attendance ?? {})[id]
  const ctx: CaptureLogContext = {}
  if (action.kind === 'cycleAttendance') {
    const now = att(after, action.personId)
    ctx.outcome = !now ? 'cleared' : !isPresent(now) ? 'left' : ortOf(now) === 'station' ? 'station' : 'present'
  }
  if (action.kind === 'setTimes' || action.kind === 'restoreAttendance' || action.kind === 'setAttendanceNote') {
    ctx.name = att(after, action.personId)?.displayNameSnapshot ?? att(before, action.personId)?.displayNameSnapshot
  }
  const row = captureJournalRow(action, nowIso, captureRowSeq++, ctx)
  if (!row) return
  try {
    await captureApi.appendJournal(token, incidentId, [row])
  } catch (e) {
    console.error('Verlaufszeile der Erfassung konnte nicht gespeichert werden:', row.text, e)
  }
}
