/** The plan half of the «Zwillinge»: the Karte's live vehicles and tactical symbols, drawn onto
 *  a georeferenced sheet.
 *
 *  ⚠️ Deliberately free of MapLibre — the Plan surface must not pull a WebGL map library in to
 *  draw a dozen mirrored glyphs. The mark is GeorefTwinMark; the projection + clip happen in the
 *  Whiteboard, against that sheet's own fit (lib/georefTwins · boardTwins).
 */
import { memo, useRef } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { vehicleSymbolSvg } from '../lib/useVehiclePositions'
import { isVehicleSym } from '../lib/mapView'
import type { BoardTwin } from '../lib/georefTwins'
import { TwinMark } from './GeorefTwinMark'
import { glyphFor, twinName } from '../lib/twinGlyph'
import { symbolCaptionText } from '../lib/symbols'
import { softHyphenateText } from '../lib/symbolWrap'
import type { CaptionMode } from '../types'

// --- the map's vehicles + symbols, on a plan board --------------------------------------------

/**
 * The map's live vehicles and tactical symbols, drawn on a georeferenced plan sheet.
 *
 * Mounted INSIDE `.wb-board`, so a twin pans and zooms with the sheet exactly like an
 * annotation — its position is the normalized plan point times the board's px size, which is
 * the same arithmetic every `.wb-anno` does.
 */
export const GeorefTwinsBoard = memo(function GeorefTwinsBoard({ twins, byName, sW, sH, sizePx, captionMode = 'off', sourceSuppressedCaptions, interactive = true, selectedKey, onOpen, onMove }: {
  twins: BoardTwin[]
  byName: Record<string, string>
  /** the board's rendered size in px (fit × zoom) */
  sW: number
  sH: number
  /** the plan's symbol base size in px, so a twin matches the sheet's own symbols */
  sizePx: number
  captionMode?: CaptionMode
  /** Caption visibility already decided on the source Karte. */
  sourceSuppressedCaptions?: ReadonlySet<string>
  /** the sheet is at rest (the pan tool, no pairing) — only then may a twin answer a tap. */
  interactive?: boolean
  selectedKey?: string | null
  /** tap: open this twin's details, read-only (never edit — see GeorefTwinPanel) */
  onOpen: (twin: BoardTwin) => void
  /**
   * Drag a projection to move the object it mirrors.
   *
   * The point handed back is in the SHEET's normalized space; the Whiteboard runs it through the
   * fit and writes the one source entity on the Karte, so undo, routed Leitungen, audit and
   * Verlauf cannot diverge depending on which picture was dragged. Omitted ⇒ tap-only (a locked
   * surface, a viewer session).
   */
  onMove?: (twin: BoardTwin, pt: { x: number; y: number }, phase: 'start' | 'move' | 'end') => void
}) {
  const C = appConfig.copy.whiteboard.georef
  /**
   * Where the dragged twin STOOD when the finger went down.
   *
   * ⚠️ The delta from TwinMark is cumulative (finger minus its start), so it must be added to a
   * FIXED base. Adding it to `t.pt` looks right and is not: this component is re-rendered mid-drag
   * with the projection already moved, so every event re-applied the whole travel on top of the
   * last one — 25 → 75 → 150 → 250 px for four samples of 25. It read as «way too much», and the
   * factor grew with the number of pointer samples, which is why it looked like a zoom.
   *
   * One ref for the whole list: only one twin is ever dragged at a time.
   */
  const from = useRef<{ x: number; y: number } | null>(null)
  if (!sW || !sH) return null
  return (
    <>
      {twins.map((t) => {
        const e = t.entity
        const name = twinName(e)
        const veh = t.kind === 'vehicle' || isVehicleSym(e)
        const rot = e.rotation ?? 0
        const svg = veh ? vehicleSymbolSvg(name, rot, e.directed ?? true) : glyphFor(e, byName)
        const rawCaption = symbolCaptionText(e, captionMode)
        return (
          <TwinMark
            key={t.key}
            svg={svg}
            sizePx={sizePx}
            rotation={veh ? 0 : rot}
            count={e.count}
            caption={sourceSuppressedCaptions?.has(e.id) ? null : rawCaption ? softHyphenateText(rawCaption) : rawCaption}
            title={fillTemplate(C.twinFromMap, { name })}
            onOpen={() => onOpen(t)}
            // client px → the sheet's own normalized space. A DELTA, not an absolute point:
            // the board's origin moves with every pan and zoom, and the mark has no idea where
            // it sits on screen. Clamped to the sheet, because a projection dragged off the
            // paper has no plan point to name and would fold back through the fit as a
            // coordinate nobody aimed at.
            onMove={onMove && ((phase, dx, dy) => {
              if (phase === 'start') from.current = t.pt
              const base = from.current ?? t.pt
              if (phase === 'end') from.current = null
              // clamped to the sheet: a point off the paper is not a place on this document, and
              // would fold back through the fit as a coordinate nobody aimed at
              onMove(t, {
                x: Math.max(0, Math.min(1, base.x + dx / sW)),
                y: Math.max(0, Math.min(1, base.y + dy / sH)),
              }, phase)
            })}
            interactive={interactive}
            selected={selectedKey === t.key}
            style={{ left: 0, top: 0, transform: `translate(${t.pt.x * sW}px, ${t.pt.y * sH}px) translate(-50%, -50%)` }}
          />
        )
      })}
    </>
  )
})
