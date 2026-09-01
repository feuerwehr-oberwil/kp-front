/** The map half of the «Zwillinge»: every georeferenced plan's tactical symbols, on the Lage.
 *
 *  The mark itself is GeorefTwinMark; the derivation (which points cross over) is
 *  lib/georefTwins. This file only places them on the one live map.
 */
import { memo } from 'react'
import { Marker } from 'react-map-gl/maplibre'
import { appConfig } from '../config/appConfig'
import { useMapTwinDrag } from '../lib/mapTwinDrag'
import { fillTemplate } from '../lib/format'
import { vehicleSymbolSvg } from '../lib/useVehiclePositions'
import { ROTATABLE } from '../lib/symbols'
import { MARKER_Z } from '../lib/labelPass'
import { type MapTwin } from '../lib/georefTwins'
import { pxPerM, symPx } from '../lib/mapView'
import { TwinMark } from './GeorefTwinMark'
import { boomFor, glyphFor, overlayFor, twinName } from '../lib/twinGlyph'
import { haversineM } from '../lib/geo'
import { isHubretter } from '../lib/symbolRender'
import { symbolCaptionText } from '../lib/symbols'
import { softHyphenateText } from '../lib/symbolWrap'
import type { CaptionMode, LngLat } from '../types'

// --- plan symbols, on the Lage map ------------------------------------------------------------

/**
 * Every georeferenced plan's tactical symbols, drawn on the map as twins.
 *
 * Sized by the map's own pin band (`symPx`), exactly like a native symbol standing beside it:
 * twins are fully interaction- AND presentation-equivalent to originals (doctrine 30.08. — the
 * one twin/original difference is which side persists a broken reference). The earlier
 * footprint-scaled quieter band read as «different object» in the field. Provenance lives in
 * the detail subtitle and layer row.
 * Memoised: the projection itself is done once per board/fit change by the caller, and
 * this tree then re-renders only when that list, the zoom or the bearing actually moves.
 */
