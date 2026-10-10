// The Plan surface: the lazy Whiteboard over the active plan document, with everything it reads
// from and writes back to the Einsatz (the tactical store's `board`, the plan histories, the
// Trupps, the Georeferenz). Split out of IncidentWorkspace (E1, 09.10.2026) verbatim; mounted
// only while `mode === 'plans'` — which is why the plan STACKS live in the workspace, not here.

import { type ReactNode, type Dispatch, type SetStateAction, type RefObject, Suspense } from 'react'
import type { JSX } from 'react/jsx-runtime'
import { LoadingStatus } from '../components/ShellLoader'
import type { BoardHistory } from '../components/useBoardDoc'
import type { BoardViews } from '../components/useBoardView'
import { appConfig } from '../config/appConfig'
import { gebaeudeDoc } from '../data/demoIncident'
import type { AtemschutzAlarmState } from '../lib/atemschutz'
import type { AuthUser } from '../lib/auth'
import { amendBuilding, buildingPickStep } from '../lib/buildingTransfer'
import { type FloorPackView, floorPackOf, packStoreys, packFloorNames } from '../lib/floorPackBinding'
import { buildView } from '../lib/footprint'
import { fillTemplate } from '../lib/format'
import type { GeorefPlan } from '../lib/georefTwins'
import type { IncidentPlanBinding } from '../lib/incidentPlanBindings'
import type { IncidentMeta } from '../lib/incidents'
import type { LiveMark, PhotoMark } from '../lib/planProjection'
import type { PlanStepLink } from '../lib/planStepLink'
import { type RailLabels, type SymbolSurface, planSymbolScale } from '../lib/prefs'
import { withoutOwnOnStorey, removeStorey } from '../lib/stackFloors'
import { storeySubject, storeyAddedRow, storeyRemovedRow, askStoreyRemoval, storeyRestoredRow } from '../lib/storeyRemoval'
import { type TacticalObject, sheetAnchoredIds, withOwnAnnos } from '../lib/tacticalObjects'
import { type TruppTrail, planGhostTrails } from '../lib/truppTrails'
import { confirmDialog } from '../lib/ui'
import { type RecordKey, recordKey, annoRefs } from '../lib/undoKeys'
import type { Dropper } from '../lib/undoTimeline'
import type { useBuildingInfo } from '../lib/useBuildingInfo'
import type { useIsPhone } from '../lib/useIsPhone'
import { BUILDING_PICK_ID } from '../lib/useObjectPlans'
import type { SetBoard } from '../lib/useObjectStore'
import type { useSymbols } from '../lib/useSymbols'
import { floorLabel } from '../lib/whiteboard'
import type { PlanScales } from '../lib/workspace'
import type { PlanDocument, LngLat, Incident, BoardDoc, BuildingDoc, TimelineEvent, Entity, Trupp, LineAttachment, BoardAnno, CaptionMode } from '../types'
import { Whiteboard } from './lazySurfaces'
import type { OneShotRows, WorkspaceMode } from './types'

