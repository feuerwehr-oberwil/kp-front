import { appConfig } from '../config/appConfig'

// Single source of truth for line drawing style, shared by BOTH surfaces:
// the Lage map (MapLibre line layers) and the Plan whiteboard (SVG polylines).
// A line carries a `dashed?: boolean` flag in its data object (Drawing on the
// map, BoardAnno on the board); these constants turn that flag into the right
// dash geometry for each renderer (the units differ — MapLibre dashes are in
// line-width multiples, SVG non-scaling-stroke dashes are in px), and the
// LineStylePicker below is the one toggle UI used in every place a line style
// is chosen, so the two surfaces can never drift apart.

// ── Schraffur ────────────────────────────────────────────────────────────────────────────────
// The FKS draws an affected AREA hatched rather than washed — Brandzone/Flächenbrand and the
// zerstörte Zone (Zivile Signaturen S. 4, Vegetationsbrand S. 52). A flat fill says «this region»;
// hatching says «this region is affected», and over an aerial photo it also stays legible where a
// 12 % wash disappears into the terrain.
//
// ONE geometry, three renderers: the Plan draws an SVG <pattern>, the Lage map registers a canvas
// tile as a MapLibre `fill-pattern`, and the print (kroki.py) rules the same lines through a
// polygon mask. The numbers live here so a Fläche is the same picture on all three.

/** Period of the 45° pattern, in CSS px. The perpendicular spacing between lines is this ÷ √2. */
export const HATCH_PERIOD_PX = 12
/** Stroke width of one hatch line, CSS px. */
export const HATCH_WIDTH_PX = 1.6

/**
 * A seamless 45° hatch tile, as `ImageData` for `map.addImage`.
 *
 * ⚠️ NOT an SDF image (unlike the arrowheads above): `fill-pattern` takes the image as painted
 * and cannot tint it, so the colour is baked in and the caller registers one tile per palette
 * colour. `ratio` is the pixelRatio the image is registered at, so the tile is drawn at device
 * resolution and the 45° edges stay clean.
 *
 * Seamless because the tile is square and the lines run at exactly 45°: translating by (S, S)
 * maps the tile onto itself, so drawing the diagonals at c ∈ {−S, 0, S} covers every corner with
 * no seam. Returns null wherever a canvas cannot be had (no DOM, a locked-down browser) — the
 * Fläche then paints unhatched instead of the map failing to draw.
 */
export function hatchTile(color: string, ratio = 2): ImageData | null {
  if (typeof document === 'undefined') return null // no DOM at all (tests, a worker)
  const S = Math.round(HATCH_PERIOD_PX * ratio)
  const cv = document.createElement('canvas')
  cv.width = S; cv.height = S
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.strokeStyle = color
  ctx.lineWidth = HATCH_WIDTH_PX * ratio
  ctx.lineCap = 'square'
  for (const c of [-S, 0, S]) {
    ctx.beginPath()
    ctx.moveTo(-S, -S + c)
    ctx.lineTo(2 * S, 2 * S + c)
    ctx.stroke()
  }
  return ctx.getImageData(0, 0, S, S)
}

/** The SVG <pattern> id for one colour's hatch — the Plan's half of the same picture. */
export const hatchPatternId = (color: string) => `hatch-${color.replace('#', '')}`

/**
 * The <defs> the Plan needs so `fill="url(#hatch-…)"` resolves — one pattern per draw colour.
 *
 * ⚠️ `patternUnits="userSpaceOnUse"` and NOT the parent's viewBox units: the ink layer is a
 * `viewBox="0 0 1 1"` sheet stretched over the plan, so pattern units expressed in that space
 * would be a thousand times too large and each Fläche would come out flat-filled. Rendering in
 * user space and letting the rotation do the 45° keeps the hatch at screen scale, which is
 * where it has to be legible.
 */
export function HatchDefs({ colors }: { colors: readonly string[] }) {
  return (
    <defs>
      {colors.map((c) => (
        <pattern key={c} id={hatchPatternId(c)} patternUnits="userSpaceOnUse"
          width={HATCH_PERIOD_PX} height={HATCH_PERIOD_PX} patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={HATCH_PERIOD_PX} stroke={c} strokeWidth={HATCH_WIDTH_PX} />
        </pattern>
      ))}
    </defs>
  )
}

