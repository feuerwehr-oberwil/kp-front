import { useRef, type CSSProperties, type ReactNode } from 'react'
import { SheetGrab } from './SheetGrab'

/** The three heights of a {@link DetentSheet}: one line, list + plan, list only. */
export type Detent = 'peek' | 'half' | 'full'
const ORDER: Detent[] = ['peek', 'half', 'full']

/**
 * A NON-modal phone bottom sheet with three detents — peek · half · full — the Google-Maps shape
 * (24.09.2026, built for the Suche: the plan or the Karte stays underneath, the list is pulled
 * over it). It is the one primitive of its kind; a surface that needs «a list over a live
 * surface» on a phone takes this rather than a copy.
 *
 * ⚠️ Deliberately NOT a Base UI dialog (AGENTS.md · overlays): there is no backdrop, no focus trap
 * and no scroll-lock, because the surface underneath has to stay fully usable — pan, pinch, tap a
 * storey — at every detent. What it does share with the modal sheets is the ONE grab bar
 * (`SheetGrab`) and the gesture vocabulary: drag the head up or down and it snaps by DIRECTION
 * (≥ 40 px is enough, like `useSheetDrag`), a tap on the bar steps it up (peek → half → full →
 * half). It never closes itself by a swipe — pushing it down stops at «peek», a line that stays
 * out of the way — so the only way out is the owner's explicit ✕.
 *
 * Where it sits is the OWNER's business, through two custom properties on the frame:
 * `--detent-bottom` (the nav bar it must never cover) and `--detent-top` (the top bar). The
 * heights are CSS (13-incident.css · .ui-detent), so a drag only ever moves one inline variable.
 */
export function DetentSheet({ detent, onDetent, head, peek, children, className, ariaLabel, style }: {
  detent: Detent
  onDetent: (d: Detent) => void
  /** the draggable head below the bar — at «peek» it is all there is, so it carries the one line */
  head: ReactNode
  /** extra content shown ONLY at peek, under the head (e.g. a strip of floor chips) */
  peek?: ReactNode
  /** the body, scrolled on its own (hidden at peek) */
  children: ReactNode
  className?: string
  ariaLabel: string
  style?: CSSProperties
}) {
  const drag = useRef<{ y0: number; h0: number; el: HTMLElement; moved: boolean; onGrab: boolean } | null>(null)

  const down = (e: React.PointerEvent<HTMLElement>) => {
    // a control inside the head keeps its own press (the ✕, the Gebäude | Karte switch, a chip)
    const t = e.target as HTMLElement
    if (t.closest('button, a, input, [role="button"], [role="tab"]') && !t.closest('.ui-sheet-grab')) return
    const el = e.currentTarget.closest('.ui-detent') as HTMLElement | null
    if (!el) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    el.classList.add('is-dragging')
    // ⚠️ read where the press STARTED: with the pointer captured, the release is targeted at the
    // head itself, so a tap on the bar could not be told from a tap beside it at release time
    drag.current = { y0: e.clientY, h0: el.getBoundingClientRect().height, el, moved: false, onGrab: !!t.closest('.ui-sheet-grab') }
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dy = d.y0 - e.clientY
    if (Math.abs(dy) > 4) d.moved = true
    d.el.style.setProperty('--detent-live', `${Math.max(56, d.h0 + dy)}px`)
  }
  const up = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    d.el.classList.remove('is-dragging')
    d.el.style.removeProperty('--detent-live')
    const i = ORDER.indexOf(detent)
    if (!d.moved) {
      // a tap on the bar (or on the peek line) steps UP; at the top it comes back to half
      if (d.onGrab || detent === 'peek') onDetent(detent === 'full' ? 'half' : ORDER[i + 1])
      return
    }
    const dy = d.y0 - e.clientY
    if (dy > 40) onDetent(ORDER[Math.min(ORDER.length - 1, i + (dy > 260 ? 2 : 1))])
    else if (dy < -40) onDetent(ORDER[Math.max(0, i - (dy < -260 ? 2 : 1))])
  }

  return (
    <section className={`ui-detent is-${detent}${className ? ` ${className}` : ''}`} aria-label={ariaLabel} style={style} data-detent={detent}>
      <div className="ui-detent-head" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <SheetGrab />
        {head}
      </div>
      {detent === 'peek' && peek}
      <div className="ui-detent-body" hidden={detent === 'peek'}>{children}</div>
    </section>
  )
}
