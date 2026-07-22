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
// the static composite (default orientation) used for the palette thumbnail / fallback — the live
// map/plan render the two layers separately so each part rotates on its own.
export function composeGrossluefterSvg(bodySvg: string, fanSvg: string): string {
  if (!bodySvg || !fanSvg) return bodySvg || fanSvg
  return `<svg viewBox="-1.3 -1.3 2.6 2.6" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">${innerSvg(bodySvg)}<g transform="scale(${FAN_OVERLAY_SCALE})">${innerSvg(fanSvg)}</g></svg>`
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
