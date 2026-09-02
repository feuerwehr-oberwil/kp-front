import type { ShapeKind } from '../types'
import { DEFAULT_INK } from './lineStyle'

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
  arrow: { defaultColor: DEFAULT_INK, defaultSizeM: 45, defaultSizeN: 0.1 },
  cloud: { defaultColor: '#6b7280', defaultSizeM: 80, defaultSizeN: 0.18 },
  square: { defaultColor: '#e8392b', defaultSizeM: 45, defaultSizeN: 0.1 },
  // A Rotation is a shuttle RUN — it spans from the Wasserbezug to the Brandstelle, so it starts
  // long and flat rather than square, and far bigger than a Formen box. Both are only a starting
  // point: the corner drag is the whole reason it is a shape.
  rotation: { defaultColor: DEFAULT_INK, defaultSizeM: 300, defaultSizeN: 0.42, defaultAspect: 0.32 },
}

// Which shapes stretch freely (the corner drag sets width and height separately, stored as
// `aspect` = height/width). The Pfeil stays proportional: a non-uniformly scaled head reads
// badly, and «ein längerer Pfeil» is the line-with-arrowhead tool's job.
/** The aspect the Rotation is DRAWN AT in a picker cell — stockier than the one it is placed
 *  with, because a 40px icon has to read as a loop rather than as a hairline. */
export const ROTATION_PREVIEW_ASPECT = 0.42

/**
 * How wide a shape may be drawn ON SCREEN, in px, per kind.
 *
 * ⚠️ 900 is the general ceiling and it is what made a long Rotation impossible: the loop's METRES
 * grew with the drag, but its rendered width stopped at 900 px, so past that the shape simply
 * stopped following the finger — «rotation hasn't been fixed yet». A run is the one shape meant to
 * span the map, so it gets a far higher ceiling; every other shape keeps the old one, which is
 * there to stop a stray value from producing a mile-wide DOM box.
 */
export const SHAPE_MAX_PX: Record<ShapeKind, number> = {
  arrow: 900, cloud: 900, square: 900, rotation: 12000,
}

/**
 * How small a shape may be dragged.
 *
 * ⚠️ In GROUND METRES on the map and in plan-width fractions on the Plan — never in screen px
 * (tried and reverted 01.09.). A pixel floor reads as «it stops when it gets small», but what it
 * actually clamps is the pixel size, so the METRE size it leaves behind depends on the zoom the
 * operator happened to be at: the same gesture stored an 8 m box at z19 and a 200 m one at z14,
 * and zooming in one step let the drag continue past the floor it had just refused. A shape's
 * size is ground truth and it is printed as such, so its floor has to be ground truth too.
 *
 * 8 m / 3 % of the plan width are the numbers the size buttons already clamp to (ShapeEditor ·
 * onScale), so the drag and the buttons now stop at the same place.
 *
 * ⚠️ This bounds how far a drag may shrink a shape — it does NOT hold the outline's on-screen
 * thickness. The outline is a fraction of the box (it has to be: the artwork travels to the print
 * path as a string that never learns a pixel size — SHAPE_STROKE_DEFAULT), so a small shape has a
 * thin outline the same way any metre-sized object on a map does. The Strichstärke control is
 * what answers that.
 */
export const SHAPE_MIN_M = 8
export const SHAPE_MIN_N = 0.03

/** How long a Rotation may be drawn: in metres on the Karte, as a share of the plan width on the
 *  Kroki. Every other shape is capped far lower (SHAPE_MAX_M / SHAPE_MAX_N) — a Wasserpendel
 *  between the Weiher and the Brandstelle is kilometres, and that cap was the reason the only way
 *  to make the loop long was to make it enormous in both axes. */
export const ROTATION_MAX_M = 20000
export const ROTATION_MAX_N = 3

