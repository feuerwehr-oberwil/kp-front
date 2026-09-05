import type { ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { Popover } from '../lib/overlays'
import s from './PlanCompass.module.css'

/**
 * The Gebäude's north dial, pinned to the top-right corner of the plan VIEWPORT.
 *
 * ⚠️ It used to be drawn inside the topmost storey tile, which meant it panned and zoomed with
 * the board: the one read-out that answers «which way am I looking» drifted around the screen
 * and off it, and the rotation control it carries went along for the ride. Anchored to the
 * viewport it is always in the same corner, on every form factor — the map's floating utilities
 * (MapUtility · the phone's .phone-wx read-out) wear the same glass, because this belongs to the screen, not to the
 * paper.
 *
 * `deg` is the ACTIVE view angle including the popover's live preview, so the needle turns with
 * the slider before the rotation is committed. Pass `controls` (the orientation popover's
 * contents) to make the chip the one door to rotating the building; without them — a viewer, a
 * replay, a footprint that was never turned — it is a plain read-out.
 */
export function PlanCompass({ deg, controls }: { deg: number; controls?: ReactNode }) {
  // no ring circle: the chip's own round glass edge IS the dial's ring. Geometry otherwise as
  // printed (backend · kroki · north_dial_svg) — N inside the ring, needle a dart in ink.
  const dial = (
    <svg viewBox="-25 -25 50 50" aria-hidden>
      <g style={{ transform: `rotate(${deg}deg)`, transformOrigin: '0px 0px' }}>
        <text y="-13" className={s.n}>{appConfig.copy.whiteboard.northLabel}</text>
        <path d="M0 -8 L10 16 L0 7 L-10 16 Z" className={s.needle} />
      </g>
    </svg>
  )
  if (!controls) {
    return (
      <div className={s.chip} role="img" title={appConfig.copy.whiteboard.northTitle} aria-label={appConfig.copy.whiteboard.northTitle}>
        {dial}
      </div>
    )
  }
  return (
    <Popover
      ariaLabel={appConfig.copy.whiteboard.orientMenuTitle}
      popupClassName="wb-orient-popup"
      side="bottom" align="end" zIndex={30}
      trigger={
        <button type="button" className={`${s.chip} ${s.btn}`}
          title={appConfig.copy.whiteboard.orientMenuTitle}
          aria-label={appConfig.copy.whiteboard.orientMenuTitle}
        >{dial}</button>
      }
    >{controls}</Popover>
  )
}
