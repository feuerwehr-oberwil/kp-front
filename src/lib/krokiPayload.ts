// Build the server-rendered Kroki payload: DATA instead of captured pixels.
// Dynamic glyphs the server can't derive —
// vehicles (name+heading baked into the SVG), placards with field values, the Grosslüfter
// composite, generic shapes — are resolved to SVG strings HERE with the same pure helpers
// the live map uses, so client and server render the identical artwork.

import type { Drawing, Entity, LayerDef, LngLat, ShapeKind } from '../types'
import { appConfig } from '../config/appConfig'
import { isVehicleSym } from './mapView'
import { placardSvgForSymbol } from './placard'
import { vehicleSymbolSvg } from './useVehiclePositions'
import { LUEFTER, LUEFTER_EXTRACT, compositeSpec, compositePartGlyph, composeCompositeSvg, isHubretter, composeHubretterSvg } from './symbolRender'
import { SHAPE_DEFS } from './shapes'
import { operationalExtentPoints, type KrokiView } from './report'
import { resolveMapDrawings } from './lineAttachments'

export interface KrokiEntityOut {
  coord: LngLat
  symbol?: string
  symbolSvg?: string
  kind: string
  rotation?: number
  floor?: number
  floorFrom?: number
  floorTo?: number
  count?: number
  spread?: Entity['spread']
  caption?: string
  sizeM?: number
  color?: string
}

export interface KrokiPayloadOut {
  entities: KrokiEntityOut[]
  drawings: Partial<Drawing>[]
  fitPoints: LngLat[]
  center?: LngLat
  zoom?: number
  bounds?: [number, number, number, number]
  maxTileZoom?: number
  tiles: string
  attribution: string
}

/** Print-specific marker scale for close-up Kroki crops. Mirrors backend/app/kroki.py:
 * overview maps stay unchanged; from z18 onward symbols ease down to a 70% floor. */
export const krokiSymbolMul = (zoom: number): number =>
  Math.max(0.7, 1 - Math.max(0, zoom - 17) * 0.1)

/** The same silhouettes as lib/shapes.tsx ShapeGlyph, as plain SVG strings for resvg. */
export function shapeSvgString(kind: ShapeKind, color: string): string {
  const open = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">'
  if (kind === 'arrow') {
    return `${open}<path d="M50 6 L80 50 L60 50 L60 94 L40 94 L40 50 L20 50 Z" fill="${color}" stroke="#fff" stroke-width="4" stroke-linejoin="round"/></svg>`
  }
  if (kind === 'square') {
    return `${open}<rect x="6" y="6" width="88" height="88" rx="6" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="5"/></svg>`
  }
  return `${open}<path d="M27 76 Q12 76 12 62 Q12 49 26 50 Q26 34 43 35 Q52 24 65 33 Q82 31 81 48 Q94 50 90 64 Q86 76 71 76 Z" fill="${color}" fill-opacity="0.5" stroke="${color}" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`
}

/** Resolve one map entity into the server's Kroki entity — or null when it has no
 *  printable representation (photo markers stay app-only). */
