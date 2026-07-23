import type { Spread } from '../types'

// Shared rendering of a placed FireGIS tactical symbol — used IDENTICALLY by the
// Lage map (MapView) and the Plan whiteboard (Whiteboard), so the glyph, the
// white legibility chip, the rotation transform, and the floor/count badges are
// defined once instead of forked per surface. Callers supply the pixel size
// (the map ties it to real-world metres; the plan to the board scale) and which
// badges apply; the decoration logic lives here.

// Outline symbols (no solid fill — e.g. KP Front, Sammelstelle, hydrants) get a
// white chip behind them so the thin strokes stay legible; solid icons (Feuer F,
// Rettungen R) already read on their own and render directly.
export const needsWhite = (svg: string) => svg.includes('fill="none"')

// the symbol's own accent colour — its first non-black fill, else first non-black
// stroke (black is the glyph/outline). Used to tint the floor badge. Falls back to
// the app blue when a symbol has no colour of its own.
export const symColor = (svg: string): string => {
  const colours = [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase())
  return colours.find((c) => c !== '#000000') ?? '#1f6feb'
}

// signed storey label for the badge: +2, -1, 0 (EG)
export const floorBadge = (f: number) => (f > 0 ? `+${f}` : `${f}`)

// ── Grosslüfter: a composite of a vehicle body + an overlaid fan, each independently
// rotatable (the vehicle heading vs. the airflow direction). The two source glyphs are the
// authoritative FireGIS «VKF Fahrzeug» (carrier) and «VKF Luefter mobil» (fan); we stack the
// fan, scaled down, centred on the body. NOT an invented glyph — it's a documented combination.
export const GROSSLUEFTER = 'Grosslüfter'
export const GROSSLUEFTER_BODY = 'VKF Fahrzeug'
export const GROSSLUEFTER_FAN = 'VKF Luefter mobil'
// the mobile Lüfter + its extract/Absaugen variant (SAME fan, airflow arrow reversed to point INTO
// the fan). The variant is a render-only glyph (kept in `byName`, hidden from the palette — see
// useSymbols); a placed Lüfter carries `extract` and stays named 'VKF Luefter mobil', so presets,
// captions and the Grosslüfter fan reference all key off the one canonical name.
export const LUEFTER = 'VKF Luefter mobil'
export const LUEFTER_EXTRACT = 'VKF Luefter mobil saugend'
/** the library name to render for a placed symbol — the reversed-arrow glyph for an extract Lüfter,
 *  the symbol's own name otherwise. */
export const luefterVariant = (name: string | undefined, extract?: boolean): string | undefined =>
  extract && name === LUEFTER ? LUEFTER_EXTRACT : name
