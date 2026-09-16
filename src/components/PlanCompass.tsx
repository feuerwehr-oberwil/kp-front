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
export function PlanCompass({ deg, controls, northUnknown = false }: { deg: number; controls?: ReactNode; northUnknown?: boolean }) {
  // no ring circle: the chip's own round glass edge IS the dial's ring. Geometry otherwise as
  // printed (backend · kroki · north_dial_svg) — N inside the ring, needle a dart in ink.
  // ⚠️ A Geschossplan that is not linked to the map has NO known north (16.09.2026): it can still
  // be turned – that is what the popover is for – but a needle would be pointing at a direction
  // nobody measured. The dial then wears the turn arrow instead, and says why in its title.
  const dial = northUnknown ? (
    <svg viewBox="-25 -25 50 50" aria-hidden>
      <g className={s.unknown} style={{ transform: `rotate(${deg}deg)`, transformOrigin: '0px 0px' }}>
        <path d="M-11 -3 A11 11 0 1 1 -6 8" fill="none" strokeWidth="3.4" strokeLinecap="round" />
        <path d="M-11 -9 L-11 -2 L-4.5 -2 Z" />
      </g>
    </svg>
  ) : (
    <svg viewBox="-25 -25 50 50" aria-hidden>
      <g style={{ transform: `rotate(${deg}deg)`, transformOrigin: '0px 0px' }}>
        <text y="-13" className={s.n}>{appConfig.copy.whiteboard.northLabel}</text>
        <path d="M0 -8 L10 16 L0 7 L-10 16 Z" className={s.needle} />
      </g>
    </svg>
  )
  const title = northUnknown ? appConfig.copy.whiteboard.northUnknownTitle : appConfig.copy.whiteboard.northTitle
  if (!controls) {
    return (
      <div className={s.chip} role="img" title={title} aria-label={title}>
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
