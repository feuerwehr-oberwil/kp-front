import type { Dispatch, SetStateAction } from 'react'
import type { BoardDoc, BuildingDoc, Drawing, Entity, LngLat, TimelineEvent, Trupp, TruppReading } from '../../types'
import type { TacticalObject } from '../tacticalObjects'
import type { WorkspaceMode } from '../../workspace/types'
import type { ObjectStore, SetBoard } from '../useObjectStore'
import type { UndoTimeline } from '../undoTimeline'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../format'
import { isAtemschutzTrupp, type CrewSlot } from '../atemschutz'
import { keepCrewFiled } from '../crewFiling'
import { recordKey } from '../undoKeys'

// The ground every Trupp action family stands on (lib/useTruppActions composes them): what the
// app hands in, the undo door onto the global timeline (`remember` / `logStep`), the double-tap
// memory (`recorded`), and the few pure bits more than one family needs.

export type PlanFocus = { x: number; y: number; floor: number; annoId?: string; flash?: boolean; nonce: number } | null

/** Everything the Trupp actions read and write — handed in whole by IncidentWorkspace; each
 *  family Picks the handful it needs. */
export interface TruppActionDeps {
  trupps: Trupp[]
  /** live Lage drawings — read to find the hose a Trupp was linked to (and which numbers are
   *  already taken on that surface). Written through `setDocRaw`, like the placements. */
  drawings: Drawing[]
  /** live Lage entities — read to see which team colours are already worn (pickTeamColor) */
  entities: Entity[]
  /** THE tactical store — read where the question is «which surface is this object anchored
   *  on», which membership of `entities`/`board` can no longer answer (lib/placedTrupps) */
  objects: TacticalObject[]
  setTrupps: Dispatch<SetStateAction<Trupp[]>>
  /** read-only board (to locate a Trupp's plan chip so «auf Plan zeigen» centres on it) */
  board: BoardDoc
  /** …the store's writers, WITH their `gesture` door: a write the app makes on its own (a chip
   *  settled at a hose end, a hose let go of a crew) passes `gesture: false`, so it never flips an
   *  anchor (lib/useObjectStore) */
  setBoard: SetBoard
  /** raw Lage-doc setter (no undo snapshot — placement mirrors the plan chip's setBoard) */
  setDocRaw: ObjectStore['setDocRaw']
  building: BuildingDoc | null
  /** `rowId` mints the Verlauf row under a CALLER-CHOSEN id instead of a fresh one. Only for
   *  rows a fact can produce more than once — the same Atemschutz-Alarm evaluated on three
   *  tablets is one alarm, and the server skips a row id it already holds (backend ·
   *  journal.append_rows). Everything else leaves it alone and gets a fresh id. */
  log: (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string, opts?: { rowId?: string; subjectId?: string }) => void
  logPlan: (icon: string, text: string, extra?: { kind?: TimelineEvent['kind']; annoId?: string; x?: number; y?: number; floor?: number }) => void
  emit: (op_type: string, payload?: Record<string, unknown>, opts?: { observed?: string }) => void
  setMode: (m: WorkspaceMode) => void
  setActivePlanId: (id: string) => void
  setPanel: (p: 'layers' | null) => void
  setPlanFocus: (f: PlanFocus) => void
  /** current Lage-map centre — where a newly placed team marker lands (user drags it after) */
  mapCenter: () => LngLat
  /** jump to + select a map entity (setMode('map') + select; fly=false skips the camera move) */
  focusMapEntity: (entityId: string, coord?: LngLat, fly?: boolean) => void
  /** jump to + select a Lage DRAWING (the hose a Trupp works on) */
  focusMapDrawing: (drawingId: string) => void
  /** The ONE global undo timeline (`lib/undoTimeline`). Every Tafel mutation records itself
   *  here, so the header's ↶ reaches the Atemschutzüberwachung too – it used to be reachable only
   *  through a toast that expired after six seconds. Optional: a caller without a timeline (the
   *  tests) keeps the old behaviour exactly. */
  undoTimeline?: UndoTimeline
  /** The trupps as they stand NOW, not as the render that recorded the action saw them. An undo
   *  can be tapped minutes later, and by then a merge may have taken the card away – that is the
   *  one case the entry has to decline instead of writing a ghost back. */
  liveTrupps?: () => Trupp[]
  /** Every name the ONE counter reads beyond the Trupps (IncidentWorkspace · truppCounterNames:
   *  every chip once, and every ghost trail — a deleted chip that left a Spur used its number).
   *  Absent: the chips of `entities` and `board` alone, as before. */
  counterNames?: () => (string | undefined)[]
  /** WHERE a placed Trupp stands, in words — «M6 · 2. OG», «Karte · bei Hydrant» (IncidentWorkspace
   *  knows the plans and the map). The Notfall's «letzter Ort» (F1). Absent: the Auftrag/Ziel only. */
  placeOf?: (t: Trupp) => string | undefined
  /** a Trupp's crew as the roster resolves it (lib/personnel · truppSlots) — what a crew edit
   *  that removes ONE person reads, because `memberPersonIds` is stored compacted (see
   *  atemschutz · truppCrewWithout). Absent ⇒ the positional reading. */
  slotsOf?: (t: Trupp) => CrewSlot[] | undefined
}

