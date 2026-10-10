/*
 * **Mobile modal scrolling** (01.10.2026): `useMobileScrollLock` prevents background touch
 * scrolling and edge chaining while `Sheet` / `Overlay` is open, without making portalled
 * pickers inert. Inner vertical lists and the composer's native horizontal suggestions keep
 * their gestures. The composer's mobile Pendenz / time menus retain the sentence's caret for
 * pointer picks (`Menu · keepFocusRef`); keyboard navigation still moves focus into the menu.
 *
 * ⚠️ ONE decision per TOUCH, read off its whole travel since touchstart (10.10.2026, owner's
 * iPhone: «Neuer Eintrag»'s suggestion row could not be scrolled). The lock used to judge every
 * touchmove on its own few pixels — and the FIRST move of a sideways swipe is often 1px down and
 * 1px across, which read as vertical; over a sheet body with nowhere to go vertically that move
 * was `preventDefault`ed, and on iOS a cancelled first touchmove cancels the native pan for the
 * whole touch. So now:
 *   · a touch that STARTS inside `[data-swipe-ignore]` (the suggestion row, the photo zoom, the
 *     pinned Trupps) is never blocked — that surface owns its gesture;
 *   · until the finger has travelled `AXIS_SLOP_PX`, the touch passes if it could scroll along
 *     EITHER axis (a horizontal scroller under it, or a vertical one with room that way), and is
 *     blocked only where nothing could move;
 *   · past the slop its axis is locked for the rest of the touch (a dead tie stays undecided), and
 *     each move is judged on that axis — vertically by that move's own direction — so a drag over
 *     a list at its top edge, or over the bare backdrop, is still cancelled (the rubber-band /
 *     chaining guard this hook exists for).
 * Sideways, «can scroll» means the element scrolls horizontally at all, either way: nothing behind
 * a sheet scrolls sideways, so there is no chaining to guard against, and a jittery first move
 * towards the row's start must not kill a swipe towards its end.
 */

import { useEffect } from 'react'
import { useIsPhone } from '../useIsPhone'

/** Travel (px, either axis) after which a touch's axis is locked. Below it the touch is judged
 *  on both axes at once — the first touchmove is the one iOS keys its native pan on. */
export const AXIS_SLOP_PX = 6

/** What the lock reads off one element on the way up from where the touch started. */
export interface ScrollBox {
  overflowX: string
  overflowY: string
  /** scrollTop */
  top: number
  /** scrollWidth − clientWidth */
  maxX: number
  /** scrollHeight − clientHeight */
  maxY: number
}

export type TouchAxis = 'x' | 'y' | 'both'

/** The axis a touch moves along, from its total travel since touchstart (`dx`/`dy` = start minus
 *  now, i.e. positive scrolls content right/down). `null` while it has not moved. */
export function touchAxis(dx: number, dy: number): TouchAxis | null {
  const ax = Math.abs(dx), ay = Math.abs(dy)
  if (ax === 0 && ay === 0) return null
  return ax > ay ? 'x' : ay > ax ? 'y' : 'both'
}

/** May this touch pan natively? Pure — the hook below feeds it the DOM. */
export function touchMayScroll({ axis, dy, ignored, inModal, chain }: {
  axis: TouchAxis
  /** total vertical travel since touchstart, start minus now */
  dy: number
  /** the touch started inside `[data-swipe-ignore]` */
  ignored: boolean
  /** the touch started inside the dialog or one of its portalled pickers */
  inModal: boolean
  /** the start target and its ancestors up to <body>, innermost first */
  chain: readonly ScrollBox[]
}): boolean {
  if (ignored) return true
  if (!inModal) return false
  const scrolls = (overflow: string) => /(auto|scroll)/.test(overflow)
  const x = () => chain.some((b) => scrolls(b.overflowX) && b.maxX > 0)
  const y = () => chain.some((b) => scrolls(b.overflowY) && b.maxY > 0
    && ((dy < 0 && b.top > 0) || (dy > 0 && b.top < b.maxY)))
  return axis === 'x' ? x() : axis === 'y' ? y() : x() || y()
}

/** The pickers portal beside the dialog, so they share its scrolling allowance. */
const MODAL = '[role="dialog"], [role="menu"], [role="listbox"], .combo-menu'

function scrollChain(from: Element): ScrollBox[] {
  const chain: ScrollBox[] = []
  let node: Element | null = from
  while (node && node !== document.body) {
    const css = getComputedStyle(node)
    chain.push({
      overflowX: css.overflowX, overflowY: css.overflowY, top: node.scrollTop,
      maxX: node.scrollWidth - node.clientWidth, maxY: node.scrollHeight - node.clientHeight,
    })
    node = node.parentElement
  }
  return chain
}

/** Trap touch scrolling in the open sheet and its portalled pickers, without making them inert. */
export function useMobileScrollLock(open: boolean) {
  const phone = useIsPhone()
  useEffect(() => {
    if (!open || !phone) return
    // the touch in progress — reset on every touchstart
    let x0 = 0, y0 = 0, lastY = 0, target: Element | null = null, ignored = false, inModal = false
    let locked: 'x' | 'y' | null = null
    const start = (e: TouchEvent) => {
      x0 = e.touches[0]?.clientX ?? 0
      y0 = lastY = e.touches[0]?.clientY ?? 0
      target = e.target instanceof Element ? e.target : null
      ignored = !!target?.closest('[data-swipe-ignore]')
      inModal = !!target?.closest(MODAL)
      locked = null
    }
    const move = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (!touch || e.touches.length !== 1 || ignored) return
      const dx = x0 - touch.clientX, dy = y0 - touch.clientY
      const step = lastY - touch.clientY
      lastY = touch.clientY
      const axis = touchAxis(dx, dy)
      if (!locked && !axis) return
      // a tie at the slop stays undecided — it locks on the first move that has a dominant axis
      if (!locked && axis !== 'both' && axis && Math.max(Math.abs(dx), Math.abs(dy)) >= AXIS_SLOP_PX) locked = axis
      // the AXIS comes from the whole travel; once it is locked, the vertical DIRECTION is this
      // move's own (a list that hit its end on the way up must still scroll back down in the
      // same touch), falling back to the total when the move has no vertical part
      const along = locked === 'y' && step !== 0 ? step : dy
      const chain = inModal && target ? scrollChain(target) : []
      if (!touchMayScroll({ axis: locked ?? 'both', dy: along, ignored, inModal, chain }) && e.cancelable) e.preventDefault()
    }
    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    return () => {
      document.removeEventListener('touchstart', start)
      document.removeEventListener('touchmove', move)
    }
  }, [open, phone])
}
