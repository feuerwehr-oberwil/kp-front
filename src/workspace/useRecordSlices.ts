// The record surfaces' undo stacks: Mittel, Checklisten, the Rapport and the Zeitplan each get an
// undoable slice (useUndoableSlice) whose steps join the ONE timeline, the writers that lay those
// steps (one gesture = one step, the Rapport's typing folded), the Schichten / Schichtbänder
// actions and the Zeitplan-PDF — and the re-lay of every slice's stack after a remote merge
// (`sliceRebase`). Split out of IncidentWorkspace (E1, 09.10.2026) verbatim.

import { appConfig } from '../config/appConfig'
import type { AuthUser } from '../lib/auth'
import type { ChecklistState } from '../lib/checklists'
import type { IncidentMeta } from '../lib/incidents'
import { foldsIntoPrevious, keepMachineFields, reportStep as reportStepOf } from '../lib/reportUndo'
import { pushSliceStep } from '../lib/sliceUndoStep'
import { toast } from '../lib/ui'
import type { UndoDomain, UndoTimeline } from '../lib/undoTimeline'
import { useBandActions } from '../lib/useBandActions'
import { useMittelActions } from '../lib/useMittelActions'
import { useShiftActions } from '../lib/useShiftActions'
import { useUndoableSlice, type UndoableSlice } from '../lib/useUndoableSlice'
import type { InitialState, Doc, ReportMeta } from '../lib/workspace'
import { buildZeitplanPayload, downloadZeitplanPdf, type ZeitplanSheet } from '../lib/zeitplanPrint'
import type { MittelEntry, Person, Shift, ShiftBand, TimelineEvent, BoardDoc, AttendanceState, AttendanceEntry } from '../types'
import { CHECKLIST_RECORDS, MITTEL_RECORDS, REPORT_RECORDS, ZEITPLAN_RECORDS } from './recordShapes'
import { useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'

export interface UseRecordSlicesInputs {
  mittel: MittelEntry[]
  setMittel: Dispatch<SetStateAction<MittelEntry[]>>
  canWriteRecord: boolean
  checklists: ChecklistState
  setChecklists: Dispatch<SetStateAction<ChecklistState>>
  undoHist: UndoTimeline
  histSide: RefObject<{ log: (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string, opts?: { rowId?: string; subjectId?: string }) => void; emit: (op_type: string, payload?: Record<string, unknown>, opts?: { observed?: string }) => void }>
  histStep: (moved: boolean, dir: 'undo' | 'redo', label: string, op: string, icon?: string, kind?: TimelineEvent['kind']) => boolean
  C_HIST: import('../config/copy').Copy
  reportMeta: ReportMeta
  setReportMeta: Dispatch<SetStateAction<ReportMeta>>
  lastReportStep: RefObject<{ key: string; at: number } | null>
  reportSetRef: RefObject<(update: SetStateAction<ReportMeta>, opts?: { coalesce?: ((prev: ReportMeta, next: ReportMeta) => boolean) | undefined } | undefined) => boolean>
  user: AuthUser | null
  log: (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string, opts?: { rowId?: string; subjectId?: string }) => void
  doc: Doc
  board: BoardDoc
  shifts: Shift[]
  bands: ShiftBand[]
  setShifts: Dispatch<SetStateAction<Shift[]>>
  setBands: Dispatch<SetStateAction<ShiftBand[]>>
  sliceRebase: RefObject<((next: InitialState, keep: ((step: string) => boolean) | null) => void) | null>
  attHist: UndoableSlice<Record<string, AttendanceEntry>>
  incidentMeta: IncidentMeta
  attendance: AttendanceState
}

export function useRecordSlices({
  mittel, setMittel, canWriteRecord, checklists, setChecklists, undoHist, histSide, histStep, C_HIST,
  reportMeta, setReportMeta, lastReportStep, reportSetRef, user, log, doc, board, shifts, bands,
  setShifts, setBands, sliceRebase, attHist, incidentMeta, attendance,
}: UseRecordSlicesInputs) {
  /**
   * Mittel and Checklisten join the timeline the same way the Anwesenheit does: their slice gets
   * an undo stack (`useUndoableSlice`), every write goes through it, and the entry delegates.
   *
   * ⚠️ Whole-slice snapshots, not reverse patches — the same reason the Anwesenheit takes them.
   * A Mittel save is append-only with tombstones and a Checklisten-Haken carries who ticked it
   * and when, so «put the list back as it stood» is a statement the record can make; «un-tick
   * item 4» is not, once a merge has been through it.
   * ⚠️ `canEditRecord`, like the Anwesenheit: both are record surfaces an `el` may write.
   */
  const mittelHist = useUndoableSlice(mittel, setMittel, !canWriteRecord, undefined, MITTEL_RECORDS)
  const checklistHist = useUndoableSlice(checklists, setChecklists, !canWriteRecord, undefined, CHECKLIST_RECORDS)
  /** One recorded step over a slice somebody else owns. `op` is the domain-scoped audit prefix —
   *  see `logHistStep` for why a bare `undo` would wedge an `el` session's outbox. */
  /*  `describe` lets the domain write the step's rows itself — the Checklisten write «☑ …» /
   *  «Meilenstein zurückgenommen: …» for a milestone, the same row a tap writes — and a `true`
   *  from it replaces the generic «… rückgängig gemacht», so one step is never two rows. */
  /*  ⚠️ The slice's history travels as a REF, read when the step is taken (lib/sliceUndoStep). */
  const rememberSliceStep = <T,>(laid: boolean, domain: UndoDomain, histRef: { readonly current: UndoableSlice<T> }, label: string, op: string, icon: string, onStep?: () => void, describe?: (moved: { from: T; to: T }) => boolean) =>
    pushSliceStep(undoHist, {
      domain, label, laid, histRef, onStep,
      record: (moved, dir) => {
        if (moved && describe?.(moved)) { histSide.current.emit(`${op}${dir}`); return true }
        return histStep(!!moved, dir, label, op, icon, 'journal')
      },
    })
  const mittelSet: typeof mittelHist.set = (u) => { const laid = mittelHist.set(u); rememberSliceStep(laid, 'mittel', mittelHistRef, C_HIST.undoDomains.mittel, 'mittel.', 'box'); return laid }
  const checklistSet: typeof checklistHist.set = (u) => { const laid = checklistHist.set(u); rememberSliceStep(laid, 'checkliste', checklistHistRef, C_HIST.undoDomains.checkliste, 'checklist.', 'check', undefined, (moved) => checklistDescribeRef.current(moved)); return laid }
  // ⚠️ The entry outlives the render that pushed it, and `hist` closes over that render's stacks.
  const mittelHistRef = useRef(mittelHist); mittelHistRef.current = mittelHist
  const checklistHistRef = useRef(checklistHist); checklistHistRef.current = checklistHist
  /** the milestone rows of a Checklisten step (useChecklistActions · describeStep), set below */
  const checklistDescribeRef = useRef<(moved: { from: ChecklistState; to: ChecklistState }) => boolean>(() => false)
  /**
   * …and the Einsatzrapport, the last record surface with no way back (field report 18.09.2026:
   * «Rettungen eingetragen, Zahl war falsch, Rückgängig macht nichts»). Same slice mechanism as
   * Mittel and the Checklisten — but the Rapport is the only surface that persists on every
   * KEYSTROKE, so a checkpoint per write would have filled the whole history with one
   * Kurzbericht and made ↶ hand back a single character. `lib/reportUndo` classifies the write
   * instead: a burst of typing in the same field is ONE step, and a value or a row appearing or
   * disappearing (a Rettung, «Keine», a Partnerorganisation, a cleared Gruppenzeit) is its own.
   *
   * ⚠️ Deliberately NOT a separate pair of buttons on the sheet: the Rapport wears the same
   * TopBar as every other surface, and its ↶ ↷ already drive this one timeline (08.09.2026).
   */
  // ⚠️ the machine's own bookkeeping rides OUTSIDE the snapshots (lib/reportUndo ·
  // keepMachineFields): it lays no step of its own, so it travels inside whatever step stands —
  // and a ↶ must not lose the «Rapport erstellt» mark to an undone sentence.
  const reportHist = useUndoableSlice(reportMeta, setReportMeta, !canWriteRecord, keepMachineFields, REPORT_RECORDS)
  const reportHistRef = useRef(reportHist); reportHistRef.current = reportHist
  const reportSet: typeof reportHist.set = (u) => {
    // ⚠️ A session that may not write the record still writes LOCALLY exactly as it did before
    // this stack existed — it simply lays no step down. Dropping the write here instead would
    // have made undo a silent gate on a path that never had one.
    if (!canWriteRecord) { setReportMeta(u); return false }
    const hist = reportHistRef.current
    const laid = hist.set(u, {
      coalesce: (prev, next) => {
        const step = reportStepOf(prev, next)
        // the app's own bookkeeping (reportMadeAt / krokiPrint) — it rides along with
        // whatever step stands and never becomes one of its own
        if (!step) { lastReportStep.current = null; return true }
        const now = Date.now()
        const fold = foldsIntoPrevious(lastReportStep.current, step, now)
        lastReportStep.current = { key: step.key, at: now }
        return fold
      },
    })
    // ⚠️ …and the fold window closes on every ↶ ↷ (the last argument): the step it would fold
    // into has just moved to the other stack, so typing in the same field right after an undo
    // would lay no step of its own — and the next ↷ would overwrite it.
    rememberSliceStep(laid, 'rapport', reportHistRef, C_HIST.undoDomains.rapport, 'report.', 'clipboard', () => { lastReportStep.current = null })
    return laid
  }
  reportSetRef.current = reportSet
  const { saveMittel } = useMittelActions({ mittel, setMittel: mittelSet, authorName: user?.display_name, log })
  // Symbol→Mittel moved OUT of the symbol's card (28.08.): the Material surface itself now shows
  // the «Gesetzt, aber nicht erfasst» strip, fed with every symbol standing on Lage + all plans.
  // The «has this station mapped anything» gate lives inside mittelRecommendations.
  // ⚠️ Deduped by id: since unified objects `entities` and `board` are two VIEWS of the same
  // records (lib/tacticalObjects · viewsOf), so this union repeats one object once per fitting
  // plan — and a repeated view is not a second symbol standing in the Einsatz.
  const placedSymbols = useMemo(
    () => [...new Map(
      [...doc.entities, ...Object.values(board).flat()]
        .filter((x) => !!x.symbol && !(x as { live?: boolean }).live)
        .map((x) => [x.id, { symbol: x.symbol as string, fields: x.fields, extract: x.extract }] as const),
    ).values()],
    [doc.entities, board],
  )
  /**
   * The Zeitplan joins the timeline as ONE slice, because a Schichtband and the Schichten in it
   * are not two things to an operator: removing a band strips `bandId` off its shifts in the
   * same breath, and two entries for that act would need two ↶ to take back half of what looked
   * like one press. `shifts` + `bands` are therefore snapshotted together.
   *
   * ⚠️ …which is also why one GESTURE is one step: the writers here legitimately touch both
   * lists in the same synchronous handler, so the first write of a burst lays the checkpoint and
   * whatever follows it in the same task folds in. A microtask closes the burst, so nothing is
   * held open across an await (the band-times question asks first and is its own decision).
   *
   * Before this, `addShift`, `setShiftTime`, `addBand`, `renameBand`, `setBandTimes` and every
   * cell tap had no way back at all — the surface's only doors were the four confirm-with-undo
   * toasts, and a toast expires.
   */
  const zeitplanDoc = useMemo(() => ({ shifts, bands }), [shifts, bands])
  const zeitplanHist = useUndoableSlice(zeitplanDoc, (v) => {
    const next = typeof v === 'function' ? v(zeitplanDoc) : v
    setShifts(next.shifts); setBands(next.bands)
  }, !canWriteRecord, undefined, ZEITPLAN_RECORDS)
  const zeitplanHistRef = useRef(zeitplanHist); zeitplanHistRef.current = zeitplanHist
  // A remote merge re-lays every slice's stack onto what it merged (applyWorkspace, far above,
  // which runs before any of these exist — hence the ref). Called AFTER the timeline has decided
  // which entries survive: `keep` is their step ids.
  // `keep` null = the merge bookkeeping failed: every stack goes (undoKeys · carryUndoThroughMerge)
  sliceRebase.current = (next, keep) => {
    if (!keep) { for (const h of [attHist, mittelHist, checklistHist, reportHist, zeitplanHist]) h.clear(); return }
    attHist.rebase(next.attendance, keep)
    mittelHist.rebase(next.mittel, keep)
    checklistHist.rebase(next.checklists, keep)
    reportHist.rebase(next.reportMeta, keep)
    zeitplanHist.rebase({ shifts: next.shifts, bands: next.bands }, keep)
  }
  const zeitplanBurst = useRef(false)
  const zeitplanWrite = (next: (cur: { shifts: Shift[]; bands: ShiftBand[] }) => { shifts: Shift[]; bands: ShiftBand[] }) => {
    const fold = zeitplanBurst.current
    const laid = zeitplanHistRef.current.set(next, { coalesce: () => fold })
    if (!zeitplanBurst.current) {
      zeitplanBurst.current = true
      queueMicrotask(() => { zeitplanBurst.current = false })
    }
    // `shift.` is on the `el` audit allowlist (backend · EL_EVENT_PREFIXES): an Einsatzleiter
    // plans shifts, so their ↶ must not 403 the batch — see logHistStep.
    rememberSliceStep(laid, 'zeitplan', zeitplanHistRef, C_HIST.undoDomains.zeitplan, 'shift.', 'clock')
  }
  const setShiftsUndoable: Dispatch<SetStateAction<Shift[]>> = (u) =>
    zeitplanWrite((cur) => ({ ...cur, shifts: typeof u === 'function' ? u(cur.shifts) : u }))
  const setBandsUndoable: Dispatch<SetStateAction<ShiftBand[]>> = (u) =>
    zeitplanWrite((cur) => ({ ...cur, bands: typeof u === 'function' ? u(cur.bands) : u }))
  // Schichtenplanung — a PLAN over the same Mannschaft; it never writes the attendance record
  const { addShift, addShiftSpan, replaceShift, setShiftTime, removeShift } = useShiftActions({ shifts, setShifts: setShiftsUndoable, startedAt: incidentMeta.started_at })
  // …and the Schichten reading of it: the same shifts, grouped into named windows. Creating a band
  // writes no shift, deleting one deletes no shift — see useBandActions.
  const bandActions = useBandActions({ bands, setBands: setBandsUndoable, shifts, setShifts: setShiftsUndoable })
  // The Zeitplan-Führungsformular on paper: the PDF, printed through the device's own dialog.
  const zeitplanPayload = (rowPeople: Person[], sheet: ZeitplanSheet) => buildZeitplanPayload(
    rowPeople, attendance, shifts,
    { title: incidentMeta.title, address: incidentMeta.address, startedAt: incidentMeta.started_at },
    new Date().toISOString(),
    sheet, bands,
  )
  const onDownloadZeitplan = (rowPeople: Person[], sheet: ZeitplanSheet) => {
    void downloadZeitplanPdf(incidentMeta.id, zeitplanPayload(rowPeople, sheet))
      .catch(() => toast(appConfig.copy.zeitplan.printFailed, { icon: 'warn', tone: 'warn' }))
  }
  return { checklistSet, checklistDescribeRef, bandActions, addShift, addShiftSpan, replaceShift, setShiftTime, removeShift, onDownloadZeitplan, saveMittel, placedSymbols }
}
