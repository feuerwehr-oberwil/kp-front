import type { Dispatch, SetStateAction } from 'react'
import type { BoardAnno, BoardDoc, BuildingDoc, Drawing, Entity, LngLat, TimelineEvent, Trupp, TruppFields } from '../types'
import type { Doc } from './workspace'
import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from './format'
import { toast } from './ui'
import { gebaeudeDoc } from '../data/demoIncident'
import { abbreviateName } from './personnel'
import { pickTeamColor } from './teamColors'
import { resolveLinkNumber, truppForLine, type LinkableLine } from './truppLines'

type Mode = 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel'
type PlanFocus = { x: number; y: number; floor: number; annoId?: string; nonce: number } | null

/** placement-target id for the Lage map in the «Wohin platzieren?» picker (vs. a plan id) */
export const LAGE_TARGET = 'lage'

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
    setTrupps((ts) => [...ts, t])
    log('flag', fillTemplate(appConfig.copy.atemschutz.logRegister, { name: t.name }), 'team')
    emit('atemschutz.register', { id: t.id })
  }
  const updateTrupp = (id: string, patch: Partial<Trupp>) =>
    setTrupps((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  // keep the placed chip/marker label in sync when the leader changes (plan chip text ==
  // map marker label == abbreviated leader name)
  const syncPlacementLabel = (tr: Trupp, name: string) => {
    if (tr.annoId && tr.planId) {
      const { annoId, planId } = tr
      setBoard((b) => ({ ...b, [planId]: (b[planId] ?? []).map((a) => (a.id === annoId ? { ...a, text: abbreviateName(name) } : a)) }))
    }
    if (tr.entityId) {
      const { entityId } = tr
      setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === entityId ? { ...e, label: abbreviateName(name) } : e)) }))
    }
  }
  // The Trupp's own palette slot — its index in the list, so plan chip and map marker match and
  // a Trupp keeps the colour people have got used to. Whether it actually GETS that colour is
  // decided at placement by pickTeamColor, which steps aside if something already wears it.
  const preferredColor = (id: string) => {
    const colors = appConfig.drawing.teamColors
    return colors[Math.max(0, trupps.findIndex((t) => t.id === id)) % colors.length]
  }
  /** every colour currently worn by a placed marker or plan chip — what a new placement must
   *  not duplicate. Reads the live doc/board rather than a counter, so deleting a Trupp frees
   *  its colour again instead of shifting everyone else's. */
  const colorsInUse = (exceptTruppId?: string): (string | undefined)[] => [
    ...entities.filter((e) => e.kind === 'team' && e.truppId !== exceptTruppId).map((e) => e.color),
    ...Object.values(board).flat().filter((a) => a.kind === 'resource' && a.truppId !== exceptTruppId).map((a) => a.color),
  ]
  const teamColor = (id: string) => pickTeamColor(preferredColor(id), colorsInUse(id))
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
    // the moving plan chip uses the compact "Keller A." label; everywhere else keeps the full name
    const chip: BoardAnno = { id: annoId, kind: 'resource', x: 0.5, y: 0.5, floor: 0, text: abbreviateName(tr.name), t: formatTime(new Date()), color: teamColor(id), trail: [], truppId: id }
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
      coord: atCoord ?? mapCenter(), label: abbreviateName(tr.name), t: formatTime(new Date()),
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
      setPlanFocus({ x, y, floor: floor ?? anno.floor ?? 0, annoId: anno.id, nonce: Date.now() })
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
    const tpl = status === 'aktiv' ? (isResume ? az.logContinue : az.logEntry) : status === 'rueckzug' ? az.logRueckzug : status === 'raus' ? az.logExit : null
    const icon = status === 'raus' ? 'logout' : status === 'rueckzug' ? 'undo' : 'flag'
    if (tpl) log(icon, fillTemplate(tpl, { name: tr?.name ?? '' }), 'team')
    emit('atemschutz.status', { id, status })
    // «raus» is terminal — it ends monitoring and stamps exitTime. Without undo a mis-tap is a
    // dead-end that only a full re-deployment (which resets the clocks) can reverse. Offer a
    // Rückgängig toast restoring the pre-raus Trupp (status + entry/contact clocks + exitTime).
    if (status === 'raus' && tr) {
      const snapshot = tr
      toast(fillTemplate(appConfig.copy.atemschutz.logExit, { name: tr.name }), {
        icon: 'undo',
        action: { label: appConfig.copy.undo, onClick: () => setTrupps((ts) => ts.map((t) => (t.id === id ? snapshot : t))) },
      })
    }
  }
  // edit a Trupp's Auftrag / team mid-incident (job changed, moved floor, crew swapped). Touches
  // only the descriptive fields — never the live clock/pressure. Keeps the plan chip label in sync.
  const editTrupp = (id: string, f: TruppFields) => {
    const tr = trupps.find((t) => t.id === id)
    updateTrupp(id, { name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNo: f.lineNo, funkkanal: f.funkkanal, leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds })
    if (tr && f.name !== tr.name) syncPlacementLabel(tr, f.name)
    log('pen', fillTemplate(appConfig.copy.atemschutz.logEdit, { name: f.name }), 'team')
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
          leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds,
          status: standby ? 'angemeldet' : 'aktiv',
          entryTime: standby ? '' : now, lastContactTime: standby ? '' : now, exitTime: undefined,
          entryPressureBar: f.pressure, lastPressureBar: undefined, lastPressureTime: undefined, lowestBar: f.pressure,
          readings: standby ? [] : [{ t: now, bar: f.pressure, kind: 'entry' }] }
      : t)))
    if (tr && f.name !== tr.name) syncPlacementLabel(tr, f.name)
    const az = appConfig.copy.atemschutz
    log('flag', fillTemplate(standby ? az.logStandby : az.logReenter, { name: f.name }), 'team')
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
    updateTrupp(truppId, { lineId, ...(no != null ? { lineNo: no } : {}) })

    log('drop', fillTemplate(az.logLineLinked, { name: tr.name, n: no != null ? String(no) : '–' }), 'team')
    emit('atemschutz.line.link', { id: truppId, lineId, lineNo: no })
    toast(fillTemplate(az.lineLinkedToast, { n: no != null ? String(no) : '–', name: tr.name }), { icon: 'drop' })
    return true
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
    emit('atemschutz.delete', { id })
  }
  // undo for deleteTrupp (the delete-now + Rückgängig toast): re-add the captured Trupp with
  // its full monitoring record (readings, times, pressures). The plan chip / map marker was
  // removed with it and can't be resurrected faithfully, so the placement refs are stripped —
  // the restored Trupp is re-placed via «Platzieren». No-op if the id already exists (double tap).
  const restoreTrupp = (t: Trupp) => {
    setTrupps((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, { ...t, annoId: undefined, planId: undefined, entityId: undefined }]))
    emit('atemschutz.restore', { id: t.id })
  }

  return { createTrupp, updateTrupp, placeTruppOnPlan, placeTruppOnMap, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, reactivateTrupp, logTruppAlarm, deleteTrupp, restoreTrupp, linkTruppLine, unlinkTruppLine, unlinkLine, showTruppLine, truppsWithLine }
}
