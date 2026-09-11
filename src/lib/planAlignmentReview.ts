import { fitSimilarity, type GeoPt, type GeorefPair } from './georef'

/** MapLibre image corner order is top-left, top-right, bottom-right, bottom-left. */
export function alignmentCorners(pairs: GeorefPair[], aspect: number): [[number, number], [number, number], [number, number], [number, number]] | null {
  const fit = fitSimilarity(pairs, aspect)
  if (!fit) return null
  const corner = (x: number, y: number): [number, number] => {
    const point = fit.toMap({ x, y })
    return [point.lng, point.lat]
  }
  return [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)]
}

/** Keep map fitting finite even when a reference provider returned no usable geometry. */
export function alignmentBounds(rings: GeoPt[][], pairs: GeorefPair[]): [[number, number], [number, number]] | null {
  const points = [...rings.flat(), ...pairs.map(p => p.lngLat)].filter(p => Number.isFinite(p.lng) && Number.isFinite(p.lat))
  if (!points.length) return null
  return [
    [Math.min(...points.map(p => p.lng)), Math.min(...points.map(p => p.lat))],
    [Math.max(...points.map(p => p.lng)), Math.max(...points.map(p => p.lat))],
  ]
}

/** Only geometry with a usable fit can be approved, including manually repaired proposals. */
export function reviewableAlignment(pairs: GeorefPair[], aspect: number | null): boolean {
  return aspect != null && Number.isFinite(aspect) && aspect > 0 && pairs.length >= 2
    && pairs.every(p => [p.plan.x, p.plan.y, p.lngLat.lng, p.lngLat.lat].every(Number.isFinite))
    && fitSimilarity(pairs, aspect) != null
}