/**
 * How large a shape may be made — the ceiling twin of SHAPE_MIN_M / SHAPE_MIN_N, and in the same
 * two unit domains: ground metres on the Karte, a share of the plan width on the Kroki.
 *
 * ⚠️ ONE ceiling per domain, read by BOTH the corner/axis drag and the editor's ± stepper
 * (MapMarkers · shapeDown/shapeMove, Whiteboard · rotDown/rotMove, ShapeEditor · onScale). The
 * three numbers used to be written out at each site and had drifted: the Lage's ± button grew a
 * Rechteck to 800 m that its own drag refused past 500 m, so the same shape had two answers to
 * «wie gross darf das werden» depending on which control was touched.
 *
 * Not to be confused with SHAPE_MAX_PX, which bounds the rendered box on SCREEN — that one stops
 * a stray value from producing a mile-wide DOM node and says nothing about the stored size.
 */
export const SHAPE_MAX_M: Record<ShapeKind, number> = {
  arrow: 500, cloud: 500, square: 500, rotation: ROTATION_MAX_M,
}
export const SHAPE_MAX_N: Record<ShapeKind, number> = {
  arrow: 0.9, cloud: 0.9, square: 0.9, rotation: ROTATION_MAX_N,
}

export const SHAPE_FREE_ASPECT: Record<ShapeKind, boolean> = { arrow: false, cloud: true, square: true, rotation: true }

/**
 * The line width a Formen shape is drawn with, in the SAME three steps as a drawn Fläche
 * (`appConfig.drawing.widths` — 3 · 5 · 8). A shape is a pre-shaped area, so it is edited with the
 * area's vocabulary rather than one of its own.
 *
 * ⚠️ It is a FACTOR, not a pixel count. The artwork is shared verbatim with the print path
 * (`shapeSvgString` → resvg), which never learns the on-screen pixel size of the box — and resvg
 * ignores `vector-effect="non-scaling-stroke"` (measured 01.09.: a 4:1 stretched rect still came
 * out 24px × 6px with it set), so a px-true stroke cannot survive the trip to paper. What travels
 * is a proportion, and 5 — the middle step — is the look every stored shape already has.
 */
/**
 * Which shapes carry ONE GRIP PER AXIS instead of a diagonal corner grip: a horizontal ↔ for the
 * x-axis, a vertical ↕ for the y-axis (01.09.). Both used to be corner grips wearing the same
 * glyph, so a Rechteck's and a Rotation's two handles said nothing about what they would do.
 *
 * The Rauch keeps its corner: a plume is a blob pulled into shape, not a box with a width and a
 * height, and the diagonal drag that sets both at once is the right gesture for it.
 */
export const SHAPE_AXIS_GRIPS: Record<ShapeKind, boolean> = { arrow: false, cloud: false, square: true, rotation: false }

/**
 * Which shapes are laid down and edited as TWO POINTS rather than as a box (01.09.).
 *
 * A Rotation is not a rectangle that happens to be long — it is a RUN between two places, the
 * Wasserbezug and the Brandstelle, and naming those two places is the entire statement. So it is
 * placed by tapping one and then the other, and edited by moving either end; its centre, its
 * length, its bearing and its width all follow. It carries no rotate knob and no size grips,
 * because there is nothing left for them to say.
 *
 * ⚠️ Nothing new is STORED for this. The two ends and the box the renderers already use
 * (`coord` + `sizeM`/`sizeN` + `aspect` + `rotation`) are the same information written two ways:
 *
 *     end = coord ± (run / 2) along `rotation`,   run = size − size·aspect
 *
 * so the print path (lib/krokiPayload → backend/app/kroki.py), the georef twins and every
 * incident recorded before today keep working untouched. The ends are simply recomputed
 * wherever they are needed.
 *
 * The ends are the CAP CENTRES, not the box corners: dropping an end on the hydrant has to put
 * the loop's rounded end AROUND it, not half a width short of it — which is why the box comes
 * out one width longer than the run between the ends.
 */
export const SHAPE_TWO_POINT: Record<ShapeKind, boolean> = { arrow: false, cloud: false, square: false, rotation: true }