/**
 * What a placed Trupp is CALLED on the map/plan: the leader's name, in full, as recorded.
 *
 * It used to be abbreviated («Meier A.») to keep the chip small. On a Lage with three Trupps that
 * costs the one thing the marker is there to answer — which of them is this? — and two Meiers in
 * the same Wehr make the short form ambiguous outright. The symbol carries the name; the hose end
 * tag, which sits in the middle of the picture next to a Leitung number, keeps the short form
 * (lib/truppLines · truppTagText).
 */
export const truppLabel = (name: string): string => name.trim()

/** The Auftrag as the card states it — «Retten – 2OG links». `anderes` carries no label of its
 *  own: there the free text IS the order (types.ts · Trupp.ziel), so printing «Anderes» in front
 *  of it would only say that a dropdown was set to the escape hatch. */
export function auftragText(auftrag: Trupp['auftrag'], ziel?: string): string {
  const labels = appConfig.copy.atemschutz.auftragLabels
  const label = auftrag && auftrag !== 'anderes' ? labels[auftrag] ?? auftrag : ''
  return [label, (ziel ?? '').trim()].filter(Boolean).join(' – ')
}

/** …hung onto the row it belongs to, or the row unchanged when there was nothing to say. The ONE
 *  place the separator is chosen, so the journal line and the undo label can never drift apart. */
export const withDetails = (line: string, details: string): string => (details ? `${line} – ${details}` : line)

/**
 * The Trupp's crew, written into its own log (types · TruppReading `crew`) — the row the
 * Rapport reconstructs «who went in on which cycle» from. Appended by registration and by
 * everything that changes the crew afterwards; `bar` is the last value known, never printed.
 */
export const crewRow = (t: Pick<Trupp, 'name' | 'members' | 'lastPressureBar' | 'entryPressureBar'>, at: string): TruppReading => (
  { t: at, bar: t.lastPressureBar ?? t.entryPressureBar, kind: 'crew', crew: { name: t.name, members: t.members ?? [] } })

/**
 * Does this Trupp's Anmeldung/Eintritt have an Eingangsdruck to name?
 *
 * ⚠️ Two ways it does not (04.09., Feldtest — «Trupp … angemeldet – Eingangsdruck 0 bar»): a
 * Trupp OHNE Atemschutz carries no cylinder at all, and an Atemschutz-Trupp whose gauge was not
 * read yet carries 0. Either way the sentence stated a measurement nobody took, in a record that
 * is read as the legal account. The line then simply stops after the crew.
 */
export const hasEntryPressure = (t: { kind?: Trupp['kind'] }, bar: number | undefined): boolean =>
  isAtemschutzTrupp(t) && typeof bar === 'number' && bar > 0

/** a Trupp that is already out keeps whatever it recorded — the takeover only touches the live ones */
export const isOutTrupp = (t: Trupp) => t.status === 'raus' || !!t.exitTime

/**
 * The undo plumbing the families share, plus the one plain writer (`updateTrupp`). Built once per
 * render by useTruppActions and handed to every family, so `recorded` is ONE memory across them.
 */