export const GeorefTwinsMap = memo(function GeorefTwinsMap({ twins, byName, zoom, bearing = 0, symMul = 1, captionMode = 'off', suppressedLabels, interactive = true, selectedKey, onOpen, onMove, project, unproject, setDragPan }: {
  twins: MapTwin[]
  byName: Record<string, string>
  zoom: number
  /** the live map bearing — a directional glyph is pinned to the GROUND, like every placed
   *  symbol on this map, so its CSS rotation is offset by −bearing */
  bearing?: number
  symMul?: number
  captionMode?: CaptionMode
  /** the map's ONE label pass (lib/labelPass), keyed `tcap:<twin key>` — a twin's caption is
   *  arbitrated against every native label instead of being drawn over them */
  suppressedLabels?: ReadonlySet<string>
  /** the map is at rest (Auswahl, no pairing, no armed tool) — only then may a twin answer a
   *  tap. Otherwise it stays on screen and goes inert: a tap during placement belongs to the
   *  thing being placed, and a tap during «Karte verknüpfen» is half of a reference pair. */
  interactive?: boolean
  selectedKey?: string | null
  /** tap: open the source-backed editor on this surface */
  onOpen: (twin: MapTwin) => void
  /**
   * Drag a projection to move the plan annotation it mirrors.
   *
   * The coordinate is a ground position; the caller folds it back through the twin's own `fit`
   * (MapTwin carries it for exactly this) and writes the source annotation in plan space, so every
   * other projection of it follows from that one write. Omitted ⇒ tap-only.
   */
  onMove?: (twin: MapTwin, coord: LngLat, phase: 'start' | 'move' | 'end') => void
  /** the live map transform + pan switch the shared hold gesture drags against (the same trio
   *  MapMarkers and GeorefContentMap take) */
  project?: (c: LngLat) => { x: number; y: number } | undefined
  unproject?: (p: { x: number; y: number }) => LngLat | undefined
  setDragPan?: (on: boolean) => void
}) {
  const C = appConfig.copy.whiteboard.georef
  // ONE gesture for every twin on this map (lib/mapTwinDrag): tap opens, a still hold (touch) or
  // a press-move (mouse) drags — identical to the native marker beside it, and a flick across a
  // twin stays a map pan.
  const { begin, canDrag } = useMapTwinDrag<MapTwin>({ project, unproject, setDragPan, onMove })
  return (
    <>
      {twins.map((t) => {
        const a = t.anno
        const selected = selectedKey === t.key
        // Match the source marker: no selection tap is needed first (that made the mirror feel
        // inert) — the press itself decides, through the shared hold. A tap opens the panel and
        // paints the halo; a hold moves the source.
        const movable = interactive && canDrag
        const name = twinName(a)
        const veh = a.symbol === appConfig.symbols.vehicleName
        // Plan rotation is paper-relative. Plan-up points at bearing −fit.rotationDeg, then the
        // live map bearing is removed so the projected glyph stays pinned to the ground.
        // ⚠️ Only for DIRECTIONAL glyphs — an upright badge (no rotation control) stays upright,
        // as it does on both source surfaces (see GeorefTwinsBoard).
        const rot = veh || (!!a.symbol && ROTATABLE.has(a.symbol)) ? (a.rotation ?? 0) - t.fit.rotationDeg - bearing : 0
        // ⚠️ the third argument is passed explicitly, like both other call sites (MapMarkers,
        // GeorefTwinsBoard): a plan annotation carries no `directed` (it is ENTITY_MAP_ONLY), so
        // a mirrored Fahrzeug always states its heading — never silently, by omission.
        const svg = veh ? vehicleSymbolSvg(name, rot, true) : glyphFor(a, byName)
        const rawCaption = symbolCaptionText(a, captionMode)
        const capHidden = !!rawCaption && !!suppressedLabels?.has(`tcap:${t.key}`)
        // the boom's reach is a sheet fraction on the source; projected through the fit it is a
        // ground distance, and from there the map's own px — the same band the native uses
        const boomPx = isHubretter(a.symbol) && a.x != null && a.y != null
          ? (() => {
            const edge = t.fit.toMap({ x: a.x! + (a.reachN ?? 0.12), y: a.y! })
            const reachM = haversineM(t.coord, [edge.lng, edge.lat])
            return Math.max(24, Math.min(900, reachM * pxPerM(t.coord[1], zoom)))
          })()
          : 0
        return (
          <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center"
            style={{ zIndex: MARKER_Z.twin }}
            // swallow the trailing native click before MapLibre's own container listener sees
            // it — otherwise onMapClick closes the twin panel the tap just opened (the same
            // idiom as MapMarkers; see GeorefContentMap · tapTarget for the full story)
            onClick={(ev) => ev.originalEvent.stopPropagation()}
            // ⚠️ NEVER `draggable`: a react-map-gl Marker claims the pointer on pointerdown and
            // suppresses the map's pan, so every pan starting on a twin dragged the twin. The
            // gesture belongs to the shared hold below, exactly as it does for a native marker.
            draggable={false}>
            <TwinMark
              svg={svg}
              sizePx={symPx(veh ? 'vehicle' : 'symbol', t.coord[1], zoom, symMul)}
              rotation={veh ? 0 : rot}
              count={a.count}
              // ⚠️ `storey`, never `anno.floor` — that one is the floor-stack tile index
              floor={a.storey} floorFrom={a.floorFrom} floorTo={a.floorTo}
              spread={a.spread}
              overlay={veh ? undefined : overlayFor(a, byName, -t.fit.rotationDeg - bearing)}
              boom={boomFor(a, boomPx, -t.fit.rotationDeg - bearing)}
              caption={capHidden || !rawCaption ? null : softHyphenateText(rawCaption)}
              title={fillTemplate(C.twinFromPlan, { name, plan: t.planCode })}
              onOpen={() => onOpen(t)}
              // the layer's shared hold gesture runs the press and hands back ground coordinates
              onGesture={(ev) => begin(ev, t, t.coord, { movable, onTap: () => onOpen(t) })}
              gestureMovable={movable}
              interactive={interactive}
              selected={selected}
              // the Marker already places the element; the mark only has to centre itself in it
              style={{ position: 'relative', margin: 0 }}
            />
          </Marker>
        )
      })}
    </>
  )
})
