import { markerGlyph } from '../lib/lineStyle'

/**
 * One repeated marker on an annotated line — a letter, or an FKS chain glyph.
 *
 * ONE component for all four client surfaces (Lage map, Plan whiteboard, and both georef twin
 * layers). The letter path is what «—R—» has always rendered; the glyph path is the
 * Vegetationsbrand chains (Haltelinie's triangles, Wasserabwurfzone's circles, lib/lineStyle ·
 * MARKER_GLYPHS). Keeping both in one place is the only way Lage and Plan can be guaranteed to
 * draw a Haltelinie alike, which the twin doctrine requires of them.
 *
 * The white halo is the same idea on both paths: a marker has to read over an aerial photo and
 * over a printed Objektplan, neither of which we choose. On the letter it is a text-shadow (the
 * `.draw-marker` class); on the glyph it is a fatter stroke painted underneath.
 *
 * `deg` turns the glyph with the line — only for glyphs that ask for it. A Haltelinie's teeth
 * stand ON the line, so they follow it; an Abwurfzone's circles are round and would only shimmer.
 */
export function LineMarker({ marker, color, deg = 0, className = 'draw-marker' }: {
  marker: string
  color: string
  /** the segment's screen bearing at this point (lib/lineStyle · markerParamsAlong) */
  deg?: number
  /** the surface's own positioning class — the map and the plan place their markers differently */
  className?: string
}) {
  const g = markerGlyph(marker)
  if (!g) return <span className={className} style={{ color }}>{marker}</span>
  // The path is authored apex-up with its base on y=0, which is already «standing on a line
  // running east». So the turn is the segment's bearing itself — no correction.
  const turn = g.rotate ? deg : 0
  return (
    <span className={className} style={{ color, lineHeight: 0 }}>
      <svg width={g.size} height={g.size} viewBox="-1.15 -1.15 2.3 2.3" aria-hidden
        style={{ display: 'block', overflow: 'visible', transform: turn ? `rotate(${turn}deg)` : undefined }}>
        {/* thin: the halo is there so the mark reads over an aerial photo, not so it erases the
            line it sits on — at 0.42 the rings chewed the Leitung into dashes. */}
        <path d={g.path} fill="none" stroke="#fff" strokeWidth={0.22} strokeLinejoin="round" opacity={0.9} />
        <path d={g.path} fill={g.fill ? 'currentColor' : 'none'} stroke="currentColor"
          strokeWidth={g.fill ? 0.08 : 0.16} strokeLinejoin="round" />
      </svg>
    </span>
  )
}
