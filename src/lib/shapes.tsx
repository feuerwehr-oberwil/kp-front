import type { ShapeKind } from '../types'

// Generic, reshapeable map shapes (distinct from the FireGIS tactical symbols).
// Each is placed as an entity and then edited: colour, size (metres on the
// ground) and rotation. Defaults are tuned per shape — smoke (cloud) starts
// larger and grey, the arrow starts blue, the box red.
export const SHAPE_ORDER: ShapeKind[] = ['arrow', 'cloud', 'square']

// The geometric "Formen" shown as their own palette section (Pfeil + Rechteck). Rauch (cloud)
// is a Schadenlage, so it is offered from the Schadenlage category instead of here.
export const FORMEN_ORDER: ShapeKind[] = ['arrow', 'square']

// defaultSizeM sizes on the map (metres on the ground); defaultSizeN on a plan
// (fraction of the plan width — a plan has no metric scale). Smoke starts larger.
export const SHAPE_DEFS: Record<ShapeKind, { defaultColor: string; defaultSizeM: number; defaultSizeN: number }> = {
  arrow: { defaultColor: '#1f6feb', defaultSizeM: 45, defaultSizeN: 0.1 },
  cloud: { defaultColor: '#6b7280', defaultSizeM: 80, defaultSizeN: 0.18 },
  square: { defaultColor: '#e8392b', defaultSizeM: 45, defaultSizeN: 0.1 },
}

// SVG silhouettes on a 0..100 viewBox. fillOpacity keeps the square/cloud
// readable as translucent overlays (a smoke blob / a zone box) while the arrow
// stays solid for a crisp direction indicator.
export function ShapeGlyph({ kind, color }: { kind: ShapeKind; color: string }) {
  if (kind === 'arrow') {
    return (
      <svg className="shape-svg" viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none">
        <path d="M50 6 L80 50 L60 50 L60 94 L40 94 L40 50 L20 50 Z"
          fill={color} stroke="#fff" strokeWidth={4} strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'square') {
    return (
      <svg className="shape-svg" viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none">
        <rect x="6" y="6" width="88" height="88" rx="6" fill={color} fillOpacity={0.18} stroke={color} strokeWidth={5} />
      </svg>
    )
  }
  // cloud / smoke — a plumper four-lobe puff so it reads as smoke at a glance
  return (
    <svg className="shape-svg" viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none">
      <path d="M27 76 Q12 76 12 62 Q12 49 26 50 Q26 34 43 35 Q52 24 65 33 Q82 31 81 48 Q94 50 90 64 Q86 76 71 76 Z"
        fill={color} fillOpacity={0.5} stroke={color} strokeWidth={4.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