// the fan reads at ~60% of the body box so the carrier stays recognisable behind it
export const FAN_OVERLAY_SCALE = 0.6
// strip a glyph's outer <svg> wrapper, keeping its inner paths (for nesting one glyph in another)
const innerSvg = (svg: string) => svg.replace(/^\s*<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
// A static composite: base body + overlaid part, the part rotated `partDeg` about the shared centre
// (0,0) and scaled. Used for the palette thumbnail (partDeg 0) and the server print (where the two
// layers can't be separate DOM nodes). The live map/plan instead render them as two independently-
// rotatable divs (TacticalSymbol `overlay`), so each part rotates on its own.
export function composeCompositeSvg(baseSvg: string, partSvg: string, scale = FAN_OVERLAY_SCALE, partDeg = 0): string {
  if (!baseSvg || !partSvg) return baseSvg || partSvg
  const part = `<g transform="rotate(${partDeg}) scale(${scale})">${innerSvg(partSvg)}</g>`
  return `<svg viewBox="-1.3 -1.3 2.6 2.6" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">${innerSvg(baseSvg)}${part}</svg>`
}

// ── Composite symbols: a carrier body + a second part that rotates independently ─────────────
// The Grosslüfter (vehicle + fan/airflow) and the aerial appliances (Drehleiter ladder / Hubretter
// articulated boom) all render as two stacked, separately-rotatable layers: the body by `rotation`,
// the overlaid part by `rotation2`. The part glyphs are render-only (hidden from the palette by
// useSymbols); the full authored VKF Drehleiter / VKF Hubretter glyphs stay as the palette thumbnails.
export const DREHLEITER = 'VKF Drehleiter'
export const HUBRETTER = 'VKF Hubretter'
export const DREHLEITER_PART = 'VKF Drehleiter Leiter'
export const HUBRETTER_PART = 'VKF Hubretter Arm'

/** One composite's parts. `partExtract`/`airflow` are the Lüfter's reversed-airflow specifics; the
 *  ladders leave them unset (the boom/ladder has no airflow). `partLabel` is the contextPanel copy
 *  key naming the part's rotor + Drehung stepper (fan vs. ladder). */
export interface CompositeSpec {
  base: string
  part: string
  partExtract?: string
  scale: number
  airflow?: boolean
  partLabel: 'rotationFan' | 'rotationLadder'
}
export const COMPOSITES: Record<string, CompositeSpec> = {
  // base = the plain vehicle body (VKF Fahrzeug); each part slews on `rotation2`. The Hubretter is
  // NOT a rotation composite — its boom is a variable-reach, cage-draggable element (see below).
  [GROSSLUEFTER]: { base: GROSSLUEFTER_BODY, part: GROSSLUEFTER_FAN, partExtract: LUEFTER_EXTRACT, scale: FAN_OVERLAY_SCALE, airflow: true, partLabel: 'rotationFan' },
  [DREHLEITER]: { base: GROSSLUEFTER_BODY, part: DREHLEITER_PART, scale: 1, partLabel: 'rotationLadder' },
}
export const compositeSpec = (name?: string): CompositeSpec | undefined => (name ? COMPOSITES[name] : undefined)
/** the render-only overlay part glyphs — hidden from the palette (like the reversed-airflow Lüfter). */
export const COMPOSITE_PART_GLYPHS: string[] = [LUEFTER_EXTRACT, DREHLEITER_PART, HUBRETTER_PART]
/** the library glyph name for a composite's overlay part, honouring the Lüfter airflow variant. */
export const compositePartGlyph = (spec: CompositeSpec, extract?: boolean): string =>
  spec.airflow && extract && spec.partExtract ? spec.partExtract : spec.part

// ── Hubretter: a variable-reach articulated boom the operator shapes by dragging the cage tip ────
// Unlike the composite rotors, the boom isn't a fixed glyph: it extends from the truck (the symbol
// `coord`) out to a rescue cage at a stored reach (`Entity.reachM` metres on the map / `BoardAnno.reachN`
// board-fraction on the plan) and bearing (`rotation2`). The truck body auto-faces the boom; there's
// no rotor — the single cage handle sets both bearing and reach.
export const isHubretter = (name?: string): boolean => name === HUBRETTER
/** The auto-articulated knuckle for a boom drawn from `base` to `tip`: a point ~`along` of the way
 *  from base to tip, pushed perpendicular by `offset`×length, so the boom reads as a bent Gelenkmast
 *  rather than a straight stick. Pure (same inputs → same point). Perp = base→tip rotated +90°. */
export function boomKnuckle(base: readonly [number, number], tip: readonly [number, number], along = 0.55, offset = 0.18): [number, number] {
  const dx = tip[0] - base[0], dy = tip[1] - base[1]
  return [base[0] + dx * along - dy * offset, base[1] + dy * along + dx * offset]
}

/** The visual boom for a Hubretter: an articulated base→knuckle→cage polyline with a rescue cage at
 *  the tip, drawn from the truck centre (0,0) out `lengthPx` at screen bearing `deg`. Rendered ON TOP
 *  of the body glyph (the boom mounts on the turntable / roof) — the caller places it AFTER the body
 *  in the DOM. SHARED by Lage + Plan so the boom reads identically; each surface positions the
 *  draggable cage handle itself. A white underlay keeps the ink legible over the body + busy tiles. */
export function HubretterBoom({ lengthPx, deg, color = '#00a0ff' }: { lengthPx: number; deg: number; color?: string }) {
  const L = Math.max(0, lengthPx)
  const rad = (deg * Math.PI) / 180
  const tip: [number, number] = [Math.cos(rad) * L, Math.sin(rad) * L]
  const k = boomKnuckle([0, 0], tip)
  const sw = Math.max(3, Math.min(6, L * 0.05))
  const cage = Math.max(9, Math.min(18, L * 0.16))
  const box = L + cage + sw + 2
  const pts = `0,0 ${k[0].toFixed(1)},${k[1].toFixed(1)} ${tip[0].toFixed(1)},${tip[1].toFixed(1)}`
  // placed AFTER the body glyph in the DOM, so it paints on top — the boom mounts on the turntable
  // (the truck's roof) and reaches out over the vehicle, not from underneath it.
  return (
    // zIndex 2 keeps the boom above the body even when selected — `.marker.sel .ts` gets z-index:1,
    // which would otherwise lift the truck back over the boom. Still below the handles (z 8–9).
    <svg className="ts-boom" viewBox={`${-box} ${-box} ${2 * box} ${2 * box}`}
      style={{ position: 'absolute', left: '50%', top: '50%', width: 2 * box, height: 2 * box, transform: 'translate(-50%,-50%)', overflow: 'visible', pointerEvents: 'none', zIndex: 2 }}>
      <polyline points={pts} fill="none" stroke="#fff" strokeWidth={sw + 2.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />
      <rect x={tip[0] - cage / 2} y={tip[1] - cage / 2} width={cage} height={cage} rx={cage * 0.18}
        fill="var(--on-accent-ink, #fff)" stroke={color} strokeWidth={Math.max(2, sw * 0.8)} />
    </svg>
  )
}

/** A static Hubretter (plain body + articulated boom baked at its bearing) for the server print, where
 *  the two live layers can't exist and the boom isn't metre-scaled. Reach is approximated to the glyph
 *  box — capped so the truck stays readable — good enough for the rapport; the metric print is deferred.
 *  Returns one SVG string; the caller prints it with rotation unset (the bearing is baked in). */
export function composeHubretterSvg(bodySvg: string, reachM = 18, boomDeg = 0, bodyDeg = 0): string {
  if (!bodySvg) return bodySvg
  const L = Math.max(0.9, Math.min(1.8, reachM / 20)) // glyph-box units; capped so the body stays legible
  const rad = (boomDeg * Math.PI) / 180
  const tip: [number, number] = [Math.cos(rad) * L, Math.sin(rad) * L]
  const k = boomKnuckle([0, 0], tip)
  const cage = 0.26
  const pts = `0,0 ${k[0].toFixed(2)},${k[1].toFixed(2)} ${tip[0].toFixed(2)},${tip[1].toFixed(2)}`
  const boom = `<polyline points="${pts}" fill="none" stroke="#00a0ff" stroke-width="0.16" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<rect x="${(tip[0] - cage / 2).toFixed(2)}" y="${(tip[1] - cage / 2).toFixed(2)}" width="${cage}" height="${cage}" rx="0.05" fill="#fff" stroke="#00a0ff" stroke-width="0.11"/>`
  const body = `<g transform="rotate(${bodyDeg})">${innerSvg(bodySvg)}</g>` // truck heading, independent of the boom
  const box = L + 0.6
  // body first, boom second → the boom paints ON TOP (mounted on the turntable / roof)
  return `<svg viewBox="${-box} ${-box} ${2 * box} ${2 * box}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">${body}${boom}</svg>`
}

// FKS Entwicklung overlay: hollow block arrows (in the symbol's colour) drawn OUTSIDE
// the glyph so they read against a same-coloured icon. Horizontal development is
// left/right (E/W) on the sides; vertical is up/down on the top/bottom. `bounded`
// adds the Entwicklungsgrenze bar (→|) just past the tip. One up-pointing arrow shape
// is rotated to each edge. Lives in a 2× overlay box centred on the glyph (25..75).
// up-pointing block arrow, emanating from the glyph's top edge (~30) to the tip (~8);
// the Entwicklungsgrenze is a hollow rectangle (a bar) just past the tip.
const BLOCK_ARROW = 'M42 30 L42 20 L34 20 L50 8 L66 20 L58 20 L58 30 Z'
function BlockArrow({ deg, bounded, color }: { deg: number; bounded?: boolean; color: string }) {
  return (
    <g transform={`rotate(${deg} 50 50)`} fill="#fff" stroke={color} strokeWidth={3.5} strokeLinejoin="round">
      <path d={BLOCK_ARROW} />
      {bounded && <rect x="33" y="1" width="34" height="6" rx="1.5" strokeWidth={3} />}
    </g>
  )
}
function SpreadArrows({ spread, color }: { spread: Spread; color: string }) {
  const { h, hBounded, up, down, vBounded } = spread
  if (!h && !up && !down) return null
  return (
    <svg className="sym-spread" viewBox="0 0 100 100" aria-hidden="true">
      {up && <BlockArrow deg={0} bounded={vBounded} color={color} />}
      {down && <BlockArrow deg={180} bounded={vBounded} color={color} />}
      {h === 'E' && <BlockArrow deg={90} bounded={hBounded} color={color} />}
      {h === 'W' && <BlockArrow deg={270} bounded={hBounded} color={color} />}
    </svg>
  )
}

// combined span label for stairs/lift, e.g. "-1/+3" (drops a side that is unset)
const floorRangeBadge = (from?: number, to?: number) =>
  [from, to].filter((f): f is number => f != null).map(floorBadge).join('/')

export function TacticalSymbol({ svg, sizePx, rotation = 0, overlay, count, floor, floorFrom, floorTo, spread, caption, className }: {
  svg: string
  /** rendered edge length in px (square) */
  sizePx: number
  /** rotation in degrees applied to the inner chip (the white chip rotates with it) */
  rotation?: number
  /** a second glyph stacked on top with its OWN rotation + scale (the Grosslüfter fan over the
   *  vehicle body). Centred on the base; rotates independently of the base `rotation`. */
  overlay?: { svg: string; rotation?: number; scale?: number }
  /** quantity badge at the bottom-right; shown only when > 1 */
  count?: number
  /** signed storey badge at the top-right, tinted to the symbol colour. Pass only
   *  where a floor badge is meaningful (the map); the plan encodes floor by tile. */
  floor?: number
  /** lower / upper storey of a vertical span (stairs, lift) — rendered together in
   *  the top-right slot as "-1/+3". Independent of `floor` (a symbol uses one or the
   *  other); shows on both surfaces. */
  floorFrom?: number
  floorTo?: number
  /** FKS Entwicklung spread arrows (Feuer/Wasser/Gefahrstoffe) — see Spread */
  spread?: Spread
  /** metadata caption printed under the glyph (one or more newline-separated lines). The
   *  caller decides the text + visibility (lib/symbols · symbolCaptionText, zoom gate); this
   *  just renders it as a sibling of the glyph so it never rotates with `rotation`. */
  caption?: string | null
  /** extra class on the outer wrapper (e.g. 'photo' on the map, 'ts-plan' on the plan) */
  className?: string
}) {
  const hasRange = floor == null && (floorFrom != null || floorTo != null)
  return (
    <div className={`ts ${className ?? ''}`} style={{ width: sizePx, height: sizePx }}>
      {spread && <SpreadArrows spread={spread} color={symColor(svg)} />}
      <div
        className={`ts-rot ${needsWhite(svg) ? 'white' : ''}`}
        style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {overlay && (
        <div
          className="ts-rot ts-overlay"
          style={{ transform: `rotate(${overlay.rotation ?? 0}deg) scale(${overlay.scale ?? FAN_OVERLAY_SCALE})` }}
          dangerouslySetInnerHTML={{ __html: overlay.svg }}
        />
      )}
      {floor != null && (
        <span className="sym-floor" style={{ color: symColor(svg) }}>{floorBadge(floor)}</span>
      )}
      {hasRange && (
        <span className="sym-floor" style={{ color: symColor(svg) }}>{floorRangeBadge(floorFrom, floorTo)}</span>
      )}
      {count != null && count > 1 && (
        <span className="sym-count">{count}</span>
      )}
      {caption && (
        <span className="sym-caption">
          {caption.split('\n').map((line, i) => <span key={i}>{line}</span>)}
        </span>
      )}
    </div>
  )
}
