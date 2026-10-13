// The Karte itself: the MapView with the tactical picture (or the reconstructed past during a
// replay), the live vehicles and crew, the reference layers and the linked plans' rasters — or
// the boot placeholder while the symbol pack loads. Split out of IncidentWorkspace (E1,
// 09.10.2026) verbatim; every writer it calls is the workspace's and comes in as a prop.

import type { KarteWeather } from './useKarteWeather'
import type { ReactNode, RefObject, Dispatch, SetStateAction } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import type { JSX } from 'react/jsx-runtime'
import { MapView } from '../components/MapView'
import { Splash } from '../components/Splash'
import { appConfig } from '../config/appConfig'
import type { AtemschutzAlarmState } from '../lib/atemschutz'
import { fillTemplate } from '../lib/format'
import type { SymbolSurface } from '../lib/prefs'
import { SHAPE_TWO_POINT } from '../lib/shapes'
import { type TruppTrail, mapGhostTrails } from '../lib/truppTrails'
import { undoToast } from '../lib/ui'
import { recordKey } from '../lib/undoKeys'
import type { useCoordPicker } from '../lib/useCoordPicker'
import type { useMeasure } from '../lib/useMeasure'
import type { useSymbols } from '../lib/useSymbols'
import type { VehicleOverrides } from '../lib/useVehicleLayer'
import type { Doc } from '../lib/workspace'
import type { Entity, LayerDef, Incident, LngLat, Trupp, TimelineEvent, PreparedMapOverlay, LayerId, Drawing, LineAttachment, LineEndpoint, ShapeKind, CaptionMode } from '../types'
import type { WorkspaceMode } from './types'

export interface MapStageProps {
  sym: ReturnType<typeof useSymbols>
  guarded: (surface: string, node: ReactNode, toMap?: boolean) => JSX.Element
  mapRef: RefObject<MapRef | null>
  mapEntities: Entity[]
  tacticalLocked: boolean
  mapLayers: LayerDef[]
  symbolScale: Record<SymbolSurface, number>
  symbolCaptions: CaptionMode
  setMapSuppressedCaptions: Dispatch<SetStateAction<ReadonlySet<string>>>
  incidentView: Incident
  initialFitPoints: LngLat[] | undefined
  locateReq: number
  editNoteId: string | null
  noteTextLive: (id: string, v: string) => void
  noteTextCommit: (id: string, v: string) => void
  setSelectedId: Dispatch<SetStateAction<string | null>>
  setSelectedDrawingId: Dispatch<SetStateAction<string | null>>
  setEditNoteId: Dispatch<SetStateAction<string | null>>
  tool: string
  setNotePanelId: Dispatch<SetStateAction<string | null>>
  effTrupps: Trupp[]
  azAlarm: AtemschutzAlarmState
  setMode: Dispatch<SetStateAction<WorkspaceMode>>
  setPanel: Dispatch<SetStateAction<'layers' | null>>
  setTruppFocus: Dispatch<SetStateAction<{ id: string; nonce: number } | null>>
  adoptTruppMarker: (truppId: string, markerId: string) => Promise<boolean>
  releaseTruppMarker: (markerId: string) => void
  newTruppFromMarker: (markerId: string) => void
  markTeamPosition: (id: string) => void
  renameTeam: (id: string, name: string) => void
  clearTeamTrail: (id: string) => Promise<void>
  removeTeamWithTrail: (id: string) => Promise<void>
  trails: TruppTrail[]
  deleteGhostTrail: (id: string) => Promise<void>
  doc: Doc
  unlinkTruppLine: (truppId: string) => void
  patchEntity: (id: string, patch: Partial<Entity>) => void
  linkTruppLine: (truppId: string, lineId: string) => boolean
  log: (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string, opts?: { rowId?: string; subjectId?: string }) => void
  mapOverlays: PreparedMapOverlay[]
  finishSelection: () => void
  georefPlanRasters: { id: string; url: string; opacity: number; coordinates: [[number, number], [number, number], [number, number], [number, number]] }[]
  /** the «Niederschlag (Radar)» layer while it is on (workspace/useKarteWeather · mapRadar) */
  weatherRadar: KarteWeather['mapRadar']
  isVisible: (id: LayerId) => boolean
  selectedId: string | null
  measure: ReturnType<typeof useMeasure>
  setSelectedDrawIds: Dispatch<SetStateAction<string[]>>
  setSelectedEntityIds: Dispatch<SetStateAction<string[]>>
  onMapClick: (c: LngLat) => void
  drawings: Drawing[]
  draft: LngLat[]
  areaMode: 'freehand' | 'nodes'
  lineNodes: boolean
  setDraft: (action: SetStateAction<LngLat[]>) => void
  setDraftPointAttachment: (attachment?: LineAttachment) => void
  startEntityMove: (id: string) => void
  streamEntityMove: (id: string, c: LngLat) => void
  finishEntityMove: (id: string, c: LngLat, join?: { lineId: string; endpoint: LineEndpoint } | null, dock?: { hostId: string } | null) => void
  setVehicleOverrides: Dispatch<SetStateAction<VehicleOverrides>>
  beginDrag: () => void
  setDocRaw: (update: SetStateAction<Doc>, opts?: { gesture?: boolean; movedIds?: readonly string[] }) => void
  endDrag: () => void
  setView: Dispatch<SetStateAction<{ bearing: number; center: LngLat; zoom: number }>>
  onBasemapUnavailable: () => void
  onMapSettled: () => void
  coord: ReturnType<typeof useCoordPicker>
  pendingShape: ShapeKind | null
  rotStart: LngLat | null
  freehandKind: 'line' | 'area' | null
  onFreehand: (coords: LngLat[], attachments?: { startAttachment?: LineAttachment; endAttachment?: LineAttachment }) => Drawing | null
  createCircle: (center: LngLat, radiusM: number) => void
  drawColor: string
  drawWidth: number
  drawDashed: boolean
  selectedDrawingId: string | null
  flashDrawingId: string | null
  setDrawTap: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>
  patchDrawingById: (id: string, patch: Partial<Drawing>) => void
  commit: (updater: (d: Doc) => Doc, opts?: { gesture?: boolean }) => void
  deleteEntity: (id: string) => Promise<boolean>
  selectedDrawing: Drawing | null
  editDrawingCoords: (id: string, coords: LngLat[], phase: 'start' | 'move' | 'end') => void
  editDrawingRadius: (id: string, radiusM: number, phase: 'start' | 'move' | 'end') => void
  insertDrawingVertex: (id: string, index: number, c: LngLat) => void
  deleteDrawingVertex: (id: string, index: number) => void
  setDrawingAttachment: (id: string, endpoint: LineEndpoint, attachment: LineAttachment | undefined, fallback: LngLat) => void
  moveLabel: (id: string, at: LngLat | null, phase: 'start' | 'move' | 'end', which?: 'label' | 'end') => void
  selectedDrawIds: string[]
  selectedEntityIds: string[]
  onMarquee: (drawIds: string[], entIds: string[]) => void
  transformGroup: (ids: string[], entIds: string[], t: { dLng: number; dLat: number; deg: number }, phase: 'start' | 'move' | 'end') => void
}

