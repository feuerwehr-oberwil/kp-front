// The Gebäude's own acts on the Plan: picking (or amending) the building under the floor-stack, a
// storey added or removed, and the Drehung. Each is ONE step on the workspace's timeline with its
// confirm-with-undo toast where work is at stake (docs/undo.md). Split out of PlansSurface and
// IncidentWorkspace verbatim; built per render like the Trupp action families (lib/truppActions),
// so every act reads the render's building, board and objects.

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { amendBuilding, buildingPickStep } from '../lib/buildingTransfer'
import { type FloorPackView, floorPackOf, packStoreys, packFloorNames } from '../lib/floorPackBinding'
import { buildView } from '../lib/footprint'
import { fillTemplate } from '../lib/format'
import type { IncidentPlanBinding } from '../lib/incidentPlanBindings'
import { withoutOwnOnStorey, removeStorey } from '../lib/stackFloors'
import { storeySubject, storeyAddedRow, storeyRemovedRow, askStoreyRemoval, storeyRestoredRow } from '../lib/storeyRemoval'
import { type TacticalObject, sheetAnchoredIds, withOwnAnnos } from '../lib/tacticalObjects'
import { confirmDialog } from '../lib/ui'
import { type RecordKey, recordKey, annoRefs } from '../lib/undoKeys'
import type { Dropper } from '../lib/undoTimeline'
import type { SetBoard } from '../lib/useObjectStore'
import { floorLabel } from '../lib/whiteboard'
import type { BoardAnno, BoardDoc, BuildingDoc, SrcGeoref, TimelineEvent } from '../types'
import type { OneShotRows } from './types'

/** One Drehung of the Gebäude is one drag, not forty slider frames — see `reorient`. */
const REORIENT_FOLD_MS = 1500

export interface GebaeudeActionDeps {
  tacticalLocked: boolean
  building: BuildingDoc | null
  setBuilding: Dispatch<SetStateAction<BuildingDoc | null>>
  board: BoardDoc
  setBoard: SetBoard
  objects: TacticalObject[]
  /** the store and the board as they are when a ↶ RUNS, not when the step was made */
  objectsRef: RefObject<TacticalObject[]>
  boardRef: RefObject<BoardDoc>
  floorPack: FloorPackView | null
  planBindings: IncidentPlanBinding[]
  activeObjectId: string | undefined
  setActivePlanId: Dispatch<SetStateAction<string>>
  rememberGebaeudeStep: (label: string, restore: () => void, reapply: () => void, touches: () => readonly RecordKey[] | null, rows?: OneShotRows | 'silent') => Dropper
  oneShotUndoToast: (text: string, label: string, restore: () => void, drop: Dropper, rows?: OneShotRows | 'silent', opts?: { kind?: string }) => number
  logPlan: (icon: string, text: string, extra?: { kind?: TimelineEvent['kind']; annoId?: string; x?: number; y?: number; floor?: number; subjectId?: string }) => void
  /** the Drehung burst still folding into one step — reset by a remote hydrate (useWorkspaceBlob) */
  lastReorient: RefObject<{ at: number; from: BuildingDoc; drop: () => void } | null>
}

