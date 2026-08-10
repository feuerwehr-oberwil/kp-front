import type { Dispatch, SetStateAction } from 'react'
import type { BoardAnno, BoardDoc, BuildingDoc, Drawing, Entity, LngLat, TimelineEvent, Trupp, TruppFields } from '../types'
import type { Doc } from './workspace'
import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from './format'
import { toast } from './ui'
import { gebaeudeDoc } from '../data/demoIncident'
import { pickTeamColor } from './teamColors'
import { atemschutzAuftragColors, atemschutzDoctrine } from './deploymentConfig'
import { resolveLinkNumber, truppForLine, type LinkableLine } from './truppLines'

type Mode = 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel' | 'rapport'
type PlanFocus = { x: number; y: number; floor: number; annoId?: string; flash?: boolean; nonce: number } | null

/** placement-target id for the Lage map in the «Wohin platzieren?» picker (vs. a plan id) */
export const LAGE_TARGET = 'lage'

/**
 * What a placed Trupp is CALLED on the map/plan: the leader's name, in full, as recorded.
 *
 * It used to be abbreviated («Meier A.») to keep the chip small. On a Lage with three Trupps that
 * costs the one thing the marker is there to answer — which of them is this? — and two Meiers in
 * the same Wehr make the short form ambiguous outright. The symbol carries the name; the hose end
 * tag, which sits in the middle of the picture next to a Leitung number, keeps the short form
 * (lib/truppLines · truppTagText).
 */
const truppLabel = (name: string): string => name.trim()

/**
 * What a Trupp edit actually CHANGED, as the words the Verlauf prints.
 *
 * Exported and pure so the wording is testable: the line it feeds used to be «Auftrag angepasst»
 * for every field the form touches, which made removing an AdF and renaming the Gruppenführer
 * indistinguishable from each other AND from nothing at all. The crew line names the person, not
 * just «Mannschaft» — «wer war im Trupp» is the question asked afterwards.
 */
export function truppEditChanges(prev: Trupp | undefined, f: TruppFields): string[] {
  if (!prev) return []
  const az = appConfig.copy.atemschutz
  const out: string[] = []
  const members = (xs?: string[]) => (xs ?? []).map((x) => x.trim()).filter(Boolean)
  if (prev.name.trim() !== f.name.trim()) out.push(fillTemplate(az.changeLeader, { from: prev.name, to: f.name }))
  const before = members(prev.members)
  const after = members(f.members)
  const gone = before.filter((x) => !after.includes(x))
  const added = after.filter((x) => !before.includes(x))
  if (gone.length) out.push(fillTemplate(az.changeMemberOut, { names: gone.join(', ') }))
  if (added.length) out.push(fillTemplate(az.changeMemberIn, { names: added.join(', ') }))
  if (prev.auftrag !== f.auftrag || (prev.ziel ?? '') !== (f.ziel ?? '')) out.push(az.changeAuftrag)
  if ((prev.lineNo ?? null) !== (f.lineNo ?? null)) {
    out.push(f.lineNo == null ? az.changeLineCleared : fillTemplate(az.changeLine, { n: String(f.lineNo) }))
  }
  if ((prev.funkkanal ?? null) !== (f.funkkanal ?? null)) {
    out.push(fillTemplate(az.changeFunkkanal, { n: f.funkkanal == null ? '–' : String(f.funkkanal) }))
  }
  if (f.color !== undefined && (prev.color ?? null) !== (f.color ?? null)) out.push(az.changeColor)
  return out
}

interface Deps {
  trupps: Trupp[]
  /** live Lage drawings — read to find the hose a Trupp was linked to (and which numbers are
   *  already taken on that surface). Written through `setDocRaw`, like the placements. */
  drawings: Drawing[]
  /** live Lage entities — read to see which team colours are already worn (pickTeamColor) */
  entities: Entity[]
  setTrupps: Dispatch<SetStateAction<Trupp[]>>
  /** read-only board (to locate a Trupp's plan chip so «auf Plan zeigen» centres on it) */
  board: BoardDoc
  setBoard: Dispatch<SetStateAction<BoardDoc>>
  /** raw Lage-doc setter (no undo snapshot — placement mirrors the plan chip's setBoard) */
  setDocRaw: Dispatch<SetStateAction<Doc>>
  building: BuildingDoc | null
  log: (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string) => void
  logPlan: (icon: string, text: string, extra?: { kind?: TimelineEvent['kind']; annoId?: string; x?: number; y?: number; floor?: number }) => void
  emit: (op_type: string, payload?: Record<string, unknown>) => void
  setMode: (m: Mode) => void
  setActivePlanId: (id: string) => void
  setPanel: (p: 'layers' | null) => void
  setPlanFocus: (f: PlanFocus) => void
  /** current Lage-map centre — where a newly placed team marker lands (user drags it after) */
  mapCenter: () => LngLat
  /** jump to + select a map entity (setMode('map') + select; fly=false skips the camera move) */
  focusMapEntity: (entityId: string, coord?: LngLat, fly?: boolean) => void
  /** jump to + select a Lage DRAWING (the hose a Trupp works on) */
  focusMapDrawing: (drawingId: string) => void
}