export function MapStage({
  sym, guarded, mapRef, mapEntities, tacticalLocked, mapLayers, symbolScale, symbolCaptions,
  setMapSuppressedCaptions, incidentView, initialFitPoints, locateReq, editNoteId, noteTextLive,
  noteTextCommit, setSelectedId, setSelectedDrawingId, setEditNoteId, tool, setNotePanelId, effTrupps,
  azAlarm, setMode, setPanel, setTruppFocus, adoptTruppMarker, releaseTruppMarker, newTruppFromMarker,
  markTeamPosition, renameTeam, clearTeamTrail, removeTeamWithTrail, trails, deleteGhostTrail, doc,
  unlinkTruppLine, patchEntity, linkTruppLine, log, mapOverlays, finishSelection, georefPlanRasters, weatherRadar,
  isVisible, selectedId, measure, setSelectedDrawIds, setSelectedEntityIds, onMapClick, drawings,
  draft, areaMode, lineNodes, setDraft, setDraftPointAttachment, startEntityMove, streamEntityMove,
  finishEntityMove, setVehicleOverrides, beginDrag, setDocRaw, endDrag, setView, onBasemapUnavailable,
  onMapSettled, coord, pendingShape, rotStart, freehandKind, onFreehand, createCircle, drawColor,
  drawWidth, drawDashed, selectedDrawingId, flashDrawingId, setDrawTap, patchDrawingById, commit,
  deleteEntity, selectedDrawing, editDrawingCoords, editDrawingRadius, insertDrawingVertex,
  deleteDrawingVertex, setDrawingAttachment, moveLabel, selectedDrawIds, selectedEntityIds, onMarquee,
  transformGroup,
}: MapStageProps) {
  return (
    <>
      {/* the map mounts once the pack has loaded OR failed for good — with an empty glyph table a
          symbol renders as its empty chip, which beats a splash that never ends (02.09.) */}
      {(sym.ready || sym.error) ? guarded('map', (
        <MapView
          ref={mapRef}
          entities={mapEntities}
          readOnly={tacticalLocked}
          layers={mapLayers}
          byName={sym.byName}
          symMul={symbolScale.map}
          captionMode={symbolCaptions}
          onCaptionSuppressionChange={setMapSuppressedCaptions}
          initialCenter={incidentView.center}
          fitPoints={initialFitPoints}
          locateNonce={locateReq}
          editNoteId={editNoteId}
          onNoteText={noteTextLive}
          onNoteCommit={noteTextCommit}
          onNoteEdit={tacticalLocked ? undefined : (id) => { setSelectedId(id); setSelectedDrawingId(null); setEditNoteId(id) }}
          // the ⚙ stays on a locked surface — it opens the note READ-ONLY (a long note is
          // truncated on the map, and reading it is not editing it)
          onNotePanel={(id) => {
            if (tool === 'measure') return // the tap already landed as a measuring point (onSelect)
            setNotePanelId(id)
          }}
          trupps={effTrupps}
          truppSeverities={azAlarm.severities}
          // …and it LANDS on the card: the board can be a wall of Trupps, so «Im Atemschutz
          // zeigen» points at the one that was tapped (same gesture as the alarm row's «Zum
          // Trupp»). Without the focus the jump answered «which one is this?» with a list.
          onShowTrupp={(truppId) => { setMode('atemschutz'); setPanel(null); setTruppFocus({ id: truppId, nonce: Date.now() }) }}
          // the marker's half of the Trupp join — the same action the Atemschutz card's picker
          // calls, so the takeover confirm and the «einrücken?» ask exist exactly once
          onTeamTrupp={tacticalLocked ? undefined : (entityId, truppId) => {
            if (truppId) void adoptTruppMarker(truppId, entityId)
            else releaseTruppMarker(entityId)
          }}
          onTeamNewTrupp={tacticalLocked ? undefined : newTruppFromMarker}
          onTeamMark={tacticalLocked ? undefined : markTeamPosition}
          onTeamRename={tacticalLocked ? undefined : renameTeam}
          onTeamClearTrail={tacticalLocked ? undefined : clearTeamTrail}
          onTeamRemoveWithTrail={tacticalLocked ? undefined : (id) => void removeTeamWithTrail(id)}
          // the searched areas removed Trupp markers left behind (lib/truppTrails)
          ghostTrails={mapGhostTrails(trails)}
          onGhostTrail={tacticalLocked ? undefined : (id) => void deleteGhostTrail(id)}
          // «Lösen» on a joined Trupp marker: it lets go of the Leitung on BOTH sides (anchor +
          // the Trupp's own number), which is a Trupp-record write and therefore outside the
          // Karte's document undo — so it quits with the confirm-with-undo toast one-shot ops
          // use here, and re-linking is the exact inverse call.
          onTeamUnlink={tacticalLocked ? undefined : (entityId, lineId) => {
            const marker = doc.entities.find((e) => e.id === entityId)
            const truppId = marker?.truppId
            if (!truppId) return
            // …and the hose lets go of the marker with it (useTruppActions · unlinkTruppLine)
            unlinkTruppLine(truppId)
            // …and the marker steps away from the end it just left (15.09., «places it away»), so
            // the two do not keep standing on one pixel looking joined. The hose end stays put.
            const map = mapRef.current
            if (map && marker?.coord) {
              const p = map.project(marker.coord)
              const c = map.unproject([p.x + 36, p.y + 36])
              patchEntity(entityId, { coord: [c.lng, c.lat] })
            }
            undoToast(appConfig.copy.atemschutz.lineUnlinkedToast, () => { linkTruppLine(truppId, lineId) },
              [recordKey('trupps', truppId), recordKey('objects', lineId), recordKey('objects', entityId)])
          }}
          // the pill's «Lösen» for the OTHER bond (15.09.): a docked marker lets go of its symbol
          // without the detail sheet – dragging cannot part them any more, it moves both
          onTeamUndock={tacticalLocked ? undefined : (entityId) => {
            const marker = doc.entities.find((e) => e.id === entityId)
            const host = doc.entities.find((e) => e.id === marker?.dockedTo)
            if (!marker?.dockedTo) return
            patchEntity(entityId, { dockedTo: undefined })
            log('select', fillTemplate(appConfig.copy.log.teamUndocked, {
              name: marker.label || appConfig.copy.entities.fallbackObjectName,
              host: host?.label || appConfig.copy.entities.fallbackObjectName,
            }), 'team', undefined, entityId)
          }}
          preparedOverlays={mapOverlays}
          onSelectionDone={finishSelection}
          // the linked sheets themselves, as a raster backdrop under the ink — a picture of the
          // paper, not an object on it, which is why THIS one is not a projection of anything
          georefPlanRasters={georefPlanRasters}
          weatherRadar={weatherRadar}
          isVisible={isVisible}
          selectedId={selectedId}
          // Messen: a tap on a symbol is a measuring point FROM ITS CENTRE, never a selection —
          // opening the detail panel mid-measurement read as the tool cancelling itself
          // (Feldtest 09.09.). Drawings need no branch: `placing` already routes their taps to
          // the plain map click, which appends the tapped point.
          onSelect={(e) => {
            if (tool === 'measure') { measure.setPath((d) => [...d, e.coord as LngLat]); return }
            setSelectedId(e.id); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([])
          }}
          onMapClick={onMapClick}
          drawings={drawings}
          drawingsVisible={isVisible(appConfig.defaults.drawingLayerId)}
          draft={draft}
          draftKind={tool === 'area' && areaMode === 'nodes' ? 'area' : lineNodes ? 'line' : null}
          placing={tool !== 'select'}
          onDraftDrag={(i, c) => setDraft((pts) => pts.map((p, j) => (j === i ? c : p)))}
          onDraftInsert={(i, c) => setDraft((pts) => { const next = [...pts]; next.splice(i, 0, c); return next })}
          onDraftDelete={(i) => setDraft((pts) => pts.filter((_, j) => j !== i))}
          onDraftPointAttachment={setDraftPointAttachment}
          measurePoints={tool === 'measure' ? measure.path : []}
          measureKind={tool === 'measure' ? measure.mode : null}
          onMeasureDrag={(i, c) => measure.setPath((pts) => pts.map((p, j) => (j === i ? c : p)))}
          onMeasureInsert={(i, c) => measure.setPath((pts) => { const next = [...pts]; next.splice(i, 0, c); return next })}
          onMeasureDelete={(i) => measure.setPath((pts) => pts.filter((_, j) => j !== i))}
          measureLabels={measure.labels}
          draggable={!tacticalLocked && tool === 'select'}
          onMarkerDragStart={startEntityMove}
          onMarkerMove={streamEntityMove}
          onMarkerDragEnd={finishEntityMove}
          onRotate={(id, deg) => { if (tacticalLocked) return; setVehicleOverrides((m) => ({ ...m, [id]: { ...m[id], rotation: deg } })) }}
          onShapeTransform={(id, patch, phase) => {
            if (tacticalLocked) return
            if (phase === 'start') { beginDrag(); return }
            if (phase === 'move') { setDocRaw((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) })); return }
            endDrag()  // 'end' — fold the whole gesture into a single undo step
          }}
          onView={setView}
          onBasemapUnavailable={onBasemapUnavailable}
          onSettled={onMapSettled}
          picking={coord.mode === 'aim'}
          onCursor={coord.setAim}
          onPick={(c) => {
            coord.setPicked(c); coord.setAim(null)
            coord.setMode('set')
          }}
          pickedPoint={coord.mode === 'set' ? coord.picked : null}
          placeMagnet={tool === 'shape' && !!pendingShape && SHAPE_TWO_POINT[pendingShape] && !tacticalLocked}
          placeAnchor={tool === 'shape' && !!pendingShape ? rotStart : null}
          freehand={freehandKind}
          onFreehand={onFreehand}
          circleEnabled={tool === 'circle' && !tacticalLocked}
          onCircle={createCircle}
          drawColor={drawColor}
          drawWidth={drawWidth}
          drawDashed={drawDashed}
          selectedDrawingId={selectedDrawingId}
          flashDrawingId={flashDrawingId}
          onSelectDrawing={(id, at) => {
            // remember WHERE it was tapped, paired with the id — the panel nudge anchors on it for
            // a drawing too big for its bounds to mean anything. Any other way into the selection
            // (Verlauf jump, a just-finished stroke) leaves a stale id here and is simply ignored.
            setDrawTap(at ? { id, x: at.x, y: at.y } : null)
            setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null)
          }}
          onUnlockDrawing={tacticalLocked ? undefined : (id) => { patchDrawingById(id, { locked: undefined }); setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null) }}
          onUnlockShape={tacticalLocked ? undefined : (id) => { commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, locked: undefined } : e)) })); setSelectedId(id); setSelectedDrawingId(null); setSelectedDrawIds([]); setSelectedEntityIds([]) }}
          onDelete={deleteEntity}
          selectedDrawing={selectedDrawing}
          onDrawingEdit={editDrawingCoords}
          onDrawingRadius={editDrawingRadius}
          onDrawingVertexInsert={insertDrawingVertex}
          onDrawingVertexDelete={deleteDrawingVertex}
          onDrawingAttachment={setDrawingAttachment}
          onLabelMove={tacticalLocked ? undefined : moveLabel}
          marqueeEnabled={tool === 'lasso' && !tacticalLocked && coord.mode === 'off'}
          selectedDrawIds={selectedDrawIds}
          selectedEntityIds={selectedEntityIds}
          onMarquee={onMarquee}
          onGroupTransform={transformGroup}
        />
      // the Karte's own card offers no «Zur Karte»: that button would lead to the view it is on
      ), false) : (
        <Splash inApp sub={appConfig.copy.loadingSubtitle} />
      )}
    </>
  )
}
