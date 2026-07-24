import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from './format'
import { toast, confirmDialog } from './ui'
import type { Doc } from './workspace'
import type { Entity, LngLat, TimelineEvent } from '../types'

interface TeamMarkerActionsDeps {
  entities: Entity[]
  /** the undoable document mutation funnel (useUndoableDoc). */
  commit: (updater: (d: Doc) => Doc) => void
  log: (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string) => void
  emit: (op_type: string, payload?: Record<string, unknown>) => void
  setSelectedId: (id: string | null) => void
  setSelectedDrawingId: (id: string | null) => void
}

/**
 * Lage-map team-marker (Trupp-auf-Karte) actions, lifted out of the IncidentWorkspace
 * god-component — the map-surface counterpart to the plan board's markPosition/clearTrail.
 * Marking is the ONLY way a position is recorded (moving a marker never breadcrumbs), so the
 * recorded dots ARE the Truppverfolgung; clearing them is confirm-gated.
 */
export function useTeamMarkerActions({ entities, commit, log, emit, setSelectedId, setSelectedDrawingId }: TeamMarkerActionsDeps) {
  const placeGenericTeam = (c: LngLat) => {
    const teams = entities.filter((e) => e.kind === 'team').length
    const colors = appConfig.drawing.teamColors
    const id = `trupp${Date.now()}`
    const marker: Entity = { id, kind: 'team', layer: appConfig.defaults.operationalLayerId, coord: c, label: `${appConfig.copy.whiteboard.team} ${teams + 1}`, t: formatTime(new Date()), color: colors[teams % colors.length], trail: [] }
    commit((d) => ({ ...d, entities: [...d.entities, marker] }))
    log('flag', fillTemplate(appConfig.copy.log.teamPlaced, { name: marker.label! }), 'team', undefined, id)
    emit('entity.add', { id, kind: 'team', entity: marker })
    setSelectedId(id); setSelectedDrawingId(null)
  }
  // Team-marker trail ops on the Lage map — mirrors the plan board's markPosition/clearTrail.
  // Marking is the ONLY way a position is recorded (moving a marker never breadcrumbs), so the
  // rule stays unambiguous: a dot exists exactly where someone chose to log one.
  const markTeamPosition = (id: string) => {
    const e = entities.find((x) => x.id === id)
    if (!e || e.kind !== 'team') return
    const now = formatTime(new Date())
    commit((d) => ({ ...d, entities: d.entities.map((x) => (x.id === id ? { ...x, t: now, trail: [...(x.trail ?? []), { coord: x.coord, t: now }] } : x)) }))
    log('flag', fillTemplate(appConfig.copy.whiteboard.positionMarked, { name: e.label ?? '' }), 'team', undefined, id)
    toast(fillTemplate(appConfig.copy.whiteboard.positionMarked, { name: e.label ?? '' }))
    emit('entity.edit', { id, patch: { trail: 'mark' } })
  }
  const clearTeamTrail = async (id: string) => {
    const e = entities.find((x) => x.id === id)
    if (!e || e.kind !== 'team' || !e.trail?.length) return
    // the recorded positions ARE the Truppverfolgung — one mis-tap must not silently wipe
    // them (field feedback: the ✕ read as "some centre icon that deletes all lines")
    const ok = await confirmDialog({
      title: appConfig.copy.whiteboard.clearTrail,
      message: fillTemplate(appConfig.copy.whiteboard.clearTrailConfirm, { name: e.label ?? '', n: e.trail.length }),
      confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true,
    })
    if (!ok) return
    commit((d) => ({ ...d, entities: d.entities.map((x) => (x.id === id ? { ...x, trail: [] } : x)) }))
    log('cross', fillTemplate(appConfig.copy.whiteboard.trailCleared, { name: e.label ?? '' }))
    emit('entity.edit', { id, patch: { trail: 'clear' } })
  }
  return { placeGenericTeam, markTeamPosition, clearTeamTrail }
}