/**
 * Atemschutzüberwachung (SCBA monitoring) Trupp mutations — lifted out of App's god-component.
 * Each handler updates the trupps array + the plan board, writes the Verlauf line, and emits an
 * audit event. Behaviour is exactly as it was inline in App (these were just bug-fixed for the
 * live-poll sync race), so this is a pure move. `trupps`/`setTrupps` stay in App (they ride the
 * persistence blob + hydrate + multiple components) and are passed in.
 */
export function useTruppActions(deps: Deps) {
  const { trupps, drawings, entities, setTrupps, board, setBoard, setDocRaw, building, log, logPlan, emit, setMode, setActivePlanId, setPanel, setPlanFocus, mapCenter, focusMapEntity, focusMapDrawing } = deps

  /** a Trupp that is already out keeps whatever it recorded — the takeover only touches the live ones */
  const isOutTrupp = (t: Trupp) => t.status === 'raus' || !!t.exitTime

  // the hose lines of each surface, in the shape the link resolution needs
  const docLines = (): LinkableLine[] => drawings.filter((d) => d.kind === 'line')
  const planLines = (planId: string): LinkableLine[] => (board[planId] ?? []).filter((a) => a.kind === 'draw')

  // A Trupp is tracked at exactly ONE place — drop any prior placement (plan chip AND/OR
  // map marker) before adding a new one, so re-placing or a sync re-fire can't leave an
  // orphaned duplicate that maps back to the same Trupp.
  const dropPlacements = (tr: Trupp) => {
    if (tr.annoId && tr.planId) {
      const { annoId, planId } = tr
      setBoard((b) => ({ ...b, [planId]: (b[planId] ?? []).filter((a) => a.id !== annoId) }))
    }
    if (tr.entityId) {
      const { entityId } = tr
      setDocRaw((d) => ({ ...d, entities: d.entities.filter((e) => e.id !== entityId) }))
    }
  }

  // Registering a Trupp does NOT place a marker — Atemschutz teams belong on the building
  // plan, not the Lage map. The EL places one manually later via "Platzieren" (placeTruppOnPlan),
  // which drops a resource chip on the Gebäude floor-stack (or Modul 6) keyed by Trupp.annoId.
  const createTrupp = (t: Trupp) => {
    // The Eingangsdruck IS a measurement, taken at the Tafel before anybody goes anywhere — so it
    // opens the Druckverlauf rather than sitting outside it. It used to be recorded only in
    // `entryPressureBar`, and the log started at «Eingerückt»: a Sicherungstrupp that was never
    // sent in therefore printed «Kein Druckverlauf erfasst» on the Rapport under a Trupp whose
    // cylinder the Überwacher had read and typed in (08.08. Einsatz).
    const registered: Trupp['readings'] = t.readings?.length
      ? t.readings
      : [{ t: new Date().toISOString(), bar: t.entryPressureBar, kind: 'registered' }]
    // a new card joins at the END of the hand-set order, never in the middle of a board somebody
    // arranged — `order` is synced, so it lands the same way on every device
    setTrupps((ts) => [...ts, {
      ...t, readings: registered,
      order: t.order ?? ts.reduce((n, x) => Math.max(n, x.order ?? 0), 0) + 1,
    }])
    // with the Eingangsdruck: it is the number the whole pressure trend is measured from, and
    // the Verlauf used to start the story without it
    log('flag', fillTemplate(appConfig.copy.atemschutz.logRegister, { name: t.name, bar: String(t.entryPressureBar) }), 'team')
    emit('atemschutz.register', { id: t.id })
  }
  const updateTrupp = (id: string, patch: Partial<Trupp>) =>
    setTrupps((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  /** Move a card one slot in the hand-set order. Swaps the two `order` values rather than
   *  renumbering the board, so a concurrent edit on another device touches at most these two
   *  Trupps. Not logged: where a card sits is a way of looking at the board, not something that
   *  happened at the Einsatz — and the Verlauf is thin enough to keep for what did. */
  const moveTrupp = (id: string, dir: -1 | 1) => setTrupps((ts) => {
    const ordered = [...ts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const i = ordered.findIndex((t) => t.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ordered.length) return ts
    const [a, b] = [ordered[i], ordered[j]]
    // an older Trupp may carry no order at all — settle both from their current position first
    const oa = a.order ?? i
    const ob = b.order ?? j
    return ts.map((t) => (t.id === a.id ? { ...t, order: ob } : t.id === b.id ? { ...t, order: oa } : t))
  })
  // keep the placed chip/marker label in sync when the leader changes (plan chip text ==
  // map marker label == the leader's name as recorded)
  const syncPlacementLabel = (tr: Trupp, name: string) => {
    if (tr.annoId && tr.planId) {
      const { annoId, planId } = tr
      setBoard((b) => ({ ...b, [planId]: (b[planId] ?? []).map((a) => (a.id === annoId ? { ...a, text: truppLabel(name) } : a)) }))
    }
    if (tr.entityId) {
      const { entityId } = tr
      setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === entityId ? { ...e, label: truppLabel(name) } : e)) }))
    }
  }
  // The Trupp's own palette slot — its index in the list, so plan chip and map marker match and
  // a Trupp keeps the colour people have got used to. Whether it actually GETS that colour is
  // decided at placement by pickTeamColor, which steps aside if something already wears it.
  const preferredColor = (id: string) => {
    const colors = appConfig.drawing.teamColors
    return colors[Math.max(0, trupps.findIndex((t) => t.id === id)) % colors.length]
  }
  /**
   * A colour someone DECIDED on for this Trupp, in the order those decisions were made: the
   * Trupp's own pick first, then the station's colour for its Auftrag. Undefined = nobody decided,
   * so the automatic palette applies.
   *
   * A chosen colour is used verbatim — it deliberately does NOT go through pickTeamColor. That
   * helper exists to keep automatic colours apart from one another; applying it here would quietly
   * refuse «alle Löschtrupps rot», which is exactly what choosing a colour is for.
   */
  const chosenColor = (tr?: Trupp): string | undefined =>
    tr?.color || (tr?.auftrag ? atemschutzAuftragColors()[tr.auftrag] : undefined) || undefined
  /** every colour currently worn by a placed marker or plan chip — what a new placement must
   *  not duplicate. Reads the live doc/board rather than a counter, so deleting a Trupp frees
   *  its colour again instead of shifting everyone else's. */
  const colorsInUse = (exceptTruppId?: string): (string | undefined)[] => [
    ...entities.filter((e) => e.kind === 'team' && e.truppId !== exceptTruppId).map((e) => e.color),
    ...Object.values(board).flat().filter((a) => a.kind === 'resource' && a.truppId !== exceptTruppId).map((a) => a.color),
  ]
  const teamColor = (id: string) =>
    chosenColor(trupps.find((t) => t.id === id)) ?? pickTeamColor(preferredColor(id), colorsInUse(id))
  /**
   * Repaint a Trupp from wherever the operator is looking — the symbol's own colour control on the
   * Lage / the plan. It writes the TRUPP, not just the symbol: colour is the Trupp's identity, so
   * painting its marker blue and leaving the board card (and a later re-placement) on the old
   * colour would just be a second, disagreeing answer to «which one is this?».
   * `null` puts it back on automatic.
   */
  const setTruppColor = (id: string, color: string | null) => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr || (tr.color ?? null) === color) return
    updateTrupp(id, { color: color ?? undefined })
    recolorPlacement({ ...tr, color: color ?? undefined })
    // repainting from the symbol used to be the one edit with no line at all, so a Lage that
    // suddenly had two red Trupps could not be explained from the log
    log('pen', fillTemplate(appConfig.copy.atemschutz.logColor, { name: tr.name }), 'team')
    emit('atemschutz.edit', { id, color })
  }
  /** The form's colour as a Trupp patch. `null` = «zurück auf automatisch» (drop the field),
   *  `undefined` = the form didn't carry one, so leave whatever the Trupp has. */
  const colorPatch = (f: TruppFields): Partial<Trupp> =>
    (f.color === undefined ? {} : { color: f.color ?? undefined })
  /** Repaint a Trupp's placed marker / plan chip after its colour (or the Auftrag that decides it)
   *  changed. No-op when it isn't placed. */
  const recolorPlacement = (tr: Trupp) => {
    if (!tr.annoId && !tr.entityId) return
    syncPlacementColor(tr, chosenColor(tr) ?? pickTeamColor(preferredColor(tr.id), colorsInUse(tr.id)))
  }
  /** Repaint a Trupp's placed marker / plan chip — the twin of syncPlacementLabel, for when the
   *  colour (or the Auftrag that decides it) changes on an already-placed Trupp. */
  const syncPlacementColor = (tr: Trupp, color: string) => {
    if (tr.annoId && tr.planId) {
      const { annoId, planId } = tr
      setBoard((b) => ({ ...b, [planId]: (b[planId] ?? []).map((a) => (a.id === annoId ? { ...a, color } : a)) }))
    }
    if (tr.entityId) {
      const { entityId } = tr
      setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === entityId ? { ...e, color } : e)) }))
    }
  }
  // Place a Trupp manually on the building plan (Gebäude floor-stack if a building exists, else
  // Modul 6) as a resource chip the EL can then drag to the team's position. NOT auto-created
  // on registration.
  const placeTruppOnPlan = (id: string, targetPlanId?: string) => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr) return
    // explicit target (from the placement picker) wins; else default to the Gebäude
    // floor-stack when a building exists, otherwise Modul 6
    const planId = targetPlanId ?? (building ? gebaeudeDoc.id : 'modul6')
    const annoId = `trupp${Date.now()}`
    const chip: BoardAnno = { id: annoId, kind: 'resource', x: 0.5, y: 0.5, floor: 0, text: truppLabel(tr.name), t: formatTime(new Date()), color: teamColor(id), trail: [], truppId: id }
    dropPlacements(tr)
    setBoard((b) => ({ ...b, [planId]: [...(b[planId] ?? []), chip] }))
    updateTrupp(id, { annoId, planId, entityId: undefined })
    setMode('plans'); setActivePlanId(planId); setPanel(null)
    setPlanFocus({ x: 0.5, y: 0.5, floor: 0, annoId, nonce: Date.now() })
    logPlan('flag', fillTemplate(appConfig.copy.atemschutz.logPlaced, { name: tr.name }), { kind: 'team', annoId, x: 0.5, y: 0.5, floor: 0 })
    emit('atemschutz.place', { id, annoId, planId })
  }
  // Place a Trupp on the Lage map (outdoor teams — Verkehrsgruppe, Wasserversorgung, exterior
  // search): a 'team' marker either AT a tapped coord (the map's Trupp tool) or at the current
  // map centre (the Atemschutz card's «Platzieren»), dragged to position like a plan chip.
  // Same one-place rule: placing here removes any plan chip.
  const placeTruppOnMap = (id: string, atCoord?: LngLat) => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr) return
    const entityId = `trupp${Date.now()}`
    const marker: Entity = {
      id: entityId, kind: 'team', layer: appConfig.defaults.operationalLayerId,
      coord: atCoord ?? mapCenter(), label: truppLabel(tr.name), t: formatTime(new Date()),
      color: teamColor(id), trail: [], truppId: id,
    }
    dropPlacements(tr)
    setDocRaw((d) => ({ ...d, entities: [...d.entities, marker] }))
    updateTrupp(id, { entityId, annoId: undefined, planId: undefined })
    setPanel(null)
    // tapped placement is already in view — select without the camera jump
    focusMapEntity(entityId, atCoord ? undefined : marker.coord, !atCoord)
    log('flag', fillTemplate(appConfig.copy.atemschutz.logPlacedMap, { name: tr.name }), 'team', undefined, entityId)
    emit('atemschutz.place', { id, entityId })
  }
  // jump to a placed Trupp — its plan chip or its Lage-map marker, wherever it lives
  const focusTruppOnPlan = (id: string) => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr) return
    if (tr.entityId) { setPanel(null); focusMapEntity(tr.entityId); return }
    if (!tr.annoId || !tr.planId) return
    setMode('plans'); setActivePlanId(tr.planId); setPanel(null)
    // Centre on the Trupp's actual chip, not the plan centre — look up its anchor + floor from
    // the board (was hard-coded 0.5,0.5,0, so it only opened the plan at the current position).
    const anno = (board[tr.planId] ?? []).find((a) => a.id === tr.annoId)
    setPlanFocus({ x: anno?.x ?? 0.5, y: anno?.y ?? 0.5, floor: anno?.floor ?? 0, annoId: tr.annoId, nonce: Date.now() })
  }
  /**
   * Show the Leitung this Trupp works on — the counterpart of «auf Plan zeigen» for the hose.
   * Looks on the Lage first (that is where a Druckleitung is usually drawn), then across the
   * plans; resolution is the normal one, so a Trupp matched by NUMBER alone jumps just as well as
   * one that was explicitly picked. Returns false when nothing is drawn yet, so the caller can
   * keep the affordance off rather than offering a dead button.
   */
  const showTruppLine = (id: string): boolean => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr) return false
    const onMap = drawings.find((d) => d.kind === 'line' && truppForLine(d, [tr])?.id === tr.id)
    if (onMap) { setMode('map'); setPanel(null); focusMapDrawing(onMap.id); return true }
    for (const [planId, annos] of Object.entries(board)) {
      const anno = annos.find((a) => a.kind === 'draw' && truppForLine(a, [tr])?.id === tr.id)
      if (!anno) continue
      const [x, y, floor] = anno.pts?.[0] ?? [0.5, 0.5, anno.floor ?? 0]
      setMode('plans'); setActivePlanId(planId); setPanel(null)
      // `flash`: outline it, don't select it — same rule as the Lage (see focusMapDrawing)
      setPlanFocus({ x, y, floor: floor ?? anno.floor ?? 0, annoId: anno.id, flash: true, nonce: Date.now() })
      return true
    }
    return false
  }

  /** Which Trupps have a drawn Leitung to jump to — drives the card chip's affordance, so it is
   *  a button exactly when there is somewhere to go. */
  const truppsWithLine = (): Set<string> => {
    const lines = [...docLines(), ...Object.values(board).flat().filter((a) => a.kind === 'draw')]
    const out = new Set<string>()
    for (const t of trupps) if (lines.some((l) => truppForLine(l, [t])?.id === t.id)) out.add(t.id)
    return out
  }

  // record a Funkkontakt: resets the contact clock (the core FKS safety signal) and appends a
  // log row carrying the current pressure (so the Verlauf shows the trend even at radio checks)
  const recordContact = (id: string) => {
    const tr = trupps.find((t) => t.id === id)
    const now = new Date().toISOString()
    setTrupps((ts) => ts.map((t) => (t.id === id
      ? { ...t, lastContactTime: now, readings: [...(t.readings ?? []), { t: now, bar: t.lastPressureBar ?? t.entryPressureBar, kind: 'contact' }] }
      : t)))
    log('radio', fillTemplate(appConfig.copy.atemschutz.logContact, { name: tr?.name ?? '' }), 'team')
    emit('atemschutz.contact', { id })
  }
  // record a cylinder pressure reading — logged for the record, and counts as a contact. All
  // derived state (lowestBar, the log row) is computed INSIDE the updater so it never reads stale.
  const recordPressure = (id: string, bar: number) => {
    const tr = trupps.find((t) => t.id === id)
    const snapshot = tr // the Trupp as it was BEFORE the reading — for the undo
    const now = new Date().toISOString()
    setTrupps((ts) => ts.map((t) => (t.id === id
      ? { ...t, lastPressureBar: bar, lastPressureTime: now, lastContactTime: now, lowestBar: Math.min(t.lowestBar ?? t.entryPressureBar, bar),
          readings: [...(t.readings ?? []), { t: now, bar, kind: 'pressure' }] }
      : t)))
    log('drop', fillTemplate(appConfig.copy.atemschutz.logPressure, { name: tr?.name ?? '', bar }), 'team')
    // Crossing the Alarmdruck is the moment the Trupp has to turn round, and it was visible on
    // the card and nowhere else — the reconstruction afterwards could not say when it happened.
    // Logged on the CROSSING only, so a Trupp reading below the threshold does not repeat it at
    // every contact.
    const alarmBar = atemschutzDoctrine().alarmBar
    const wasAbove = (tr?.lastPressureBar ?? tr?.entryPressureBar ?? Infinity) > alarmBar
    if (tr && wasAbove && bar <= alarmBar) {
      log('warn', fillTemplate(appConfig.copy.atemschutz.logPressureAlarm, { name: tr.name, bar: String(alarmBar) }), 'team')
    }
    emit('atemschutz.pressure', { id, bar })
    // confirm-with-undo (house rule): a fat-fingered reading ("20" for "200") would otherwise
    // permanently poison lowestBar → a false red «tiefster Druck» on the legal record with no
    // way back. Undo restores the Trupp's pre-reading state (pressure, contact clock, lowestBar,
    // per-Trupp readings). The Verlauf line stays (append-only doctrine — the record shows the
    // correction happened), but the safety-critical derived state is fixed.
    if (snapshot) {
      toast(fillTemplate(appConfig.copy.atemschutz.logPressure, { name: tr?.name ?? '', bar }), {
        icon: 'drop',
        action: { label: appConfig.copy.undo, onClick: () => setTrupps((ts) => ts.map((t) => (t.id === id ? snapshot : t))) },
      })
    }
  }
  // advance a Trupp's lifecycle phase: angemeldet → aktiv (eingerückt, starts the contact clock +
  // logs the entry reading) → rueckzug → raus (sets exitTime, ends monitoring), and the reverse
  // rueckzug → aktiv (the Rückzug was called off). Logs the matching Verlauf line.
  //
  // Rückzug and Fortsetzen COUNT AS A FUNKKONTAKT and reset the contact clock. Neither happens
  // spontaneously: a Rückzug is ordered by the EL or the Truppüberwacher, or reported by the
  // Trupp, and a Fortsetzen means the Trupp was reached and sent back in. Leaving the clock
  // running afterwards showed «überfällig» on a Trupp somebody had just spoken to, which trains
  // the Überwacher to ignore red. Same rule a Druckmeldung already follows (recordPressure).
  const setTruppStatus = (id: string, status: Trupp['status']) => {
    const tr = trupps.find((t) => t.id === id)
    const az = appConfig.copy.atemschutz
    const now = new Date().toISOString()
    const isResume = status === 'aktiv' && !!tr?.entryTime // back into the field after a Rückzug
    const impliesContact = status === 'rueckzug' || isResume
    setTrupps((ts) => ts.map((t) => {
      if (t.id !== id) return t
      if (status === 'aktiv' && !t.entryTime) {
        return { ...t, status, entryTime: now, lastContactTime: now, readings: [...(t.readings ?? []), { t: now, bar: t.entryPressureBar, kind: 'entry' }] }
      }
      if (status === 'raus') return { ...t, status, exitTime: now }
      if (impliesContact) {
        return { ...t, status, lastContactTime: now, readings: [...(t.readings ?? []), { t: now, bar: t.lastPressureBar ?? t.entryPressureBar, kind: 'contact' }] }
      }
      return { ...t, status }
    }))
    // «draussen» on a Trupp that never went in is a false statement about where people were —
    // a Sicherungstrupp that was stood down gets its own line (see atemschutz · truppNeverDeployed)
    const neverDeployed = status === 'raus' && !tr?.entryTime
    const tpl = status === 'aktiv' ? (isResume ? az.logContinue : az.logEntry)
      : status === 'rueckzug' ? az.logRueckzug
      : status === 'raus' ? (neverDeployed ? az.logNotDeployed : az.logExit) : null
    const icon = status === 'raus' ? 'logout' : status === 'rueckzug' ? 'undo' : 'flag'
    if (tpl) log(icon, fillTemplate(tpl, { name: tr?.name ?? '' }), 'team')
    emit('atemschutz.status', { id, status })
    // «raus» is terminal — it ends monitoring and stamps exitTime. Without undo a mis-tap is a
    // dead-end that only a full re-deployment (which resets the clocks) can reverse. Offer a
    // Rückgängig toast restoring the pre-raus Trupp (status + entry/contact clocks + exitTime).
    if (status === 'raus' && tr) {
      const snapshot = tr
      toast(fillTemplate(neverDeployed ? az.logNotDeployed : az.logExit, { name: tr.name }), {
        icon: 'undo',
        action: { label: appConfig.copy.undo, onClick: () => setTrupps((ts) => ts.map((t) => (t.id === id ? snapshot : t))) },
      })
    }
  }
  // edit a Trupp's Auftrag / team mid-incident (job changed, moved floor, crew swapped). Touches
  // only the descriptive fields — never the live clock/pressure. Keeps the plan chip label in sync.
  const editTrupp = (id: string, f: TruppFields) => {
    const tr = trupps.find((t) => t.id === id)
    updateTrupp(id, { name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNo: f.lineNo, funkkanal: f.funkkanal, leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds, ...colorPatch(f) })
    // Clearing (or changing) the Leitung number in the form IS how a Trupp lets go of a hose —
    // that is where the operator already is when they change their mind, so the card needs no
    // «lösen» icon. The anchor goes with it, or the tag would survive its own number.
    if (tr && f.lineNo !== tr.lineNo && tr.lineId) clearLineAnchor(id)
    if (tr && f.name !== tr.name) syncPlacementLabel(tr, f.name)
    // colour follows the Trupp, so a repaint (or a new Auftrag under a station colour rule) has
    // to reach the already-placed marker/chip too — otherwise board and map disagree
    if (tr) recolorPlacement({ ...tr, color: f.color === null ? undefined : f.color ?? tr.color, auftrag: f.auftrag })
    // «Trupp X: Auftrag angepasst» covered every field the form touches and named none of them —
    // so removing an AdF, swapping the Gruppenführer or changing the Funkkanal all read as the
    // same nothing, and a Trupp whose Auftrag was untouched said the opposite of what happened.
    // The line now lists what actually changed (same shape as the Sicherheitswerte line).
    const changes = truppEditChanges(tr, f)
    log('pen', changes.length
      ? fillTemplate(appConfig.copy.atemschutz.logEditFields, { name: f.name, changes: changes.join(', ') })
      : fillTemplate(appConfig.copy.atemschutz.logEdit, { name: f.name }), 'team')
    emit('atemschutz.edit', { id })
  }
  // re-deploy an exited Trupp (refilled bottle, going back inside): a fresh start — new pressure +
  // reset clocks/log — while letting the EL adjust the Auftrag/team on the way back in.
  //
  // `standby` decides WHERE the fresh start lands. A re-equipped Trupp is very often held back as
  // Sicherungstrupp rather than sent straight in, and forcing it to 'aktiv' started a contact
  // clock on a crew standing at the vehicle — a clock that goes überfällig on somebody who is
  // not under PA. Standby mirrors the create path exactly (angemeldet, no entryTime, empty log),
  // so the later «Eingerückt» stamps the entry the same way it does for a brand-new Trupp.
  const reactivateTrupp = (id: string, f: TruppFields, standby = false) => {
    const tr = trupps.find((t) => t.id === id)
    const now = new Date().toISOString()
    setTrupps((ts) => ts.map((t) => (t.id === id
      ? { ...t, name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNo: f.lineNo, funkkanal: f.funkkanal,
          leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds, ...colorPatch(f),
          status: standby ? 'angemeldet' : 'aktiv',
          entryTime: standby ? '' : now, lastContactTime: standby ? '' : now, exitTime: undefined,
          entryPressureBar: f.pressure, lastPressureBar: undefined, lastPressureTime: undefined, lowestBar: f.pressure,
          // standby is the create path exactly: the fresh cylinder was read, so the log opens
          // with that reading rather than empty (see createTrupp)
          readings: [{ t: now, bar: f.pressure, kind: standby ? 'registered' : 'entry' }] }
      : t)))
    if (tr && f.lineNo !== tr.lineNo && tr.lineId) clearLineAnchor(id)
    if (tr && f.name !== tr.name) syncPlacementLabel(tr, f.name)
    if (tr) recolorPlacement({ ...tr, color: f.color === null ? undefined : f.color ?? tr.color, auftrag: f.auftrag })
    const az = appConfig.copy.atemschutz
    log('flag', fillTemplate(standby ? az.logStandby : az.logReenter, { name: f.name, bar: String(f.pressure ?? '') }), 'team')
    emit('atemschutz.status', { id, status: standby ? 'angemeldet' : 'aktiv' })
  }
  /**
   * Link a Trupp to a drawn hose line — ONE action, because it writes two collections: the Trupp
   * (anchor + number) and the drawing (mirror + the stamped number). Split across two call sites
   * the halves would drift apart under sync; every other link in here (annoId/planId, entityId)
   * follows the same rule.
   *
   * `lineId` may name a Lage drawing or a Plan annotation — the surface is inferred, so the
   * caller just hands over what the operator tapped. Both writes go through the RAW setters, the
   * way placements do: the link is bookkeeping, not a drawing edit, and it has no business
   * sitting on the undo stack (Cmd-Z after linking would otherwise strip the stamped number and
   * leave the Trupp pointing at a line that no longer says which Leitung it is).
   */
  const linkTruppLine = (truppId: string, lineId: string): boolean => {
    const tr = trupps.find((t) => t.id === truppId)
    if (!tr) return false
    const az = appConfig.copy.atemschutz
    const onMap = docLines().some((l) => l.id === lineId)
    const planId = onMap ? null : Object.keys(board).find((pid) => (board[pid] ?? []).some((a) => a.id === lineId && a.kind === 'draw'))
    // not a hose (an Absperrkreis, a Fläche, a freehand scribble) — nothing to link
    if (!onMap && !planId) return false
    const lines = onMap ? docLines() : planLines(planId!)
    const line = lines.find((l) => l.id === lineId)!
    const no = resolveLinkNumber(tr, line, lines, trupps)

    // the drawing: mirror + number. Any OTHER line that claimed this Trupp lets go, so a Trupp
    // is on exactly one Leitung (re-picking moves it instead of leaving two tagged hoses).
    const patchLine = <T extends { id: string; truppId?: string; lineNo?: number }>(l: T): T =>
      l.id === lineId ? { ...l, truppId, ...(no != null ? { lineNo: no } : {}) }
        : l.truppId === truppId ? { ...l, truppId: undefined } : l
    setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.kind === 'line' ? patchLine(dr) : dr)) }))
    setBoard((b) => Object.fromEntries(Object.entries(b).map(([pid, annos]) =>
      [pid, annos.map((a) => (a.kind === 'draw' ? patchLine(a) : a))])))
    // One Leitung, one Trupp: whoever else claims this number lets go of it, so picking a Trupp
    // for a hose can't quietly produce two Trupps on one Leitung. Their NEW fields are cleared —
    // a legacy free-text designation is never rewritten (an incident is a legal record).
    setTrupps((ts) => ts.map((t) => {
      if (t.id === truppId) return { ...t, lineId, ...(no != null ? { lineNo: no } : {}) }
      const claims = (no != null && t.lineNo === no) || (t.lineId && t.lineId === lineId)
      return claims && !isOutTrupp(t) ? { ...t, lineId: undefined, lineNo: undefined } : t
    }))

    log('drop', fillTemplate(az.logLineLinked, { name: tr.name, n: no != null ? String(no) : '–' }), 'team')
    emit('atemschutz.line.link', { id: truppId, lineId, lineNo: no })
    toast(fillTemplate(az.lineLinkedToast, { n: no != null ? String(no) : '–', name: tr.name }), { icon: 'drop' })
    return true
  }

  /** Drop just the ANCHOR (both sides), keeping whatever number the Trupp carries. Used when the
   *  number is edited: the anchor was stamped FROM a number, so it must not outlive it — a Trupp
   *  moved from Leitung 1 to Leitung 3 would otherwise still point at the old hose. */
  const clearLineAnchor = (truppId: string) => {
    const drop = <T extends { truppId?: string }>(l: T): T => (l.truppId === truppId ? { ...l, truppId: undefined } : l)
    setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.kind === 'line' ? drop(dr) : dr)) }))
    setBoard((b) => Object.fromEntries(Object.entries(b).map(([pid, annos]) =>
      [pid, annos.map((a) => (a.kind === 'draw' ? drop(a) : a))])))
    updateTrupp(truppId, { lineId: undefined })
  }

  /**
   * Let go of the Leitung. Clears the anchor on BOTH sides and the Trupp's own number — dropping
   * only the anchor would leave the number match to re-attach the tag on the very next render,
   * so «gelöst» would visibly do nothing. The drawn line keeps its number: the hose is still
   * Leitung 1 in the picture, it just has nobody on it.
   */
  const unlinkTruppLine = (truppId: string) => {
    const tr = trupps.find((t) => t.id === truppId)
    if (!tr) return
    const drop = <T extends { truppId?: string }>(l: T): T => (l.truppId === truppId ? { ...l, truppId: undefined } : l)
    setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.kind === 'line' ? drop(dr) : dr)) }))
    setBoard((b) => Object.fromEntries(Object.entries(b).map(([pid, annos]) =>
      [pid, annos.map((a) => (a.kind === 'draw' ? drop(a) : a))])))
    updateTrupp(truppId, { lineId: undefined, lineNo: undefined })
    log('drop', fillTemplate(appConfig.copy.atemschutz.logLineUnlinked, { name: tr.name }), 'team')
    emit('atemschutz.line.unlink', { id: truppId })
  }

  /** The same gesture from the LINE's side («Gehört zu Trupp …» → «Kein Trupp»): whoever is on
   *  this hose lets go of it. Resolved through truppForLine so it also releases a Trupp that only
   *  ever matched by number — otherwise the picker would show «Kein Trupp» while the tag stayed. */
  const unlinkLine = (lineId: string) => {
    const line = docLines().find((l) => l.id === lineId)
      ?? Object.values(board).flat().find((a) => a.id === lineId && a.kind === 'draw')
    const tr = line ? truppForLine(line, trupps) : undefined
    if (tr) unlinkTruppLine(tr.id)
  }

  // an escalation crossed into warn/critical — record it once in the Verlauf
  const logTruppAlarm = (id: string, status: Trupp['status']) => {
    const tr = trupps.find((t) => t.id === id)
    log('warn', fillTemplate(appConfig.copy.atemschutz.logAlarm, { name: tr?.name ?? '', status: appConfig.copy.atemschutz.status[status] ?? status }), 'team')
    emit('atemschutz.alarm', { id, status })
  }
  const deleteTrupp = (id: string) => {
    const tr = trupps.find((t) => t.id === id)
    setTrupps((ts) => ts.filter((t) => t.id !== id))
    if (tr) dropPlacements(tr)
    // A Trupp leaving the Tafel is the one Atemschutz action the Verlauf never recorded: the
    // toast said so and vanished, and the reconstruction afterwards showed a crew that had been
    // under PA simply not existing. Every other lifecycle step has its line; so does this one.
    log('trash', fillTemplate(appConfig.copy.atemschutz.logRemoved, { name: tr?.name ?? '' }), 'team')
    emit('atemschutz.delete', { id })
  }
  // undo for deleteTrupp (the delete-now + Rückgängig toast): re-add the captured Trupp with
  // its full monitoring record (readings, times, pressures). The plan chip / map marker was
  // removed with it and can't be resurrected faithfully, so the placement refs are stripped —
  // the restored Trupp is re-placed via «Platzieren». No-op if the id already exists (double tap).
  const restoreTrupp = (t: Trupp) => {
    let restored = false
    setTrupps((ts) => {
      if (ts.some((x) => x.id === t.id)) return ts
      restored = true
      return [...ts, { ...t, annoId: undefined, planId: undefined, entityId: undefined }]
    })
    // the undo gets its own line rather than erasing the delete: the log is a record of what was
    // done, and «gelöscht, dann doch nicht» is what happened
    if (restored) log('undo', fillTemplate(appConfig.copy.atemschutz.logRestored, { name: t.name }), 'team')
    emit('atemschutz.restore', { id: t.id })
  }

  /**
   * The colour each Trupp actually WEARS right now — for the Atemschutz board, so a card and its
   * symbol on the Lage read as the same Trupp.
   *
   * EVERY Trupp gets one. In order of authority: the placed marker/chip (it is what the operator
   * is looking at), then a colour somebody decided (own pick / station colour for the Auftrag),
   * then the automatic palette slot. That last case used to be left BLANK — the reasoning being
   * that an automatic colour is only settled at placement, so showing one early could show the
   * wrong one. In practice it meant the board's colour column was full of holes: a Trupp that
   * had simply never been placed had no dot, which reads as «this one has no colour» rather than
   * «not decided yet», and on a board where colour IS identity that is the more misleading of
   * the two. The guess is also not much of a guess: it runs the same `preferredColor` slot
   * through the same `pickTeamColor` the placement will use, so placing a Trupp normally
   * confirms the colour it was already wearing.
   *
   * ⚠️ The running `used` set is what keeps the unplaced ones APART. Asked one at a time they
   * would every one of them get the first free colour — ten Trupps, one colour, which is the
   * exact failure pickTeamColor exists to prevent.
   */
  const truppColors = (): Record<string, string> => {
    const out: Record<string, string> = {}
    const used: string[] = []
    // decided colours are claimed FIRST, before any automatic one is handed out — otherwise the
    // automatic pass could take the colour a later Trupp already wears by decision
    for (const t of trupps) {
      const placed = t.entityId ? entities.find((e) => e.id === t.entityId)?.color
        : t.annoId && t.planId ? (board[t.planId] ?? []).find((a) => a.id === t.annoId)?.color
        : undefined
      const c = placed ?? chosenColor(t)
      if (c) { out[t.id] = c; used.push(c) }
    }
    for (const t of trupps) {
      if (out[t.id]) continue
      const c = pickTeamColor(preferredColor(t.id), used)
      out[t.id] = c
      used.push(c)
    }
    return out
  }

  return { createTrupp, updateTrupp, moveTrupp, placeTruppOnPlan, placeTruppOnMap, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, reactivateTrupp, logTruppAlarm, deleteTrupp, restoreTrupp, linkTruppLine, unlinkTruppLine, unlinkLine, showTruppLine, truppsWithLine, truppColors, setTruppColor }
}