export interface PlansSurfaceProps {
  mode: WorkspaceMode
  sym: ReturnType<typeof useSymbols>
  guarded: (surface: string, node: ReactNode, toMap?: boolean) => JSX.Element
  railLabels: RailLabels
  planDocs: PlanDocument[]
  tacticalLocked: boolean
  isPhone: ReturnType<typeof useIsPhone>
  journalOpen: boolean
  replayActive: boolean
  linkScoped: boolean
  activePlanId: string
  activeObjectName: string | null
  activeObjectAddress: string | null
  buildingInfo: ReturnType<typeof useBuildingInfo>
  activeObjectNearby: { objectId: string; distanceM: number } | null
  incidentMeta: IncidentMeta
  activeObjectPos: LngLat | null
  incidentView: Incident
  isEl: boolean
  setPickerOpen: Dispatch<SetStateAction<boolean>>
  symbolScale: Record<SymbolSurface, number>
  activeLinkedPlan: GeorefPlan | null
  symbolCaptions: CaptionMode
  mapSuppressedCaptions: ReadonlySet<string>
  planLive: LiveMark[]
  planPhotos: PhotoMark[]
  moveLiveOnSheet: (entityId: string, coord: LngLat, phase: 'start' | 'move' | 'end') => void
  showPlanSourceOnMap: (_planId: string, annoId: string, coord: LngLat) => void
  replayBoard: BoardDoc | null
  board: BoardDoc
  trails: TruppTrail[]
  deleteGhostTrail: (id: string) => Promise<void>
  armTrailDrop: (sourceId: string, on: boolean) => void
  setBoard: SetBoard
  replayBuilding: BuildingDoc | null
  building: BuildingDoc | null
  floorPack: FloorPackView | null
  objects: TacticalObject[]
  planBindings: IncidentPlanBinding[]
  activeObjectId: string | undefined
  setBuilding: Dispatch<SetStateAction<BuildingDoc | null>>
  setActivePlanId: Dispatch<SetStateAction<string>>
  rememberGebaeudeStep: (label: string, restore: () => void, reapply: () => void, touches: () => readonly RecordKey[] | null, rows?: OneShotRows | 'silent') => Dropper
  oneShotUndoToast: (text: string, label: string, restore: () => void, drop: Dropper, rows?: OneShotRows | 'silent', opts?: { kind?: string }) => number
  onReorient: (next: BuildingDoc) => void
  objectsRef: RefObject<TacticalObject[]>
  boardRef: RefObject<BoardDoc>
  logPlan: (icon: string, text: string, extra?: { kind?: TimelineEvent['kind']; annoId?: string; x?: number; y?: number; floor?: number; subjectId?: string }) => void
  rosterNames: string[]
  rosterRank: { [k: string]: string | undefined }
  linkRosterFields: (prev: Entity, fields: Record<string, string>, opts?: { force?: boolean }) => void
  personStatus: (name: string) => { label: string; tone?: 'warn' | 'muted' | 'info' } | undefined
  rosterFieldHints: (e: Entity | undefined) => Record<string, string | undefined> | undefined
  addRecent: (name: string) => void
  user: AuthUser | null
  emit: (op_type: string, payload?: Record<string, unknown>, opts?: { observed?: string }) => void
  planHist: RefObject<{ undo: (expect?: string) => boolean; redo: (expect?: string) => boolean } | null>
  planHistory: BoardHistory
  setPlanHistory: Dispatch<SetStateAction<BoardHistory>>
  rememberPlanStep: (planId: string, step: string) => void
  planStepLink: RefObject<PlanStepLink | null>
  endSheetStep: () => void
  onPlanStepLabel: (label: string) => void
  planViews: RefObject<BoardViews>
  planFit: RefObject<(() => void) | null>
  planKeys: RefObject<{ pickTool: (tool: string) => void; zoom: (f: number) => void; duplicate: () => void } | null>
  planFocus: { x: number; y: number; floor: number; annoId?: string; twinEntityId?: string; flash?: boolean; nonce: number } | null
  effTrupps: Trupp[]
  truppCounterNames: (exceptId?: string) => (string | undefined)[]
  teamNameTaken: (id: string, label: string) => boolean
  azAlarm: AtemschutzAlarmState
  updateTrupp: (id: string, patch: Partial<Trupp>) => void
  askTruppEntry: (id: string) => Promise<void>
  adoptTruppMarker: (truppId: string, markerId: string) => Promise<boolean>
  releaseTruppMarker: (markerId: string) => void
  newTruppFromMarker: (markerId: string) => void
  linkTruppLine: (truppId: string, lineId: string) => boolean
  unlinkLine: (lineId: string) => void
  linkLineToAttachedTrupp: (lineId: string, attachment: LineAttachment | undefined) => boolean
  unlinkLineFromDetachedTrupp: (lineId: string, previous: LineAttachment | undefined) => boolean
  syncLineNoToTrupp: (lineId: string, lineNo: number | undefined) => void
  setMode: Dispatch<SetStateAction<WorkspaceMode>>
  setPanel: Dispatch<SetStateAction<'layers' | null>>
  setTruppFocus: Dispatch<SetStateAction<{ id: string; nonce: number } | null>>
  planScale: PlanScales
  setPlanScale: Dispatch<SetStateAction<PlanScales>>
}