/** How wide a Rotation is drawn, as a share of how far it runs. */
export const ROTATION_WIDTH_RATIO = 0.15
/**
 * …clamped, in the unit of the surface it lives on: ground metres on the Lage map, fractions of
 * the plan width on the Plan.
 *
 * The cap is what keeps a kilometres-long Wasserpendel a thin racetrack instead of a blob (0.15 ×
 * 3 km would be 450 m of loop width); the floor keeps a short run from being drawn as a hairline.
 * Between them the loop simply looks like the FKS sheet's at every length.
 */
export const ROTATION_W_M = { min: 20, max: 45 }
export const ROTATION_W_N = { min: 0.015, max: 0.05 }

/** The leanest a Rotation may be stored as — shared by `rotationBox` (which writes it) and
 *  `shapeAspect` (which reads it back), so a long run cannot be silently fattened between them. */
export const ROTATION_ASPECT_MIN = 0.002

export const rotationWidth = (run: number, b: { min: number; max: number }) =>
  Math.min(b.max, Math.max(b.min, Math.abs(run) * ROTATION_WIDTH_RATIO))

/** The box a run of `run` is STORED as: `size` goes into sizeM/sizeN, `aspect` into aspect. */
export function rotationBox(run: number, b: { min: number; max: number }): { size: number; aspect: number } {
  const w = rotationWidth(run, b)
  const size = Math.abs(run) + w
  return { size, aspect: Math.max(ROTATION_ASPECT_MIN, Math.min(1, w / size)) }
}

/**
 * How far OUTSIDE the loop's cap an end grip floats, in screen px.
 *
 * The grip must not sit on the cap it defines — nor on the Wasserbezug the end has just been
 * dropped on. A short tether keeps it read as attached, the same idea as the rotate knob's stem.
 * `heightPx` is the loop's own drawn height, so the offset grows with a fat loop and never
 * collapses on a thin one.
 */
export const rotationGripOffPx = (heightPx: number) => Math.max(18, heightPx / 2 + 14)

/** What a Rotation is laid down with when the operator taps ONCE instead of naming two places
 *  (see IncidentWorkspace / Whiteboard placement): a 300 m run on the map, 40 % of the plan width
 *  on the Plan. Both go through `rotationBox`, so a default-placed loop obeys the same width rule
 *  as one that was stretched between two symbols. */
export const ROTATION_DEFAULT_RUN_M = 300
export const ROTATION_DEFAULT_RUN_N = 0.4

/** …and back out of the box: how far the two ends actually stand apart. */
export const rotationRun = (size: number, aspect: number | undefined) =>
  Math.max(0, size - size * shapeAspect('rotation', aspect))

/** The tallest a shape may be relative to its length. A Rotation is a RUN and may never be
 *  taller than it is long (the degenerate sliver shapeAspect refuses); a Rechteck is a box. */
export const shapeAspectMax = (kind: ShapeKind) => (kind === 'rotation' ? 1 : 5)

export const SHAPE_STROKE_DEFAULT = 5
export const shapeStrokeFactor = (strokeW?: number) => (strokeW ?? SHAPE_STROKE_DEFAULT) / SHAPE_STROKE_DEFAULT

/**
 * The outline's width in BOX UNITS, for a shape whose box is `boxPx` wide on screen.
 *
 * ⚠️ A Form's outline is the SAME line width as a drawn Zeichnung — the identical 3 · 5 · 8 that
 * `appConfig.drawing.widths` gives a Linie or a Fläche, in real pixels — and it must stay that
 * width whatever is done to the shape. Everything inside the glyph is drawn in a 0..100 box that
 * is then stretched to the shape's pixels, so N units render N·boxPx/100 px: a stroke declared in
 * units gets heavier as the shape is dragged bigger, which is why widening a Rotation used to
 * thicken it. Dividing by the box's own pixel width cancels that exactly.
 *
 * ⚠️ Both renderers work this out for themselves, because neither can be told by the other: the
 * live glyph knows its marker's pixel box, and the print string is built against the box the
 * server will raster it at (lib/krokiPayload · shapePx × krokiSymbolMul). Paper then scales the
 * shape's outline and a Zeichnung's width by the same page factor, so the two match there too.
 * `vector-effect="non-scaling-stroke"` would say all this in one attribute and is not an option:
 * resvg ignores it (measured 01.09. — a 4:1 stretched rect still rasterised 24px × 6px).
 *
 * Without a `boxPx` (an icon in a picker or a sheet header) the shape falls back to the weight it
 * has always been drawn at, which is what reads best at 40px.
 */
