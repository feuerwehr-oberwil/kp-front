import type { BoardAnno, Entity, GeoTrailPoint, LineAttachment, LngLat, TrailPoint, Trupp } from '../../types'
import { appConfig } from '../../config/appConfig'
import { fillTemplate, formatTime } from '../format'
import { confirmDialog } from '../ui'
import { gebaeudeDoc } from '../../data/demoIncident'
import { newId } from '../ids'
import { truppAwaitsEntry, truppLogName } from '../atemschutz'
import { resolveMarkerJoin } from '../placedTrupps'
import { floorLabel } from '../whiteboard'
import { truppLabel, type TruppActionCore, type TruppActionDeps } from './core'
import type { TruppColorActions } from './colors'

// The Trupp PLACEMENT family — where a Trupp stands in the picture: its plan chip or its Lage
// marker (one place at a time), joining an already placed marker to a Trupp and letting it go,
// and the jump to it. Composed by lib/useTruppActions.

type PlacementDeps = Pick<TruppActionDeps, 'trupps' | 'drawings' | 'objects' | 'board' | 'setBoard' | 'setDocRaw'
  | 'building' | 'log' | 'logPlan' | 'emit' | 'setMode' | 'setActivePlanId' | 'setPanel' | 'setPlanFocus' | 'mapCenter' | 'focusMapEntity'>
  & Pick<TruppActionCore, 'updateTrupp'>
  & Pick<TruppColorActions, 'teamColor'>
  & {
    /** the clock's own transition — the «einrücken?» ask after a placement runs it (askTruppEntry) */
    setTruppStatus: (id: string, status: Trupp['status']) => void
    /** the lines family: a marker and the hose coupled to it are one fact, so adopting a marker
     *  takes its hose along and releasing it lets the hose go (adoptTruppMarker / releaseTruppMarker) */
    linkTruppLine: (truppId: string, lineId: string) => boolean
    unlinkTruppLine: (truppId: string) => void
  }

