// The armed tool's readout: ONE pill at the bottom centre of the map / plan / Tafel while a
// tool is armed – the tool's glyph and its name («F Feuer», «Linie · Freihand»), nothing else
// (owner 23.10.2026, 3am sweep point 3, pick B). It is a readout, not a control: no sentence,
// pointer events pass through it to the surface. The ways out are the rail tile (tap the armed
// tool again), Escape, and the ✕ beside it (below). It replaced the symbol tool's ✕ · «Mehrere» · ⓘ dock on every
// surface; the other tools keep their option docks (Freihand ↔ Punkte, ✓, Strecke ↔ Fläche).
// A piece of the floating family since the button sweep (CHROME.7, 17.11.2026): `--float-h`, the one
// corner, the name 14/700 – no capsule.
//
// «Mehrere platzieren» is the one thing the old symbol dock did that the pill cannot. A hold on the
// rail's Symbol tile was the other option, but on a compact rail that tile is icon-only and a
// still hold there is already the hold-tooltip (ui-conventions · touch vocabulary).
// …and with it a ✕ (owner, Gebäude round 2, 27.10.2026): with «Mehrere platzieren» on – the
// Durchgang's default on the Gebäude stack – a symbol stays armed after every tap, and there was
// no visible way to stop placing. The pill itself stays a readout.
// The two stand BESIDE the pill as DOCK TILES (owner pick 11, CHROME.3 + .4, 17.11.2026): the
// tool dock's own tiles (`ToolDock · DockTile`) in a row of the dock's material – «Mehrere» and ✕
// «Abbrechen», glyph over word by «Beschriftung» – so a symbol's «Mehrere» and ✕ are the very
// controls a Form's dock carries. No full dock comes back.
//
// ⚠️ Never an ellipsis (owner, sweep 30.10.2026 #8: «Fahrze…» beside «Mehrere platzieren» – «a bit
// ugly … just show the icon rather than the label if space is limiting»). The row climbs the top
// bar's ladder (lib/useHeadFit · climbLadder), MEASURED: first the name folds and the glyph stands
// alone (the symbol's own drawing, just picked from the palette; the name stays the pill's
// aria-label/title – the pill passes pointer events through, so it has no hold to answer), then
// the tiles' words fold (they are buttons, so a hold says each word – `data-holdexplain`,
// lib/holdTooltip). The ladder: lib/armedPillFit.
import { useRef, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { sanitizeSvg } from '../lib/sanitizeSvg'
import { fitArmedPill } from '../lib/armedPillFit'
import { useHeadFit } from '../lib/useHeadFit'
import { useRailLabels } from '../lib/useDevicePrefs'
import { DockTile } from './ToolDock'

export function ArmedToolPill({ glyph, name, lock, onClose, className }: {
  glyph: ReactNode
  name: string
  /** the «Mehrere platzieren» toggle beside the pill (symbol placement only) */
  lock?: { on: boolean; onToggle: () => void }
  /** the ✕ that puts the placing tool down (symbol placement only, after the toggle) */
  onClose?: () => void
  className?: string
}) {
  const row = useRef<HTMLDivElement>(null)
  const worded = useRailLabels() === 'short'
  useHeadFit(row, `${name}|${!!lock}|${!!onClose}|${worded}`, fitArmedPill)
  return (
    <div ref={row} className={`armed-pill-row${className ? ` ${className}` : ''}`}>
      {/* role=status: it appears because a tool was armed, not because a control was asked. The
          name is its label too, so a folded pill (glyph alone) still says it */}
      <div className="armed-pill" role="status" aria-label={name} title={name}>
        <span className="armed-pill-glyph" aria-hidden>{glyph}</span>
        <span className="armed-pill-name">{name}</span>
      </div>
      {(lock || onClose) && (
        <div className={`armed-pill-dock${worded ? ' worded' : ''}`}>
          {lock && <DockTile item={{ type: 'toggle', icon: 'place-repeat', label: appConfig.copy.keepPlacing, short: appConfig.copy.keepPlacingShort, on: lock.on, onClick: lock.onToggle }} worded={worded} />}
          {/* «X on the right everywhere»: the ✕ ends the row */}
          {onClose && <DockTile item={{ type: 'close', onClick: onClose }} worded={worded} />}
        </div>
      )}
    </div>
  )
}

/** A symbol's own SVG as the pill's glyph. ⚠️ SEC-01 – sanitised at this sink: the markup can be
 *  an editor-supplied `symbolSvg` (components/Palette · Cell has the same note). */
export function ArmedSymbolGlyph({ svg }: { svg: string }) {
  return <span className="armed-pill-sym" dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />
}