/** The weight each kind has always been drawn at in its 0..100 box — the icon fallback, and the
 *  look a shape at its default size has carried since before the width control existed. */
const ROTATION_STROKE_UNITS = 3.52 // = 100 · 0.32 · 0.11, the old h-fraction at the default aspect
const SQUARE_STROKE_UNITS = 5

const strokeUnits = (fallback: number, strokeW?: number, boxPx?: number, shortSide = 100) => {
  // ⚠️ No unit floor here beyond «not zero»: on a big box a 3px line genuinely IS a fifth of a
  // unit, and a floor expressed in units would quietly fatten exactly the long shapes this fix is
  // for. What must not vanish is the PIXEL width, and that is the number being asked for.
  const w = boxPx && boxPx > 0
    ? Math.max(0.01, ((strokeW ?? SHAPE_STROKE_DEFAULT) * 100) / boxPx)
    : fallback * shapeStrokeFactor(strokeW)
  // ⚠️ …but never wider than the shape it outlines. A Rechteck dragged to a flat sliver, or a box
  // shown at a few pixels, has a short side of a couple of units — and a line that does not fit
  // inside its own box paints over itself and reads as a solid bar.
  return Math.min(w, Math.max(0.4, shortSide * 0.5))
}

/**
 * A Rechteck's viewBox, matched to its aspect — the same fix the Rotation carries.
 *
 * ⚠️ The box is drawn `preserveAspectRatio="none"` into w × w·asp px, so on a SQUARE 0..100
 * viewBox one unit of y is `asp` units of x: a stretched Rechteck came out with fat verticals and
 * a hairline top and bottom (01.09.). Matching the viewBox to the box makes the units square
 * again, and one stroke-width means the same thing on all four sides.
 */
export const squareViewBox = (asp: number) => `0 0 100 ${(100 * asp).toFixed(2)}`

/** The wash a Rechteck carries when nothing has been chosen — the opacity it has always had. */
export const SQUARE_FILL_DEFAULT = 0.18
/** The Schraffur's geometry, in CSS px. ⚠️ The same numbers a drawn Fläche hatches with
 *  (lib/draw · HATCH_PERIOD_PX / HATCH_WIDTH_PX) — inlined rather than imported so this module
 *  stays free of the drawing layer, and they must move together. */
const HATCH_PERIOD_PX = 12
const HATCH_WIDTH_PX = 1.6

/**
 * The Rechteck outline, shared as a string so the print path prints the identical artwork.
 *
 * Fill is the SAME question a Fläche answers — a wash at `fillOpacity`, or the Schraffur — because
 * a Rechteck is a Fläche that came pre-shaped. The hatch is a real SVG pattern inside this string,
 * so screen and paper draw one drawing (resvg renders patterns); its period is converted through
 * `boxPx` like the stroke, so stretching the box cannot smear it.
 */