export function useGebaeudeActions({
  tacticalLocked, building, setBuilding, board, setBoard, objects, objectsRef, boardRef, floorPack,
  planBindings, activeObjectId, setActivePlanId, rememberGebaeudeStep, oneShotUndoToast, logPlan, lastReorient,
}: GebaeudeActionDeps) {
  /** «Übernehmen» on the Umrisse: the picked footprint(s) become the building under the stack. */
  const selectBuilding = async (src: [number, number][][], orientDeg: number, geo: SrcGeoref) => {
    if (tacticalLocked) return
    // Picking new footprint(s) changes the building under the floor-stack — usually an
    // AMENDMENT (a Nebengebäude added, a wrong footprint dropped), not a fresh start.
    //
    // The markings come along, because they are carried THROUGH THE GROUND: each one
    // goes old tile frame → world position → new tile frame (lib/buildingTransfer ·
    // amendBuilding), so a Brandherd keeps the spot it marks on the earth rather than
    // the spot it occupied in the old rectangle. The storeys come along too — otherwise
    // everything above the ground floor is homeless the moment the new stack starts
    // at [0]. What lands off the new sheet is DROPPED and counted, never clamped: a
    // Trupp pinned to a wall it is not at reads as knowledge, not as a guess.
    //
    // ⚠️ A building picked before `BuildingDoc.geo` existed carries no ground position,
    // so nothing can be anchored and the old rule still holds for it: the markings go,
    // counted and named. Never guessed, never quietly — and the undo is one tap away
    // either way.
    if (!src.length) return
    // ⚠️ Only the stack's OWN ink is carried (24.09.2026). Its view also holds the Karte's
    // objects projected onto it, and those are not the stack's to re-anchor: their ground
    // position is their truth, and the new stack's fit projects them afresh. Carried
    // through the amend they came back «moved» — measured against the fit of the building
    // being replaced, the store has not seen the new one yet — and either flipped onto the
    // stack or, as a machine write, moved on the ground.
    const ownIds = sheetAnchoredIds(objects, 'gebaeude')
    const prevGebaeude = (board.gebaeude ?? []).filter((a) => ownIds.has(a.id))
    const markCount = prevGebaeude.length
    const prevBuilding = building
    const amend = amendBuilding(prevBuilding, { src, orientDeg, geo }, prevGebaeude)
    const owned = new Set([...ownIds, ...amend.annos.map((a) => a.id)])
    const hasWork = !!building && (markCount > 0 || building.floors.length > 1)
    const wb = appConfig.copy.whiteboard
    if (hasWork) {
      const message = amend.legacy
        ? (markCount > 0 ? fillTemplate(wb.replaceBuildingConfirmMarks, { n: markCount }) : wb.replaceBuildingConfirm)
        : amend.dropped > 0 ? fillTemplate(wb.replaceBuildingConfirmCarryDrop, { n: amend.carried, d: amend.dropped })
        : markCount > 0 ? fillTemplate(wb.replaceBuildingConfirmCarry, { n: amend.carried })
        : wb.replaceBuildingConfirmKeep
      const ok = await confirmDialog({
        title: wb.replaceBuilding, message,
        confirmLabel: wb.replaceBuilding, cancelLabel: appConfig.copy.cancel,
        // only a loss is a red button — an amendment that carries everything is not one
        danger: amend.legacy ? markCount > 0 : amend.dropped > 0,
      })
      if (!ok) return
    }
    // auto-orient to longest-axis-horizontal by default; rings/ring/ringAspect
    // mirror the active (oriented) view for back-compat renderers + the north arrow
    const view = buildView(src, orientDeg)
    // a FRESH stack takes its storeys and names from the object's floor pack (decided
    // 14.09.2026); an amendment keeps what the operator already has
    const pack = prevBuilding ? null : floorPackOf(planBindings, activeObjectId)
    const floors = pack?.floors.length ? packStoreys(pack.floors) : amend.floors
    const floorNames = pack ? packFloorNames(pack.floors) : prevBuilding?.floorNames
    const nextBuilding: BuildingDoc = { src, orientDeg, geo, northUp: false, rings: view.rings, ring: view.rings[0], ringAspect: view.aspect, floors, ...(floorNames && Object.keys(floorNames).length ? { floorNames } : {}) }
    setBuilding(nextBuilding)
    // a machine write (`gesture: false`): the amend re-anchors ink, nobody placed it
    setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, owned, amend.annos) }), { gesture: false })
    setActivePlanId('gebaeude') // auto-jump to the floor-stack
    // ⚠️ EVERY pick is its own ↶ step — a first «Übernehmen» too (staging r3, 25.09.2026:
    // ↶ stayed lit on an older Karte step, so the tap meant for the building took back
    // something else). The toast only where work was at stake: it repeats the counts —
    // «Gebäude ersetzt» alone never said what happened (lib/buildingTransfer · buildingPickStep).
    const pick = buildingPickStep(prevBuilding, amend, markCount, hasWork, wb, fillTemplate)
    const restore = () => { setBuilding(prevBuilding); setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, owned, prevGebaeude) }), { gesture: false }) }
    const reapply = () => { setBuilding(nextBuilding); setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, owned, amend.annos) }), { gesture: false }) }
    // the stack, and the stack's OWN annos before and after (never a lent one:
    // withOwnAnnos hands those back untouched) — plus the stack's whole view, so a merge
    // that changed anything drawn on it drops the step rather than sweeping it
    const wrote = () => [recordKey('building'), recordKey('planview', 'gebaeude'),
      ...[...owned, ...prevGebaeude.map((a) => a.id), ...amend.annos.map((a) => a.id)].map((id) => recordKey('objects', id)),
      ...[...prevGebaeude, ...amend.annos].flatMap(annoRefs)]
    // the swap writes no Verlauf row, so neither does taking it back (D6, 26.09.2026)
    const drop = rememberGebaeudeStep(pick.label, restore, reapply, wrote, 'silent')
    if (pick.toast) oneShotUndoToast(pick.label, pick.label, restore, drop, 'silent')
  }

  /** «+ OG» / «+ UG»: a storey on top or underneath. */
  const addFloor = (dir: 1 | -1) => {
    if (tacticalLocked || !building || building.pack) return
    const prevBuilding = building
    const newFloor = dir > 0 ? Math.max(...building.floors) + 1 : Math.min(...building.floors) - 1
    const nextBuilding = { ...prevBuilding, floors: dir > 0 ? [...prevBuilding.floors, newFloor] : [newFloor, ...prevBuilding.floors] }
    setBuilding(nextBuilding)
    // confirm-with-undo (standing rule): the undo also sweeps any annotation already
    // dropped on the brand-new storey so nothing orphans — the stack's OWN only
    // (24.09.2026): a Karte object shown on the new storey is the Karte's, and dropped from
    // the view it was deleted outright (see onRemoveFloor)
    const restore = () => {
      setBuilding(prevBuilding)
      setBoard((b) => ({ ...b, gebaeude: withoutOwnOnStorey(b.gebaeude ?? [], sheetAnchoredIds(objectsRef.current, 'gebaeude'), newFloor) }), { gesture: false })
    }
    // the stack, and whatever of the stack's own now stands on the new storey — read when a
    // merge asks, since that is what the sweep in `restore` would take (plus the view)
    const wrote = () => {
      const own = sheetAnchoredIds(objectsRef.current, 'gebaeude')
      const swept = (boardRef.current.gebaeude ?? []).filter((a) => own.has(a.id) && (a.floor ?? 0) === newFloor)
      return [recordKey('building'), recordKey('planview', 'gebaeude'), ...swept.map((a) => recordKey('objects', a.id)), ...swept.flatMap(annoRefs)]
    }
    // …and it says so, the way the removal does («Deleting and creating belong in the same
    // channel»): «Geschoss 4. OG hinzugefügt», taken back as «… entfernt», per storey
    const subject = { subjectId: storeySubject(newFloor) }
    const addedRow = () => logPlan('plus', storeyAddedRow(floorLabel(newFloor)), subject)
    const rows: OneShotRows = { undo: () => logPlan('undo', storeyRemovedRow(floorLabel(newFloor), 0), subject), redo: addedRow }
    // the toast and the ↶ NAME the storey («2. OG hinzugefügt»), and a second «+ OG» replaces
    // the first toast instead of stacking another identical pill (#232, 3am test r4, 26.09.2026)
    const line = fillTemplate(appConfig.copy.whiteboard.floorAddedToast, { floor: floorLabel(newFloor) })
    const drop = rememberGebaeudeStep(line, restore, () => setBuilding(nextBuilding), wrote, rows)
    oneShotUndoToast(line, line, restore, drop, rows, { kind: 'gebaeude-storey' })
    addedRow()
  }

  /** A storey taken off the stack, with what stood on it. */
  const removeFloor = async (floor: number) => {
    if (tacticalLocked || building?.pack || floorPack?.tiles[floor]) return
    const prevBuilding = building
    const nextBuilding = prevBuilding ? { ...prevBuilding, floors: prevBuilding.floors.filter((f) => f !== floor) } : prevBuilding
    // ⚠️ Only the stack's OWN annos are swept (24.09.2026). The view also shows the Karte's
    // objects projected onto their storey, and those are not the storey's: handed back
    // untouched (`withOwnAnnos`) they fold to nothing, stay on the Karte, and simply find no
    // tile once the storey is gone. The sweep used to run over the whole view — and an
    // absent anno is a deletion, so every Karte Fahrzeug shown on the storey went with it.
    // ⚠️ Computed HERE, as values the closures keep: the timeline's ↷ has to put back
    // exactly the stack this removal produced, not re-run a sweep against a document that
    // has moved on since.
    const sweep = removeStorey(board.gebaeude ?? [], sheetAnchoredIds(objects, 'gebaeude'), floor, nextBuilding?.floors ?? [])
    // asks only about what the sweep LOSES — own annos deleted or cut short, never a Karte
    // object shown here — and not at all when that is nothing; the toast undoes either way
    if (!await askStoreyRemoval(sweep.lost, floorLabel(floor))) return
    // a machine write (`gesture: false`) — a sweep of what stood on the storey, no placement
    const writeOwn = (own: BoardAnno[]) => setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, sweep.owned, own) }), { gesture: false })
    setBuilding(nextBuilding)
    writeOwn(sweep.after)
    // confirm-with-undo: the removed storey's annotations come back with it
    const restore = () => { setBuilding(prevBuilding); writeOwn(sweep.before) }
    const reapply = () => { setBuilding(nextBuilding); writeOwn(sweep.after) }
    // …and the act's OWN rows (staging 25.09.2026: the Verlauf held only «… rückgängig
    // gemacht», never the removal it took back, and the toast's undo wrote nothing at all)
    // — «Geschoss 3. OG entfernt», and «… wiederhergestellt» when it comes back, by the
    // toast or by ↶ alike; ↷ says «entfernt» again
    // ⚠️ each row names its STOREY as its subject (D6, 26.09.2026): without one, the repeat
    // fold matched «entfernt» across the «wiederhergestellt» between them and printed
    // «Geschoss 3. OG entfernt 2×», and two different storeys could fold into one
    const removedRow = storeyRemovedRow(floorLabel(floor), sweep.lost)
    const subject = { subjectId: storeySubject(floor) }
    const rows: OneShotRows = {
      undo: () => logPlan('undo', storeyRestoredRow(floorLabel(floor)), subject),
      redo: () => logPlan('close', removedRow, subject),
    }
    const wrote = () => [recordKey('building'), recordKey('planview', 'gebaeude'),
      ...[...sweep.owned, ...sweep.before.map((a) => a.id), ...sweep.after.map((a) => a.id)].map((id) => recordKey('objects', id)),
      ...[...sweep.before, ...sweep.after].flatMap(annoRefs)]
    const drop = rememberGebaeudeStep(appConfig.copy.whiteboard.floorRemoved, restore, reapply, wrote, rows)
    oneShotUndoToast(appConfig.copy.whiteboard.floorRemoved, appConfig.copy.whiteboard.floorRemoved, restore, drop, rows)
    logPlan('close', removedRow, subject)
  }

  /** The Gebäude's Drehung from the Plan (Whiteboard · onReorient) — one drag, one step. */
  const reorient = (next: BuildingDoc) => {
    // The Drehung is a SLIDER with a live preview, so it writes many times per drag: one
    // burst is one step, and the step goes back to the angle the drag started from — the
    // same fold the Bildlegende uses, for the same reason. It matters beyond the screen,
    // because the printed Geschossseiten come out at whatever angle is set.
    const now = Date.now()
    const prev = lastReorient.current
    const folding = !!prev && now - prev.at <= REORIENT_FOLD_MS
    const from = folding ? prev.from : building
    if (folding) prev.drop()
    setBuilding(next)
    if (!from) return
    const drop = rememberGebaeudeStep(appConfig.copy.whiteboard.orientMenuTitle, () => setBuilding(from), () => setBuilding(next), () => [recordKey('building')], 'silent')
    lastReorient.current = { at: now, from, drop }
  }

  return { selectBuilding, addFloor, removeFloor, reorient }
}
