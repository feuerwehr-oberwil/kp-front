/** The map half of the «Zwillinge»: every georeferenced plan's tactical symbols, on the Lage.
 *
 *  The mark itself is GeorefTwinMark; the derivation (which points cross over) is
 *  lib/georefTwins. This file only places them on the one live map.
 */
import { memo } from 'react'
import { Marker } from 'react-map-gl/maplibre'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { vehicleSymbolSvg } from '../lib/useVehiclePositions'
import { symPx } from '../lib/mapView'
import { MARKER_Z } from '../lib/labelPass'
import type { MapTwin } from '../lib/georefTwins'
import { TwinMark } from './GeorefTwinMark'
import { glyphFor, twinName } from '../lib/twinGlyph'
import { symbolCaptionText } from '../lib/symbols'
import { softHyphenateText } from '../lib/symbolWrap'
import type { CaptionMode } from '../types'

// --- plan symbols, on the Lage map ------------------------------------------------------------

/**
 * Every georeferenced plan's tactical symbols, drawn on the map as twins.
 *
 * Sized exactly like the map's own symbols (`symPx` at the live zoom), so the projection is the
 * literal same visual object. Provenance lives in its detail subtitle and layer row. Memoised:
 * the projection itself is done once per board/fit change by the caller, and this tree then
 * re-renders only when that list, the zoom or the bearing actually moves.
 */
export const GeorefTwinsMap = memo(function GeorefTwinsMap({ twins, byName, zoom, bearing = 0, symMul = 1, captionMode = 'off', interactive = true, selectedKey, onOpen }: {
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
  /** tap: open this twin's details, read-only (never edit — see GeorefTwinPanel) */
  onOpen: (twin: MapTwin) => void
}) {
  const C = appConfig.copy.whiteboard.georef
  return (
    <>
      {twins.map((t) => {
        const a = t.anno
        const name = twinName(a)
        const veh = a.symbol === appConfig.symbols.vehicleName
        const rot = (a.rotation ?? 0) - bearing
        const svg = veh ? vehicleSymbolSvg(name, rot) : glyphFor(a, byName)
        const rawCaption = symbolCaptionText(a, captionMode)
        return (
          <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center"
            style={{ zIndex: MARKER_Z.twin }}>
            <TwinMark
              svg={svg}
              sizePx={symPx('symbol', t.coord[1], zoom, symMul)}
              rotation={veh ? 0 : rot}
              count={a.count}
              caption={rawCaption ? softHyphenateText(rawCaption) : rawCaption}
              title={fillTemplate(C.twinFromPlan, { name, plan: t.planCode })}
              onOpen={() => onOpen(t)}
              interactive={interactive}
              selected={selectedKey === t.key}
              // the Marker already places the element; the mark only has to centre itself in it
              style={{ position: 'relative', margin: 0 }}
            />
          </Marker>
        )
      })}
    </>
  )
})