export function squareInner(color: string, asp: number, strokeW?: number, boxPx?: number, fillOpacity?: number, hatch?: boolean, sharpCorners?: boolean): string {
  const h = 100 * asp
  // the same rule as the Rotation: the weight belongs to the shape, not to how big it was dragged
  const sw = strokeUnits(SQUARE_STROKE_UNITS, strokeW, boxPx, Math.min(100, h))
  const inset = sw / 2 + Math.min(100, h) * 0.035
  // rounded by default, square on request — a hand-drawn Fläche has the corners its points make
  const r = sharpCorners ? 0 : Math.min(6, Math.max(0, (Math.min(100, h) - 2 * inset) / 4))
  const perUnit = boxPx && boxPx > 0 ? 100 / boxPx : 1
  const id = `sqh-${color.replace(/[^a-z0-9]/gi, '')}-${Math.round(perUnit * 1000)}`
  const period = HATCH_PERIOD_PX * perUnit
  const defs = hatch
    ? `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="${period.toFixed(3)}" height="${period.toFixed(3)}"`
      + ` patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${period.toFixed(3)}" stroke="${color}"`
      + ` stroke-width="${(HATCH_WIDTH_PX * perUnit).toFixed(3)}"/></pattern></defs>`
    : ''
  const opacity = fillOpacity ?? SQUARE_FILL_DEFAULT
  const fill = hatch ? `fill="url(#${id})"` : `fill="${color}" fill-opacity="${opacity}"`
  return defs
    + `<rect x="${inset.toFixed(2)}" y="${inset.toFixed(2)}" width="${Math.max(0.5, 100 - 2 * inset).toFixed(2)}"`
    + ` height="${Math.max(0.5, h - 2 * inset).toFixed(2)}" rx="${r.toFixed(2)}"`
    + ` ${fill} stroke="${color}" stroke-width="${sw.toFixed(3)}"/>`
}