export function PlansSurface({
  mode, sym, guarded, railLabels, planDocs, tacticalLocked, isPhone, journalOpen, replayActive,
  linkScoped, activePlanId, activeObjectName, activeObjectAddress, buildingInfo, activeObjectNearby,
  incidentMeta, activeObjectPos, incidentView, isEl, setPickerOpen, symbolScale, activeLinkedPlan,
  symbolCaptions, mapSuppressedCaptions, planLive, planPhotos, moveLiveOnSheet, showPlanSourceOnMap,
  replayBoard, board, trails, deleteGhostTrail, armTrailDrop, setBoard, replayBuilding, building,
  floorPack, objects, planBindings, activeObjectId, setBuilding, setActivePlanId, rememberGebaeudeStep,
  oneShotUndoToast, onReorient, objectsRef, boardRef, logPlan, rosterNames, rosterRank,
  linkRosterFields, personStatus, rosterFieldHints, addRecent, user, emit, planHist, planHistory,
  setPlanHistory, rememberPlanStep, planStepLink, endSheetStep, onPlanStepLabel, planViews, planFit,
  planKeys, planFocus, effTrupps, truppCounterNames, teamNameTaken, azAlarm, updateTrupp,
  askTruppEntry, adoptTruppMarker, releaseTruppMarker, newTruppFromMarker, linkTruppLine, unlinkLine,
  linkLineToAttachedTrupp, unlinkLineFromDetachedTrupp, syncLineNoToTrupp, setMode, setPanel,
  setTruppFocus, planScale, setPlanScale,
}: PlansSurfaceProps) {
  return (
    <>
      {/* like the map: mounted once the pack has loaded OR failed for good (empty glyph table) */}
      {mode === 'plans' && (sym.ready || sym.error) && guarded('board', (
        /* the chunk is prefetched on idle (loadWhiteboard); on the rare cold switch the fallback is
           the paper frame with the shared loading state */
        <Suspense fallback={<div className="whiteboard"><div className="workspace-loading"><LoadingStatus size="surface">{appConfig.copy.loading}</LoadingStatus></div></div>}><Whiteboard
          railLabels={railLabels}
          plans={planDocs}
          // on desktop the Verlauf drawer docks beside the plan's tool rail (same as the
          // map), so the rail + its zoom/fit footer stay live. Only a phone still parks
          // the plan read-only while Verlauf is open (there it's a full-width bottom sheet).
          readOnly={tacticalLocked || (isPhone && journalOpen)}
          // …but a locked plan still offers the tool that changes nothing (Auswahl; the plan
          // lost Messen 29.08.). Not during replay (the scrubber owns the bottom band) and not
          // behind the phone's Verlauf sheet, which parks the plan entirely.
          slimTools={!replayActive && !(isPhone && journalOpen)}
          // Einsatz-Link session: the bottom-left setting chips (Maßstab / Verknüpft) are the
          // ORIGIN's instruments — an outside viewer can set nothing, so no doors to settings.
          linkViewer={linkScoped}
          activeId={activePlanId}
          // which object's plans these are — named on the Plan surface itself (it decides what
          // the rail lists). A link session is bound to one object, so it gets no switch.
          objectName={activeObjectName}
          objectAddress={activeObjectAddress}
          buildingInfo={buildingInfo}
          // only the AUTO-surfaced object can be «merely nearby»; a manual pick is the operator's
          objectNearby={activeObjectNearby}
          incidentId={incidentMeta.id}
          incidentAddress={incidentMeta.address}
          // the anchor «Automatisch ausrichten» fetches its OSM reference box around: the active
          // object's own coordinate, else the Einsatzort (they coincide for a near object)
          georefAnchor={activeObjectPos ?? incidentView.center}
          // the Einsatzort on the Gebäude picker — only a REAL coordinate (0/0 is Divera's «none»)
          incidentPos={incidentMeta.lng != null && incidentMeta.lat != null && (incidentMeta.lng !== 0 || incidentMeta.lat !== 0) ? [incidentMeta.lng, incidentMeta.lat] : null}
          // not for el: the pick is `pickedObjectId` in the shared blob, which its record slice
          // never pushes — the switch would hold on this device until the next hydrate
          onObjectSwitch={linkScoped || isEl ? undefined : () => setPickerOpen(true)}
          // A georeferenced Modul has the Karte's real scale, so its tactical symbols follow the
          // Karte setting too. Standalone sheets keep the independent Modul preference.
          symMul={planSymbolScale(symbolScale, !!activeLinkedPlan)}
          captionMode={symbolCaptions}
          mapSuppressedCaptions={mapSuppressedCaptions}
          // …and the half of the Karte that is NOT a record: the live feed, drawn on the paper
          // and editable only in the one way it is on the Karte — a dropped Fahrzeug is «hier
          // ist es wirklich». Everything else the Karte holds arrives in `annos` as an object.
          live={planLive}
          photos={planPhotos}
          onPlanLiveMove={tacticalLocked ? undefined : moveLiveOnSheet}
          onPlanProjection={showPlanSourceOnMap}
          /* ⚠️ REPLAY shows the recorded sheet and nothing else. `replayBoard` is the anno list as
             it was written down, so a plan-drawn object appears exactly as it was — but a Karte
             object standing beside it does NOT, because its place on this paper is derived and
             the derivation would use TODAY's fit on yesterday's record. Absent is the honest
             answer until replay carries the projection it was recorded with (phase 4). */
          annos={(replayActive ? replayBoard : board)?.[activePlanId] ?? []}
          /* ⚠️ Not during replay: a ghost trail is today's record of a removal, and the replayed
             sheet is what was on the screen at the recorded moment (lib/replay stays VIEW-based). */
          ghostTrails={replayActive ? [] : planGhostTrails(trails, activePlanId)}
          onGhostTrail={tacticalLocked ? undefined : (id) => void deleteGhostTrail(id)}
          // «Marker und Spur löschen» on a chip: arm the ghosting to write it already deleted
          onTrailDrop={tacticalLocked ? undefined : armTrailDrop}
          onChange={(next, opts) => { if (tacticalLocked) return; setBoard((b) => ({ ...b, [activePlanId]: next }), opts) }}
          building={replayActive ? replayBuilding : building}
          floorPack={floorPack}
          onSelectBuilding={async (src, orientDeg, geo) => {
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
          }}
          // the two faces of the ONE «Gebäude» rail tile. Both plan ids stay real documents —
          // this only moves the active one, which is what makes the merged tile navigable at all
          // (railPlanTiles reads activePlanId to decide which face the tile wears).
          onBuildingFace={(face) => setActivePlanId(face === 'pick' ? BUILDING_PICK_ID : gebaeudeDoc.id)}
          onReorient={onReorient}
          onAddFloor={(dir) => {
            if (!building || building.pack) return
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
          }}
          onRemoveFloor={async (floor) => {
            if (building?.pack || floorPack?.tiles[floor]) return
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
          }}
          sym={sym}
          rosterNames={rosterNames}
          rosterRank={rosterRank}
          onRosterField={(symbol, label, key, name) => linkRosterFields({ symbol, label } as Entity, { [key]: name })}
          // the same two roster read-outs the Lage's symbol panel has shown all along: who that
          // name already is ON the dropdown entry, and the contradiction a filled field carries
          // UNDER it. A plan symbol is not an Entity, so the hint call is fed its parts.
          personStatus={personStatus}
          fieldHints={(symbol, label, fields) => rosterFieldHints({ kind: 'symbol', symbol, label, fields } as Entity)}
          // Symbol→Mittel on the plan, with the Lage's exact gate and the shared count: a TLF
          // placed on Modul 1 books onto the Material sheet like one placed on the Karte
          onRecent={addRecent}
          log={logPlan}
          authorName={user?.display_name}
          emit={emit}
          historyRef={planHist}
          hist={planHistory}
          setHist={setPlanHistory}
          onCheckpoint={rememberPlanStep}
          onStepEnd={() => { planStepLink.current?.closed(); endSheetStep() }}
          onStepLabel={onPlanStepLabel}
          views={planViews}
          fitRef={planFit}
          keysRef={planKeys}
          focus={planFocus}
          trupps={effTrupps}
          // the Karte's markers, the other plans' chips, the ghost trails and every Trupp ever
          // registered (its `trupps` prop leaves the removed ones out), for the one Trupp counter
          placedTeamNames={() => truppCounterNames()}
          teamNameTaken={teamNameTaken}
          truppSeverities={azAlarm.severities}
          // the plan's Trupp tool placed a chip FOR a Trupp — same ask as every other placement:
          // the picture now says the crew is there, so «einrücken?» belongs here (askTruppEntry)
          onLinkTrupp={(annoId, truppId) => { updateTrupp(truppId, { annoId, planId: activePlanId }); void askTruppEntry(truppId) }}
          // …and the chip's half of the join, joined from the picture rather than from the card —
          // the identical wiring the map marker's menu gets, through the identical action, so the
          // takeover confirm and the «einrücken?» ask exist exactly once for both surfaces
          onTeamTrupp={tacticalLocked ? undefined : (annoId, truppId) => {
            if (truppId) void adoptTruppMarker(truppId, annoId)
            else releaseTruppMarker(annoId)
          }}
          onTeamNewTrupp={tacticalLocked ? undefined : newTruppFromMarker}
          onLinkLineTrupp={(annoId, truppId) => (truppId ? linkTruppLine(truppId, annoId) : unlinkLine(annoId))}
          // a Leitung end snapped onto a Trupp's chip IS the Leitung pick (15.09.) — the same
          // call the Karte makes from its own magnet (lib/useMapDrawing · onLineAttached)
          onLineAttached={(annoId, attachment) => { linkLineToAttachedTrupp(annoId, attachment) }}
          onLineDetached={(annoId, previous) => { unlinkLineFromDetachedTrupp(annoId, previous) }}
          onLineRenumber={syncLineNoToTrupp}
          // the plan chip's twin of the map marker's jump — it points at the card too
          onShowTrupp={(truppId) => { setMode('atemschutz'); setPanel(null); setTruppFocus({ id: truppId, nonce: Date.now() }) }}
          planScale={planScale}
          onCalibrate={(planId, sc) => { if (tacticalLocked) return; setPlanScale((m) => { if (!sc) { const { [planId]: _drop, ...rest } = m; return rest } return { ...m, [planId]: sc } }) }}
        /></Suspense>
      ))}
    </>
  )
}
