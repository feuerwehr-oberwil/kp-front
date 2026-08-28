/** The map half of the «Zwillinge»: every georeferenced plan's tactical symbols, on the Lage.
 *
 *  The mark itself is GeorefTwinMark; the derivation (which points cross over) is
 *  lib/georefTwins. This file only places them on the one live map.
 */
import { memo, useRef } from 'react'
import { Marker } from 'react-map-gl/maplibre'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { vehicleSymbolSvg } from '../lib/useVehiclePositions'
import { symPx } from '../lib/mapView'
import { ROTATABLE } from '../lib/symbols'
import { MARKER_Z } from '../lib/labelPass'
import type { MapTwin } from '../lib/georefTwins'
import { TwinMark } from './GeorefTwinMark'
import { glyphFor, overlayFor, twinName } from '../lib/twinGlyph'
import { symbolCaptionText } from '../lib/symbols'
import { softHyphenateText } from '../lib/symbolWrap'
import type { CaptionMode, LngLat } from '../types'

// --- plan symbols, on the Lage map ------------------------------------------------------------

/**
 * Every georeferenced plan's tactical symbols, drawn on the map as twins.
 *
 * Sized exactly like the map's own symbols (`symPx` at the live zoom), so the projection is the
 * literal same visual object. Provenance lives in its detail subtitle and layer row. Memoised:
 * the projection itself is done once per board/fit change by the caller, and this tree then
 * re-renders only when that list, the zoom or the bearing actually moves.
 */
export const GeorefTwinsMap = memo(function GeorefTwinsMap({ twins, byName, zoom, bearing = 0, symMul = 1, captionMode = 'off', interactive = true, selectedKey, onOpen, onMove }: {
  twins: MapTwin[]
  byName: Record<string, string>
  zoom: number
  /** the live map bearing — a directional glyph is pinned to the GROUND, like every placed
   *  symbol on this map, so its CSS rotation is offset by −bearing */
  bearing?: number
  symMul?: number
  captionMode?: CaptionMode
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
}) {
  const C = appConfig.copy.whiteboard.georef
  // a Marker drag ends with a click on the mark; without this the details panel would open on
  // top of the object that was just moved
  const dragged = useRef(false)
  return (
    <>
      {twins.map((t) => {
        const a = t.anno
        const selected = selectedKey === t.key
        // Match a source object: the first tap selects and explains it; only the object wearing
        // the halo may then be moved. Otherwise a casual map pan can silently move a projection.
        const movable = interactive && selected && !!onMove
        const name = twinName(a)
        const veh = a.symbol === appConfig.symbols.vehicleName
        // Plan rotation is paper-relative. Plan-up points at bearing −fit.rotationDeg, then the
        // live map bearing is removed so the projected glyph stays pinned to the ground.
        // ⚠️ Only for DIRECTIONAL glyphs — an upright badge (no rotation control) stays upright,
        // as it does on both source surfaces (see GeorefTwinsBoard).
        const rot = veh || (!!a.symbol && ROTATABLE.has(a.symbol)) ? (a.rotation ?? 0) - t.fit.rotationDeg - bearing : 0
        const svg = veh ? vehicleSymbolSvg(name, rot) : glyphFor(a, byName)
        const rawCaption = symbolCaptionText(a, captionMode)
        return (
          <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center"
            style={{ zIndex: MARKER_Z.twin }}
            draggable={movable}
            onDragStart={() => { dragged.current = true; onMove?.(t, t.coord, 'start') }}
            onDrag={(e) => onMove?.(t, [e.lngLat.lng, e.lngLat.lat], 'move')}
            onDragEnd={(e) => onMove?.(t, [e.lngLat.lng, e.lngLat.lat], 'end')}>
            <TwinMark
              svg={svg}
              sizePx={symPx('symbol', t.coord[1], zoom, symMul)}
              rotation={veh ? 0 : rot}
              count={a.count}
              // ⚠️ `storey`, never `anno.floor` — that one is the floor-stack tile index
              floor={a.storey} floorFrom={a.floorFrom} floorTo={a.floorTo}
              spread={a.spread} spreadRotation={-t.fit.rotationDeg - bearing}
              overlay={veh ? undefined : overlayFor(a, byName, -t.fit.rotationDeg - bearing)}
              caption={rawCaption ? softHyphenateText(rawCaption) : rawCaption}
              title={fillTemplate(C.twinFromPlan, { name, plan: t.planCode })}
              onOpen={() => { if (!dragged.current) onOpen(t); dragged.current = false }}
              // the Marker above runs the gesture and hands back ground coordinates directly
              nativeDrag={movable}
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
