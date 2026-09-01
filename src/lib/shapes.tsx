import type { ShapeKind } from '../types'

// Generic, reshapeable map shapes (distinct from the FireGIS tactical symbols).
// Each is placed as an entity and then edited: colour, size (metres on the
// ground) and rotation. Defaults are tuned per shape — smoke (cloud) starts
// larger and grey, the arrow starts blue, the box red.
export const SHAPE_ORDER: ShapeKind[] = ['arrow', 'cloud', 'square', 'rotation']

// The geometric "Formen" shown as their own palette section (Pfeil · Rechteck · Rotation). Rauch
// (cloud) is a Schadenlage, so it is offered from the Schadenlage category instead of here.
//
// Rotation is a tactical sign rather than a geometric form, and it is here anyway: it is the only
// thing in the pack the operator has to STRETCH between two places — Wasserbezug and Brandstelle —
// and stretching is what a shape can do and a symbol cannot (decision 01.09.).
export const FORMEN_ORDER: ShapeKind[] = ['arrow', 'square', 'rotation']

// defaultSizeM sizes on the map (metres on the ground); defaultSizeN on a plan
// (fraction of the plan width — a plan has no metric scale). Smoke starts larger.
export const SHAPE_DEFS: Record<ShapeKind, { defaultColor: string; defaultSizeM: number; defaultSizeN: number; defaultAspect?: number }> = {
  arrow: { defaultColor: '#1f6feb', defaultSizeM: 45, defaultSizeN: 0.1 },
  cloud: { defaultColor: '#6b7280', defaultSizeM: 80, defaultSizeN: 0.18 },
  square: { defaultColor: '#e8392b', defaultSizeM: 45, defaultSizeN: 0.1 },
  // A Rotation is a shuttle RUN — it spans from the Wasserbezug to the Brandstelle, so it starts
  // long and flat rather than square, and far bigger than a Formen box. Both are only a starting
  // point: the corner drag is the whole reason it is a shape.
  rotation: { defaultColor: '#1f6feb', defaultSizeM: 300, defaultSizeN: 0.42, defaultAspect: 0.32 },
}

// Which shapes stretch freely (the corner drag sets width and height separately, stored as
// `aspect` = height/width). The Pfeil stays proportional: a non-uniformly scaled head reads
// badly, and «ein längerer Pfeil» is the line-with-arrowhead tool's job.
export const SHAPE_FREE_ASPECT: Record<ShapeKind, boolean> = { arrow: false, cloud: true, square: true, rotation: true }

// Effective height/width ratio of a placed shape (absent = 1 = the original square box).
// Clamped so a degenerate stored value can't render a sliver; aspect-locked kinds are always 1.
// Mirrored server-side in backend/app/kroki.py (same 0.2..5 clamp).
export function shapeAspect(kind: ShapeKind, aspect: number | undefined): number {
  if (!SHAPE_FREE_ASPECT[kind]) return 1
  return Math.max(0.2, Math.min(5, aspect ?? SHAPE_DEFS[kind].defaultAspect ?? 1))
}

/**
 * The Rotation loop — the stadium outline plus a direction arrowhead on each leg.
 *
 * FKS Vegetationsbrand-Handbuch S. 52/53: a Rotation is a shuttle RUN between the Wasserbezug and
 * the Brandstelle, drawn as a long closed loop with the direction marked on each leg. It is a
 * SHAPE and not a symbol because its whole meaning is the two places it spans — the operator
 * stretches it across the ground rather than dropping it at a point.
 *
 * ⚠️ Its viewBox is `0 0 100 100·asp`, NOT the square box every other shape uses. Those are drawn
 * with `preserveAspectRatio="none"` into a w × w·asp box, so one unit of y is `asp` units of x —
 * which is harmless for a cloud and ruinous here: at a realistic stretch the outline came out fat
 * on the ends and thin along the legs, and the arrowheads flattened into wedges. Matching the
 * viewBox to the box makes the units square again, so the stroke is even and a triangle is a
 * triangle at every stretch, with no counter-scaling to go wrong.
 *
 * Shared as a string so `shapeSvgString` (lib/krokiPayload) prints the identical artwork.
 */
export const rotationViewBox = (asp: number) => `0 0 100 ${(100 * asp).toFixed(2)}`

export function rotationInner(color: string, asp: number): string {
  const h = 100 * asp
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  // ⚠️ Stroke and heads scale off the loop's HEIGHT, not the 100-unit width, and are clamped.
  // A user unit is width/100 whatever the aspect, so anything sized as a share of the width grew
  // with the run: a long Rotation came out with a 15 px outline and arrowheads the size of a
  // vehicle. Off the height they stay proportional to the thing they decorate, and the clamps
  // stop a near-circular loop from turning into a fat ring.
  const sw = clamp(h * 0.10, 2, 4)
  const a = clamp(h * 0.28, 4.5, 9)
  const inset = sw / 2 + 0.5
  const r = Math.max(1.5, (h - 2 * inset) / 2)
  const head = (cx: number, cy: number, dir: 1 | -1) =>
    `<path d="M ${cx - dir * a} ${cy - a} L ${cx + dir * a} ${cy} L ${cx - dir * a} ${cy + a} Z" fill="${color}"/>`
  return `<rect x="${inset.toFixed(2)}" y="${inset.toFixed(2)}" width="${(100 - 2 * inset).toFixed(2)}"`
    + ` height="${Math.max(1.5, h - 2 * inset).toFixed(2)}" rx="${r.toFixed(2)}" ry="${r.toFixed(2)}"`
    + ` fill="none" stroke="${color}" stroke-width="${sw.toFixed(2)}"/>`
    + head(64, inset, 1)          // outbound, on the top leg
    + head(36, h - inset, -1)     // …and back along the bottom
}

// SVG silhouettes on a 0..100 viewBox. fillOpacity keeps the square/cloud
// readable as translucent overlays (a smoke blob / a zone box) while the arrow
// stays solid for a crisp direction indicator. `stop` (arrow only) draws the
// «→|» Stopp-Balken across the tip — keep it identical to shapeSvgString
// (lib/krokiPayload), which is the same artwork as a plain string for the print path.
export function ShapeGlyph({ kind, color, stop, aspect, fit }: { kind: ShapeKind; color: string; stop?: boolean; aspect?: number; fit?: boolean }) {
  if (kind === 'rotation') {
    const asp = shapeAspect('rotation', aspect)
    return (
      // `fit` = keep the proportions inside whatever box the host gives (the palette cell is
      // square, and a loop stretched to fill it would advertise a shape nobody gets). On the map
      // and the plan the box IS the shape, so it paints edge to edge.
      <svg className="shape-svg" viewBox={rotationViewBox(asp)} width="100%" height="100%"
        preserveAspectRatio={fit ? 'xMidYMid meet' : 'none'} style={{ overflow: 'visible' }}>
        <g dangerouslySetInnerHTML={{ __html: rotationInner(color, asp) }} />
      </svg>
    )
  }
  if (kind === 'arrow') {
    return (
      <svg className="shape-svg" viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none">
        <path d="M50 6 L80 50 L60 50 L60 94 L40 94 L40 50 L20 50 Z"
          fill={color} stroke="#fff" strokeWidth={4} strokeLinejoin="round" />
        {stop && <>
          <path d="M20 7 L80 7" stroke="#fff" strokeWidth={9} strokeLinecap="round" />
          <path d="M20 7 L80 7" stroke={color} strokeWidth={5} strokeLinecap="round" />
        </>}
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