/** The MapLibre image name for one colour's hatch tile — also what the fill layer's
 *  data-driven `fill-pattern` expression builds, so the two cannot drift. */
export const hatchImageId = (color: string) => `hatch-${color.toLowerCase()}`

/** MapLibre `line-dasharray` (units = line-width multiples) */
export const LINE_DASH_ML: [number, number] = [2, 1.6]
/** SVG `stroke-dasharray` for non-scaling strokes (units = px) */
export const LINE_DASH_SVG = '6 5'

interface LineStylePickerProps {
  dashed: boolean
  onChange: (dashed: boolean) => void
  /** the line's repeated marker, when the host supports chain styles (lines, not areas) */
  marker?: string
  /** pass to offer the FKS chain styles. Absent = the plain solid/dashed pair, which is what an
   *  AREA gets: a Haltelinie is a line, and a toothed polygon outline means nothing. */
  onMarker?: (marker: string) => void
}

/**
 * How a line is stroked — solid, dashed, or one of the FKS chains.
 *
 * A fragment of buttons dropped into whatever style bar hosts it (map draw bar, DrawEditor,
 * whiteboard dock), so the choice is identical wherever it is made.
 *
 * ⚠️ The chains live HERE, next to solid and dashed, rather than as line PRESETS (decision
 * 01.09.). A Haltelinie is not a different kind of object with its own bundle of arrow/marker/
 * dash settings — it is a line drawn a different way, which is the question this control already
 * answers. Presets stay for what they are good at: «Rettungsachse» means arrow AND letter AND
 * dash together.
 *
 * Chain and dash are one choice because they are one stroke: picking a chain clears the dash so
 * the teeth sit on a solid line the way the sheet draws them, and picking solid or dashed clears
 * the chain. A letter marker (the «R») is cleared too — a line repeats one thing, not two.
 */
export function LineStylePicker({ dashed, onChange, marker, onMarker }: LineStylePickerProps) {
  const c = appConfig.copy.drawingEditor
  const CHAINS = ['▲', '▼', '◯'] as const
  const chain = (CHAINS as readonly string[]).includes(marker ?? '') ? marker! : ''
  const plain = (d: boolean) => { onChange(d); if (chain) onMarker?.('') }
  const pick = (m: string) => { onMarker?.(m); if (dashed) onChange(false) }
  return (
    <>
      <button className={`wb-ls ${!dashed && !chain ? 'on' : ''}`} data-holdexplain aria-label={c.lineSolid} aria-pressed={!dashed && !chain} onClick={() => plain(false)}><span className="ls-solid" /></button>
      <button className={`wb-ls ${dashed && !chain ? 'on' : ''}`} data-holdexplain aria-label={c.lineDashed} aria-pressed={dashed && !chain} onClick={() => plain(true)}><span className="ls-dashed" /></button>
      {onMarker && (
        <>
          {/* Both Haltelinien-Seiten are their own button rather than a flip on one: which side the
              teeth face is an operational fact (they face the fire) and cannot be read off the
              geometry, so it must be visible rather than a state you tap into.
              ⚠️ `data-holdexplain`, like the Typ letters and the Abschluss glyphs: these five are
              pictures of a stroke, and «Haltelinie – Zähne oberhalb» is the only thing that says
              which one. Hold (touch) or hover (mouse) answers with it; no `title`, or the native
              tooltip repeats the same sentence a second later. */}
          <button className={`wb-ls ${chain === '▲' ? 'on' : ''}`} data-holdexplain aria-label={c.lineHalteliniUp} aria-pressed={chain === '▲'} onClick={() => pick('▲')}><span className="ls-teeth" /></button>
          <button className={`wb-ls ${chain === '▼' ? 'on' : ''}`} data-holdexplain aria-label={c.lineHalteliniDown} aria-pressed={chain === '▼'} onClick={() => pick('▼')}><span className="ls-teeth down" /></button>
          <button className={`wb-ls ${chain === '◯' ? 'on' : ''}`} data-holdexplain aria-label={c.lineAbwurfzone} aria-pressed={chain === '◯'} onClick={() => pick('◯')}><span className="ls-rings" /></button>
        </>
      )}
    </>
  )
}