// Effective height/width ratio of a placed shape (absent = 1 = the original square box).
// Clamped so a degenerate stored value can't render a sliver; aspect-locked kinds are always 1.
// Mirrored server-side in backend/app/kroki.py (same per-kind floors, same 5.0 ceiling).
export function shapeAspect(kind: ShapeKind, aspect: number | undefined): number {
  if (!SHAPE_FREE_ASPECT[kind]) return 1
  // ⚠️ A Rotation is a RUN and may never be taller than it is long. Dragging the corner back
  // through the centre used to invert it into a thin vertical sliver with the arrows pointing at
  // each other — a shape that means nothing (01.09.). Capped at 1, so the worst case is a circle.
  const hi = kind === 'rotation' ? 1 : 5
  // ⚠️ …and its FLOOR is far lower than a box's, because a lean Rotation is not degenerate: its
  // width is capped in metres (ROTATION_W_M), so a kilometres-long Wasserpendel legitimately
  // stores an aspect of a few thousandths. The general 0.02 floor silently fattened exactly
  // those — it is there to stop a garbage value rendering a sliver, not to widen a real run.
  const lo = kind === 'rotation' ? ROTATION_ASPECT_MIN : 0.02
  return Math.max(lo, Math.min(hi, aspect ?? SHAPE_DEFS[kind].defaultAspect ?? 1))
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
/**
 * The loop's viewBox. `fit` (a picker cell) widens it vertically to include the arrowheads'
 * overhang, so the whole sign sits INSIDE the icon box.
 *
 * ⚠️ On the map the heads deliberately overhang the legs — that is what keeps the direction
 * legible on a long thin run, and the marker paints with `overflow: visible`. In a 40px cell the
 * same overhang just spills over the cell's edge and reads as a broken drawing.
 */
export const rotationViewBox = (asp: number, fit = false) => {
  const h = 100 * asp
  if (!fit) return `0 0 100 ${h.toFixed(2)}`
  const over = h * 0.3 // = the head's half-height (rotationInner · a)
  return `-2 ${(-over).toFixed(2)} 104 ${(h + 2 * over).toFixed(2)}`
}

export function rotationInner(color: string, asp: number, carrier?: RotationCarrier, strokeW?: number, boxPx?: number, reverse?: boolean): string {
  const h = 100 * asp
  // ⚠️ EVERYTHING here is a fraction of the loop's HEIGHT, with no absolute floor. A user unit is
  // width/100, and the box's px width grows with the run — so h itself is CONSTANT in px as the
  // loop lengthens (h_px = W·asp, and asp = width/length). Anything sized as a fixed number of
  // units therefore grew with the run instead: the clamps this used to carry were exactly that,
  // and they are why a long Rotation came out with a fat outline and arrowheads the size of a
  // vehicle (01.09.). Fractions of h stay put, which is «gleiche Strichstärke, nur länger».
  // ⚠️ Off the shape's SIZE RATIO, not off `h` (01.09.). A fraction of the loop's height is
  // constant on screen while the run LENGTHENS — that is what it was tuned for — but the width
  // grip changes `h` itself, so widening the loop fattened its outline and blew the direction
  // heads up with it. Both now cancel the box's scaling (shapeSizeRel), so a drag on either grip
  // moves the loop's length and width and leaves its weight alone.
  const sw = strokeUnits(ROTATION_STROKE_UNITS, strokeW, boxPx, h)
  // …and the heads follow the stroke, so one line weight describes the whole sign. Never taller
  // than the loop itself: on a thin run a head sized off the stroke would swallow it.
  const a = Math.min(h * 0.42, sw * 2.2)
  const inset = sw / 2 + h * 0.02
  const r = Math.max(0.5, (h - 2 * inset) / 2)
  const head = (cx: number, cy: number, dir: 1 | -1) =>
    `<path d="M ${(cx - dir * a).toFixed(2)} ${(cy - a).toFixed(2)} L ${(cx + dir * a).toFixed(2)} ${cy.toFixed(2)}`
    + ` L ${(cx - dir * a).toFixed(2)} ${(cy + a).toFixed(2)} Z" fill="${color}"/>`
  // the heads sit well out towards the ends, which keeps them clear of a carrier badge in the
  // middle and still on the straight legs at any length. `reverse` mirrors them (position AND
  // direction): the circulation sense turns around, the loop itself stays put — a rotation of
  // the whole box could never say this, it preserves the sense.
  return `<rect x="${inset.toFixed(2)}" y="${inset.toFixed(2)}" width="${(100 - 2 * inset).toFixed(2)}"`
    + ` height="${Math.max(0.5, h - 2 * inset).toFixed(2)}" rx="${r.toFixed(2)}" ry="${r.toFixed(2)}"`
    + ` fill="none" stroke="${color}" stroke-width="${sw.toFixed(3)}"/>`
    + head(reverse ? 26 : 74, inset, reverse ? -1 : 1)          // outbound, on the top leg
    + head(reverse ? 74 : 26, h - inset, reverse ? 1 : -1)      // …and back along the bottom
    + rotationCarrierGlyph(carrier, color, h, sw)
}

/** Which vehicle runs the shuttle — the FKS sheet draws the loop with its carrier above it
 *  («Rotation-Helikopter», «Rotation TLF», Vegetationsbrand S. 52). */
export type RotationCarrier = 'heli' | 'tlf'

/**
 * The carrier badge, centred over the loop. Empty for a plain Rotation.
 *
 * ⚠️ Sized off the STROKE, not off the loop's height (01.09.). The badge is a LABEL — «welches
 * Fahrzeug pendelt» — and a label is read at a size, not at a ground distance. Off `h` it grew
 * with the loop's WIDTH, and since the width now follows the run (rotationBox), a Wasserpendel
 * across the map printed a «TLF» the size of a city block. The stroke is a real pixel width
 * (strokeUnits), so anything derived from it stays the same size on screen at every run length —
 * exactly the reasoning the direction heads already follow.
 *
 * Still clamped against `h`: on a deliberately thin loop the badge must sit inside its own sign
 * rather than swallow it.
 */
function rotationCarrierGlyph(carrier: RotationCarrier | undefined, color: string, h: number, sw: number): string {
  if (!carrier) return ''
  const cy = h / 2
  // ⚠️ the «don't vanish» floor is in USER UNITS, which are a share of the box — so it has to be
  // tiny, or it becomes the binding number on exactly the long runs this sizing is for
  const s = Math.max(0.01, Math.min(sw * 2.2, h * 0.34)) // the badge's half-height
  if (carrier === 'heli') {
    // the lying eight, the same rotor disc as the FKS Helikopter sign
    const w = s * 1.25, k = s * 0.7
    return `<path d="M ${50 - w} ${cy} C ${50 - w} ${cy - k} ${50 - w * 0.32} ${cy - k} 50 ${cy}`
      + ` C ${50 + w * 0.32} ${cy + k} ${50 + w} ${cy + k} ${50 + w} ${cy}`
      + ` C ${50 + w} ${cy - k} ${50 + w * 0.32} ${cy - k} 50 ${cy}`
      + ` C ${50 - w * 0.32} ${cy + k} ${50 - w} ${cy + k} ${50 - w} ${cy} Z"`
      + ` fill="none" stroke="${color}" stroke-width="${(s * 0.2).toFixed(2)}" stroke-linejoin="round"/>`
  }
  // TLF: the FKS box, lettered
  const bw = s * 1.85, bh = s
  return `<g><rect x="${(50 - bw).toFixed(2)}" y="${(cy - bh).toFixed(2)}" width="${(2 * bw).toFixed(2)}"`
    + ` height="${(2 * bh).toFixed(2)}" fill="#ffffff" fill-opacity="0.85" stroke="${color}"`
    + ` stroke-width="${(s * 0.18).toFixed(2)}"/>`
    + `<text x="50" y="${cy.toFixed(2)}" text-anchor="middle" dy="0.35em"`
    + ` font-family="Arial,sans-serif" font-weight="bold" font-size="${(s * 1.25).toFixed(2)}"`
    + ` fill="${color}">TLF</text></g>`
}


// SVG silhouettes on a 0..100 viewBox. fillOpacity keeps the square/cloud
// readable as translucent overlays (a smoke blob / a zone box) while the arrow
// stays solid for a crisp direction indicator. `stop` (arrow only) draws the
// «→|» Stopp-Balken across the tip — keep it identical to shapeSvgString
// (lib/krokiPayload), which is the same artwork as a plain string for the print path.
export function ShapeGlyph({ kind, color, stop, aspect, fit, carrier, reverse, strokeW, boxPx, fillOpacity, hatch, sharpCorners }: { kind: ShapeKind; color: string; stop?: boolean; aspect?: number; fit?: boolean; carrier?: RotationCarrier;
  /** Rotation: reversed circulation — both direction heads mirrored (rotationInner) */
  reverse?: boolean; strokeW?: number;
  /** the shape's box width in CSS px, so the outline can be the drawn-line width it claims to be
   *  (lib/shapes · strokeUnits). Absent on an icon, which keeps the picker weight. */
  boxPx?: number;
  /** fill, exactly as a Fläche answers it (lib/shapes · squareInner) */
  fillOpacity?: number; hatch?: boolean; sharpCorners?: boolean }) {
  if (kind === 'rotation') {
    // ⚠️ `fit` also means «this is an ICON». At the placement aspect (0.32) the loop letterboxes
    // into a 40px cell as a 13px-tall sliver with a 1px outline — technically right, unreadable
    // as a picker. The preview is drawn stockier; what gets PLACED is still defaultAspect.
    const asp = fit ? ROTATION_PREVIEW_ASPECT : shapeAspect('rotation', aspect)
    return (
      // `fit` = keep the proportions inside whatever box the host gives (the palette cell is
      // square, and a loop stretched to fill it would advertise a shape nobody gets). On the map
      // and the plan the box IS the shape, so it paints edge to edge.
      <svg className="shape-svg" viewBox={rotationViewBox(asp, fit)} width="100%" height="100%"
        preserveAspectRatio={fit ? 'xMidYMid meet' : 'none'} style={{ overflow: fit ? 'hidden' : 'visible' }}>
        <g dangerouslySetInnerHTML={{ __html: rotationInner(color, asp, carrier, strokeW, boxPx, reverse) }} />
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
    // …on an aspect-matched viewBox, so the outline is the same weight on all four sides however
    // far the box is stretched (squareViewBox). `fit` letterboxes it into the host's box instead
    // of filling it, which is what a picker cell and the editor's header tile want; the box keeps
    // its own proportions either way (a Rotation is the one kind that previews stockier).
    const asp = shapeAspect('square', aspect)
    return (
      <svg className="shape-svg" viewBox={squareViewBox(asp)} width="100%" height="100%"
        preserveAspectRatio={fit ? 'xMidYMid meet' : 'none'}>
        <g dangerouslySetInnerHTML={{ __html: squareInner(color, asp, strokeW, boxPx, fillOpacity, hatch, sharpCorners) }} />
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