export function truppPlacementActions(deps: PlacementDeps) {
  const { trupps, drawings, objects, board, setBoard, setDocRaw, building, log, logPlan, emit, setMode, setActivePlanId, setPanel, setPlanFocus, mapCenter, focusMapEntity, updateTrupp, teamColor, setTruppStatus, linkTruppLine, unlinkTruppLine } = deps

  /** The hose whose start or end is docked onto this marker, on either surface — what a marker
   *  that is only NOW being bound to a Trupp may already be carrying (see adoptTruppMarker). */
  const lineEndingOn = (markerId: string): string | undefined => {
    const endsHere = (l: { startAttachment?: LineAttachment; endAttachment?: LineAttachment }) =>
      [l.startAttachment, l.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === markerId)
    return drawings.find((d) => d.kind === 'line' && endsHere(d))?.id
      ?? Object.values(board).flat().find((a) => a.kind === 'draw' && endsHere(a))?.id
  }

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

  // Place a Trupp manually on the building plan (Gebäude floor-stack if a building exists, else
  // Modul 6) as a resource chip the EL can then drag to the team's position. NOT auto-created
  // on registration.
  /** `at`: a known spot on the sheet (the end of the hose the Trupp was just linked to) – the
   *  chip lands there and the view stays where it is; without it the chip lands mid-sheet and
   *  the surface jumps to it (the card's «Platzieren»). Returns the chip's id. */
  /** `revive`: the chip comes BACK as the marker a ghost trail was recorded on («Trupp wieder
   *  platzieren», 20.09.2026) – same id, the walked points on it again. The id is the whole
   *  mechanism: `reconcileGhostTrails` keys on it, so the ghost goes home with its marker in the
   *  next pass and nothing is written for it here (lib/truppTrails). */
  const placeTruppOnPlan = (id: string, targetPlanId?: string, at?: { x: number; y: number; floor: number }, revive?: { id: string; trail: TrailPoint[] }): string | undefined => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr) return
    // explicit target (from the placement picker) wins; else default to the Gebäude
    // floor-stack when a building exists, otherwise Modul 6
    const planId = targetPlanId ?? (building ? gebaeudeDoc.id : 'modul6')
    const annoId = revive?.id ?? newId('trupp')
    const spot = at ?? { x: 0.5, y: 0.5, floor: 0 }
    const chip: BoardAnno = { id: annoId, kind: 'resource', ...spot, text: truppLabel(tr.name), t: formatTime(new Date()), color: teamColor(id), trail: revive?.trail ?? [], truppId: id }
    dropPlacements(tr)
    setBoard((b) => ({ ...b, [planId]: [...(b[planId] ?? []), chip] }))
    updateTrupp(id, { annoId, planId, entityId: undefined })
    if (!at) {
      setMode('plans'); setActivePlanId(planId); setPanel(null)
      setPlanFocus({ ...spot, annoId, nonce: Date.now() })
    }
    // …and WHICH STOREY (18.09.2026). The row already states a place («auf Plan platziert»), and
    // on a Gebäude floor-stack that place is a tile — «Trupp 3 auf Plan platziert» said nothing
    // about the 2. OG the Trupp was actually sent to. Appended rather than templated: the row is
    // the one string the Verlauf, the Rapport and the hash chain all read, and `floorLabel` is
    // already the localised word for it. Off a stack there is no storey to name.
    const onStack = planId === gebaeudeDoc.id
    logPlan('flag', fillTemplate(appConfig.copy.atemschutz.logPlaced, { name: truppLogName(tr, 'leader') })
      + (onStack ? ` · ${floorLabel(spot.floor)}` : ''), { kind: 'team', annoId, ...spot })
    emit('atemschutz.place', { id, annoId, planId })
    void askTruppEntry(id)
    return annoId
  }

  // Place a Trupp on the Lage map (outdoor teams — Verkehrsgruppe, Wasserversorgung, exterior
  // search): a 'team' marker either AT a tapped coord (the map's Trupp tool) or at the current
  // map centre (the Atemschutz card's «Platzieren»), dragged to position like a plan chip.
  // Same one-place rule: placing here removes any plan chip.
  const placeTruppOnMap = (id: string, atCoord?: LngLat, revive?: { id: string; trail: GeoTrailPoint[] }): string | undefined => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr) return
    const entityId = revive?.id ?? newId('trupp')
    const marker: Entity = {
      id: entityId, kind: 'team', layer: appConfig.defaults.operationalLayerId,
      coord: atCoord ?? mapCenter(), label: truppLabel(tr.name), t: formatTime(new Date()),
      color: teamColor(id), trail: revive?.trail ?? [], truppId: id,
    }
    dropPlacements(tr)
    setDocRaw((d) => ({ ...d, entities: [...d.entities, marker] }))
    updateTrupp(id, { entityId, annoId: undefined, planId: undefined })
    setPanel(null)
    // tapped placement is already in view — select without the camera jump
    focusMapEntity(entityId, atCoord ? undefined : marker.coord, !atCoord)
    log('flag', fillTemplate(appConfig.copy.atemschutz.logPlacedMap, { name: truppLogName(tr, 'leader') }), 'team', undefined, entityId)
    emit('atemschutz.place', { id, entityId })
    void askTruppEntry(id)
    return entityId
  }

  /**
   * A Trupp's symbol was just put somewhere — but the board says the crew never went in.
   *
   * Placing the marker is the moment the Überwacher is looking at that Trupp anyway, and the
   * picture already claims the crew is at that spot, so this is where «Einrücken» belongs. It is
   * an ASK, never automatic: a Sicherungstrupp is placed at the vehicle precisely because it is
   * standing by, and starting its contact clock would put a red alarm on a crew nobody sent in.
   *
   * ⚠️ The confirm runs the board's OWN action (setTruppStatus 'aktiv'), so the entry time, the
   * entry reading and the ↶ timeline step are the same ones «Im Einsatz» writes — the clock
   * logic exists once. Declining does nothing at all: the marker stays where it was put.
   */
  const askTruppEntry = async (id: string) => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr || !truppAwaitsEntry(tr)) return
    const az = appConfig.copy.atemschutz
    const ok = await confirmDialog({
      title: az.entryAskTitle,
      message: fillTemplate(az.entryAskMsg, { name: tr.name }),
      confirmLabel: az.actEnter,
      cancelLabel: az.entryAskCancel,
    })
    if (ok) setTruppStatus(id, 'aktiv')
  }

  /**
   * Join an ALREADY PLACED marker to this Trupp — the mirror of linkTruppLine for a symbol.
   *
   * A «Trupp 2» dropped on the Lage at 03:12 and the Atemschutz-Trupp registered at 03:14 are the
   * same crew, and until now nothing could say so: placement was the only way to bind the two, so
   * the marker had to be deleted and re-placed, losing its recorded positions with it. Reachable
   * from both ends (the marker's own panel, the Trupp card's picker) — like a Leitung, the order
   * of doing things is the operator's business.
   *
   * What it writes, in one action because they are two halves of one fact: the marker's anchor
   * (truppId) plus the Trupp's name and colour, and the Trupp's placement ref. The marker's TRAIL
   * survives — it is the same object, and those dots are the Truppverfolgung.
   *
   * A marker somebody else holds ASKS first — the same confirm a Leitung takeover shows, and it
   * lives in here rather than at the two call sites so the two can never drift apart. An Ablösung
   * at the same spot is the normal case; it just has to be said out loud. The previous Trupp lets
   * go of the placement only — its record, its clocks and its readings are untouched.
   */
  const adoptTruppMarker = async (truppId: string, markerId: string): Promise<boolean> => {
    const tr = trupps.find((t) => t.id === truppId)
    if (!tr) return false
    const join = resolveMarkerJoin(markerId, truppId, objects, trupps)
    if (!join) return false
    if (join.own) return true // already this Trupp's symbol — nothing to do, and no takeover
    if (join.holder) {
      const az = appConfig.copy.atemschutz
      const ok = await confirmDialog({
        title: fillTemplate(az.markerTakeTitle, { from: join.holder.name }),
        message: fillTemplate(az.markerTakeMsg, { from: join.holder.name, to: tr.name }),
        confirmLabel: az.markerTakeConfirm,
        cancelLabel: appConfig.copy.cancel,
      })
      if (!ok) return false
    }

    const label = truppLabel(tr.name)
    const color = teamColor(truppId)
    dropPlacements(tr) // one Trupp, one place — whatever it stood on before goes
    // ⚠️ Any OTHER marker still claiming this Trupp lets go of its anchor, the same release
    // linkTruppLine does for a hose: dropPlacements only removes the placement the Trupp knows
    // about, and a merge from a second device can leave a stale one behind.
    setDocRaw((d) => ({
      ...d,
      entities: d.entities.map((e) => (e.id === markerId ? { ...e, truppId, label, color }
        : e.kind === 'team' && e.truppId === truppId ? { ...e, truppId: undefined } : e)),
    }))
    setBoard((b) => Object.fromEntries(Object.entries(b).map(([pid, annos]) => [pid, annos.map((a) => (
      a.id === markerId && a.kind === 'resource' ? { ...a, truppId, text: label, color }
        : a.kind === 'resource' && a.truppId === truppId ? { ...a, truppId: undefined } : a))])))
    // the holder keeps everything except the placement — a Trupp is not «out» because its
    // symbol was taken over, and NOTHING here touches a contact clock
    if (join.holder) updateTrupp(join.holder.id, { entityId: undefined, annoId: undefined, planId: undefined })
    updateTrupp(truppId, join.site.kind === 'map'
      ? { entityId: join.site.entityId, annoId: undefined, planId: undefined }
      : { annoId: join.site.annoId, planId: join.site.planId, entityId: undefined })

    // the same line placing a Trupp writes: what happened IS that this Trupp now stands there,
    // and a second vocabulary for it would only make the Verlauf harder to read
    if (join.site.kind === 'map') log('flag', fillTemplate(appConfig.copy.atemschutz.logPlacedMap, { name: truppLogName(tr, 'leader') }), 'team', undefined, join.site.entityId)
    else logPlan('flag', fillTemplate(appConfig.copy.atemschutz.logPlaced, { name: truppLogName(tr, 'leader') }), { kind: 'team', annoId: join.site.annoId })
    emit('atemschutz.place', { id: truppId, ...(join.site.kind === 'map' ? { entityId: join.site.entityId } : { annoId: join.site.annoId, planId: join.site.planId }) })
    // …and a Leitung that already ends on this symbol becomes this Trupp's — the third way into
    // the same automatic join (15.09.): the hose was coupled to a marker nobody stood on yet, so
    // there was no Trupp to name; binding the marker is the moment there is one.
    const hose = lineEndingOn(markerId)
    if (hose) linkTruppLine(truppId, hose)
    void askTruppEntry(truppId)
    return true
  }

  /**
   * The same gesture from the MARKER's side («Atemschutz-Trupp» → «Kein Trupp»): whoever stands
   * here lets go of the symbol. The marker itself stays exactly where it is, name, colour and
   * trail included — it is still a Trupp in the picture, it just is not THAT Trupp any more (the
   * hose link ends the same way: the Leitung keeps its number and simply has nobody on it).
   */
  const releaseTruppMarker = (markerId: string) => {
    const tr = trupps.find((t) => !t.removedAt && (t.entityId === markerId || t.annoId === markerId))
    setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === markerId ? { ...e, truppId: undefined } : e)) }))
    setBoard((b) => Object.fromEntries(Object.entries(b).map(([pid, annos]) =>
      [pid, annos.map((a) => (a.id === markerId && a.kind === 'resource' ? { ...a, truppId: undefined } : a))])))
    if (!tr) return
    // «Kein Trupp» on a marker a hose is coupled to (15.09.): the crew leaves the picture, so it
    // leaves the Leitung too – the same fact from the marker's side (see settleAtHoseEnd)
    const coupled = drawings.some((l) => l.kind === 'line' && [l.startAttachment, l.endAttachment].some((a) => a?.target.kind === 'object' && a.target.id === markerId))
      || Object.values(board).flat().some((a) => a.kind === 'draw' && [a.startAttachment, a.endAttachment].some((r) => r?.target.kind === 'object' && r.target.id === markerId))
    if (coupled && (tr.lineId || tr.lineNo != null)) unlinkTruppLine(tr.id)
    updateTrupp(tr.id, { entityId: undefined, annoId: undefined, planId: undefined })
    log('flag', fillTemplate(appConfig.copy.atemschutz.logMarkerUnlinked, { name: truppLogName(tr, 'leader') }), 'team', undefined, undefined, { subjectId: tr.id })
    emit('atemschutz.place.unlink', { id: tr.id, markerId })
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

  return { dropPlacements, syncPlacementLabel, placeTruppOnPlan, placeTruppOnMap, askTruppEntry, adoptTruppMarker, releaseTruppMarker, focusTruppOnPlan }
}

export type TruppPlacementActions = ReturnType<typeof truppPlacementActions>
