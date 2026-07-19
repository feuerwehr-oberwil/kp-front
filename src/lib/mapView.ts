// Pure helpers extracted from MapView: world-scaled symbol/shape sizing, GeoJSON
// feature builders, and the symbol-kind predicates. No React — safe to unit-test.
import type { Entity, LngLat } from '../types'
import { appConfig } from '../config/appConfig'
import { ROTATABLE } from '../lib/symbols'
import { GROSSLUEFTER } from '../lib/symbolRender'

export const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] }

export const vis = (on: boolean) => ({ visibility: (on ? 'visible' : 'none') as 'visible' | 'none' })

// Symbol-Größe an die reale Welt gekoppelt (m), skaliert mit Zoom — aber in ein
// ENGES Band geklemmt: an normalen Einsatz-Zooms wirkt ein Symbol fast konstant
// (wie ein Karten-Pin), wächst nie über das Dach (kein „Offizier so gross wie ein
// Haus") und schrumpft beim Rauszoomen leicht, damit ein Cluster nicht verklumpt.
const SIZE_M: Record<string, number> = { vehicle: 11, command: 10, hydrant: 6, symbol: 8, area: 8 }
// das Band (px). `mul` ist der globale S/M/L-Faktor (lib/prefs · symbolMul); er
// skaliert das ganze Band, sodass auch die Decken/Boden mitwachsen.
const SYM_MIN = 28
const SYM_MAX = 48
export const pxPerM = (lat: number, z: number) => Math.pow(2, z) / (156543.03392 * Math.cos((lat * Math.PI) / 180))
export const symPx = (kind: string, lat: number, z: number, mul = 1) =>
  Math.max(SYM_MIN, Math.min(SYM_MAX, (SIZE_M[kind] ?? 8) * pxPerM(lat, z))) * mul
// shapes are sized in real-world metres so they grow/shrink with zoom like a
// ground footprint (a smoke cloud covering an area, an arrow spanning a street)
export const shapePx = (sizeM: number | undefined, lat: number, z: number) => Math.max(24, Math.min(900, (sizeM ?? 40) * pxPerM(lat, z)))
// directional tactical symbols that support drag-to-rotate (ladders, fans, vehicles…)
// — set derived from the symbol presets (lib/symbols · ROTATABLE)
export const isRotatableSym = (e: Entity) => e.kind === 'symbol' && !!e.symbol && ROTATABLE.has(e.symbol)
// a placed generic vehicle — rendered like the live GPS glyph, with its typed name baked in
export const isVehicleSym = (e: Entity) => e.kind === 'symbol' && e.symbol === appConfig.symbols.vehicleName
// the composite Grosslüfter (vehicle body + fan) — gets a two-handle rotor (body + airflow)
// instead of the single rotor, and renders its two layers separately. `e` may be a board anno too.
export const isGrossluefter = (e: { kind?: string; symbol?: string }) => e.kind === 'symbol' && e.symbol === GROSSLUEFTER

// Accidental-rotation self-heal: a rotate gesture that ends ALMOST north (within ±threshold°)
// snaps back to exactly 0 — the common case of a two-finger zoom that drags the bearing a few
// degrees off heals itself, while deliberate rotation past the threshold sticks. Returns the
// corrected bearing (0) or null when the bearing should stay as released.
export const snapNorth = (bearing: number, threshold = 6): number | null => {
  const b = ((bearing % 360) + 360) % 360 // normalise to [0, 360)
  const d = Math.min(b, 360 - b) // angular distance to north
  return d > 0 && d <= threshold ? 0 : null
}

export type FC = { type: 'FeatureCollection'; features: any[] }
export const fc = (features: any[]): FC => ({ type: 'FeatureCollection', features })
export const lineFeat = (coords: LngLat[], props: any = {}) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props })
export const polyFeat = (coords: LngLat[], props: any = {}) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] }, properties: props })
