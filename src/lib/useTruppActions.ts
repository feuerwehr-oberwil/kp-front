import type { Dispatch, SetStateAction } from 'react'
import type { BoardAnno, BoardDoc, BuildingDoc, Entity, LngLat, TimelineEvent, Trupp, TruppFields } from '../types'
import type { Doc } from './workspace'
import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from './format'
import { toast } from './ui'
import { gebaeudeDoc } from '../data/demoIncident'
import { abbreviateName } from './personnel'
import { pickTeamColor } from './teamColors'

type Mode = 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel'
type PlanFocus = { x: number; y: number; floor: number; annoId?: string; nonce: number } | null

/** placement-target id for the Lage map in the «Wohin platzieren?» picker (vs. a plan id) */
export const LAGE_TARGET = 'lage'

interface Deps {
  trupps: Trupp[]
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
}

/**
 * Atemschutzüberwachung (SCBA monitoring) Trupp mutations — lifted out of App's god-component.
 * Each handler updates the trupps array + the plan board, writes the Verlauf line, and emits an
 * audit event. Behaviour is exactly as it was inline in App (these were just bug-fixed for the
 * live-poll sync race), so this is a pure move. `trupps`/`setTrupps` stay in App (they ride the
 * persistence blob + hydrate + multiple components) and are passed in.
 */
export function useTruppActions(deps: Deps) {
  const { trupps, entities, setTrupps, board, setBoard, setDocRaw, building, log, logPlan, emit, setMode, setActivePlanId, setPanel, setPlanFocus, mapCenter, focusMapEntity } = deps

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
    updateTrupp(id, { name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNumber: f.lineNumber, funkkanal: f.funkkanal, leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds })
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
      ? { ...t, name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNumber: f.lineNumber, funkkanal: f.funkkanal,
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

  return { createTrupp, updateTrupp, placeTruppOnPlan, placeTruppOnMap, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, reactivateTrupp, logTruppAlarm, deleteTrupp, restoreTrupp }
}