export function truppActionCore(deps: Pick<TruppActionDeps, 'trupps' | 'setTrupps' | 'log' | 'emit' | 'undoTimeline' | 'liveTrupps'>) {
  const { trupps, setTrupps, log, emit, undoTimeline, liveTrupps } = deps

  /** The Verlauf row + audit event a step owes the record — append-only, so a correction is a NEW
   *  row and never a rewritten one. Icon 'undo' with kind 'team' lands the row under «Atemschutz»
   *  (lib/report · journalArea), which is where the act it corrects is filed.
   *  ⚠️ `atemschutz.undo`, not a bare `undo`: the handed-over Link-Tafel may send `atemschutz.*`
   *  and nothing else, and ONE refused op_type 403s the whole batch and wedges the outbox
   *  (backend · auth/incident_link.py). */
  const logStep = (dir: 'undo' | 'redo', label: string, id: string) => {
    const C = appConfig.copy.log
    log('undo', fillTemplate(dir === 'undo' ? C.undoNamed : C.redoNamed, { action: label }), 'team', undefined, undefined, { subjectId: id })
    emit(`atemschutz.${dir}`, { id })
  }

  /**
   * Put one Trupp mutation on the global timeline, and hand back the way to take it off again.
   *
   * `apply` is the very patch the action just wrote — the SAME function, not a re-derivation — so
   * ↷ reproduces the original result exactly, down to the instant it was stamped.
   *
   * ⚠️ Doctrine, and the reason `apply` is reused rather than the action re-run: a redo must never
   * invent a NEWER Funkkontakt. Re-running «Kontakt» would stamp the clock at the moment of the
   * redo and quietly buy the crew fresh minutes. Undo restores the card as it stood, which can
   * only ever show MORE elapsed time — the safe direction.
   *
   * ⚠️ And the status/clock fields go back as ONE unit (the whole Trupp object), never field by
   * field: `mergeWorkspace` resolves status + entryTime + exitTime together for exactly this
   * reason, and half a state machine can silence the contact clock for a crew that is inside.
   */
  const remember = (id: string, label: string, before: Trupp | undefined, apply: (t: Trupp) => Trupp): (() => void) => {
    if (!before || !undoTimeline) return () => {}
    const present = () => (liveTrupps?.() ?? trupps).some((t) => t.id === id)
    const write = (next: (t: Trupp) => Trupp): boolean => {
      if (!present()) return false // the card is gone (merge, delete-beats-edit) — decline, quietly
      setTrupps((ts) => ts.map((t) => (t.id === id ? next(t) : t)))
      return true
    }
    const step = (dir: 'undo' | 'redo', next: (t: Trupp) => Trupp): boolean => {
      if (!write(next)) return false
      logStep(dir, label, id)
      return true
    }
    return undoTimeline.push({
      domain: 'trupps',
      label,
      // the inverse writes this ONE Trupp, whole (never field by field, see above) — so it is that
      // record a remote merge must leave alone for the step to survive (lib/undoKeys)
      touches: () => [recordKey('trupps', id)],
      // the crew-filing marker is a machine fact, not part of the edit — it stays (crewFiling)
      undo: () => step('undo', (cur) => keepCrewFiled(before, cur)),
      redo: () => step('redo', apply),
    })
  }

  /**
   * What this RENDER has already recorded for a Trupp — the other half of the double-tap guard.
   *
   * ⚠️ The families' state guards («already in that state», «not out») read `trupps` as this
   * render sees it, which is exactly what a second tap sees too when both land in the SAME frame:
   * React has not re-rendered in between, so both taps compare against the pre-tap Trupp and both
   * write (04.09., Manuel's Rapport: «erneuter Eintritt 2×» on Antoine at 16:24). This map is that
   * missing frame. It lives on the actions object, which is rebuilt on every render — so it
   * remembers exactly as long as it is the only thing that can know, and the state guard is
   * authoritative again the moment the board has re-rendered.
   */
  const recorded = new Map<string, string>()

  const updateTrupp = (id: string, patch: Partial<Trupp>) =>
    setTrupps((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  return { logStep, remember, recorded, updateTrupp }
}

export type TruppActionCore = ReturnType<typeof truppActionCore>
