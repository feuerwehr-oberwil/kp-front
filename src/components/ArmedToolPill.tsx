// The armed tool's readout: ONE pill at the bottom centre of the map / plan / Tafel while a
// tool is armed – the tool's glyph and its name («F Feuer», «Linie · Freihand»), nothing else
// (owner 23.10.2026, 3am sweep point 3, pick B). It is a readout, not a control: no sentence, no
// ✕, pointer events pass through it to the surface. The way out stays the rail tile (tap the
// armed tool again) and Escape. It replaced the symbol tool's ✕ · «Mehrere» · ⓘ dock on every
// surface; the other tools keep their option docks (Freihand ↔ Punkte, ✓, Strecke ↔ Fläche).
//
// «Mehrere platzieren» is the one thing the old symbol dock did that the pill cannot: it is kept
// as a 44px toggle BESIDE the pill, its word visible, only while a symbol is armed. A hold on the
// rail's Symbol tile was the other option, but on a compact rail that tile is icon-only and a
// still hold there is already the hold-tooltip (ui-conventions · touch vocabulary).
import type { ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { sanitizeSvg } from '../lib/sanitizeSvg'

export function ArmedToolPill({ glyph, name, lock, className }: {
  glyph: ReactNode
  name: string
  /** the «Mehrere platzieren» toggle beside the pill (symbol placement only) */
  lock?: { on: boolean; onToggle: () => void }
  className?: string
}) {
  return (
    <div className={`armed-pill-row${className ? ` ${className}` : ''}`}>
      {/* role=status: it appears because a tool was armed, not because a control was asked */}
      <div className="armed-pill" role="status">
        <span className="armed-pill-glyph" aria-hidden>{glyph}</span>
        <span className="armed-pill-name">{name}</span>
      </div>
      {lock && (
        <button type="button" className={`armed-pill-lock${lock.on ? ' on' : ''}`} aria-pressed={lock.on} onClick={lock.onToggle}>
          <Icon id="place-repeat" /><span>{appConfig.copy.keepPlacing}</span>
        </button>
      )}
    </div>
  )
}

/** A symbol's own SVG as the pill's glyph. ⚠️ SEC-01 – sanitised at this sink: the markup can be
 *  an editor-supplied `symbolSvg` (components/Palette · Cell has the same note). */
export function ArmedSymbolGlyph({ svg }: { svg: string }) {
  return <span className="armed-pill-sym" dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />
}