export function krokiEntity(e: Entity, byName: Record<string, string>): KrokiEntityOut | null {
  if (e.kind === 'photo') return null
  const base: KrokiEntityOut = {
    coord: e.coord, kind: e.kind, rotation: e.rotation,
    floor: e.floor, floorFrom: e.floorFrom, floorTo: e.floorTo,
    count: e.count, spread: e.spread,
  }
  if (e.kind === 'team') return { ...base, caption: e.label || undefined, color: e.color || undefined }
  if (e.kind === 'note') return e.label?.trim() ? { ...base, caption: e.label } : null
  if (e.kind === 'shape') {
    const kind = e.shape ?? 'square'
    const color = e.color ?? SHAPE_DEFS[kind].defaultColor
    return { ...base, symbolSvg: shapeSvgString(kind, color), sizeM: e.sizeM ?? SHAPE_DEFS[kind].defaultSizeM }
  }
  // live vehicles carry their resolved glyph already (name + heading baked in — upright text)
  if (e.symbolSvg) return { ...base, symbolSvg: e.symbolSvg, rotation: undefined }
  if (isVehicleSym(e)) return { ...base, symbolSvg: vehicleSymbolSvg(e.label ?? '', e.rotation ?? 0), rotation: undefined }
  const comp = compositeSpec(e.symbol)
  if (comp) {
    // Composite (Grosslüfter / Drehleiter): bake the part onto the body as ONE svg (the server can't
    // stack two rotatable layers). The body prints at base.rotation, so the part is pre-rotated by its
    // offset (rotation2 − rotation) — after the server rotates the whole by base.rotation the part
    // lands at rotation2. Lüfter extract (Absaugen) prints the reversed fan.
    const part = byName[compositePartGlyph(comp, e.extract)] ?? byName[comp.part] ?? ''
    const svg = composeCompositeSvg(byName[comp.base] ?? '', part, comp.scale, (e.rotation2 ?? 0) - (e.rotation ?? 0))
    return svg ? { ...base, symbolSvg: svg } : null
  }
  if (isHubretter(e.symbol)) {
    // Hubretter: bake the plain body + articulated boom (at its bearing) into one svg, rotation unset
    // (the bearing is baked). Reach approximated to the glyph box — see composeHubretterSvg.
    const svg = composeHubretterSvg(byName[appConfig.symbols.vehicleName] ?? '', e.reachM, e.rotation2)
    return svg ? { ...base, symbolSvg: svg, rotation: undefined } : null
  }
  const placard = placardSvgForSymbol(e.symbol, e.fields)
  if (placard) return { ...base, symbolSvg: placard }
  // an extract Lüfter renders the reversed-arrow variant — resolve it to SVG here (like the
  // Grosslüfter) so the server prints the same glyph without needing to know the `extract` flag.
  if (e.extract && e.symbol === LUEFTER && byName[LUEFTER_EXTRACT]) return { ...base, symbolSvg: byName[LUEFTER_EXTRACT] }
  return e.symbol ? { ...base, symbol: e.symbol } : null
}

/** The whole Kroki payload for the server compositor: visible entities + drawings, the
 *  fit extent (or the live view for «aktuelle Ansicht»), and the active base layer's
 *  tiles. Returns null when no base layer with raster tiles exists (nothing to render). */
export function buildKrokiPayload(args: {
  entities: Entity[]
  drawings: Drawing[]
  layers: LayerDef[]
  byName: Record<string, string>
  center: LngLat
  currentView?: KrokiView | null
  includeLiveVehiclesInExtent?: boolean
}): KrokiPayloadOut | null {
  const { entities, drawings: storedDrawings, layers, byName, center } = args
  const drawings = resolveMapDrawings(storedDrawings, entities)
  const visible = (id: string) => layers.find((l) => l.id === id)?.visible ?? true
  const base = layers.find((l) => l.base && l.visible && l.tiles?.length) ?? layers.find((l) => l.base && l.tiles?.length)
  if (!base?.tiles?.length) return null
  const ents = entities
    .filter((e) => visible(e.layer))
    .map((e) => krokiEntity(e, byName))
    .filter((e): e is KrokiEntityOut => e !== null)
  const drawingsVisible = visible(appConfig.defaults.drawingLayerId)
  const draws = (drawingsVisible ? drawings : []).map((d) => ({
    kind: d.kind, coords: d.coords, color: d.color, width: d.width, dashed: d.dashed,
    arrow: d.arrow, marker: d.marker, label: d.label, showDistance: d.showDistance,
    fillOpacity: d.fillOpacity, radiusM: d.radiusM,
    teilstueck: d.teilstueck, lineNo: d.lineNo, content: d.content, floorTag: d.floorTag,
  }))
  return {
    entities: ents,
    drawings: draws,
    fitPoints: operationalExtentPoints(center, entities, drawingsVisible ? drawings : [], !!args.includeLiveVehiclesInExtent),
    center: args.currentView?.center,
    zoom: args.currentView?.zoom,
    bounds: args.currentView?.bounds,
    maxTileZoom: base.maxzoom,
    tiles: base.tiles[0],
    attribution: base.attribution ?? '© CARTO, © OpenStreetMap-Mitwirkende',
  }
}
