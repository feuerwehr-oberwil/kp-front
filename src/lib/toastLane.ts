import { type RefObject, useEffect } from 'react'

/**
 * Where the phone's message lane stands while a MODAL bottom sheet is open (30.09.2026).
 *
 * THE lane (15-mobile.css · `--msg-lane-bottom`) stands above the bottom bars — which a bottom
 * sheet covers. Until now any modal sheet flipped every toast to a lane under the top bar
 * («Seite wählen» open: «… Anwesenheit entfernt · Rückgängig» jumped from the foot of the list to
 * the head of the page, over the blurred title; owner, staging phone pass: «slightly odd
 * positioning of the toasts»). The sheet IS the foot of the screen now, so the lane stands ON it:
 * one `--float-gap` above its top edge, the same gap it keeps above the bars — the pill moves
 * with the thing it stands on and never covers the sheet or the page's head.
 * Only a sheet that leaves no room for one pill above it (a form that runs up to the status bar)
 * sends the lane to the top of the screen — over the scrimmed top bar, never over the sheet's
 * own head.
 *
 * Non-modal owners of the foot (a detail sheet, Ebenen, Messen, the Passung dock) keep their CSS
 * top lane: the top bar is live beside them, and their heights change under the finger.
 */

/** A modal surface: Base UI's popups carry the role, the hand-rolled symbol sheet sets it too. */
const SHEET_SEL = '[role="dialog"], [role="alertdialog"]'

export type Lane = { mode: 'bars' } | { mode: 'sheet'; bottom: number } | { mode: 'top' }

/**
 * Pure: given the highest open bottom sheet's top edge (layout px, `null` = none), decide the lane.
 * `ceiling` is the highest a pill may stand (the top bar's top edge — the scrim has taken the
 * bar); `pill` one pill's height (--float-h); `gap` the family's --float-gap.
 */
export function laneOverSheet(sheetTop: number | null, { layoutHeight, ceiling, pill, gap }: {
  layoutHeight: number; ceiling: number; pill: number; gap: number
}): Lane {
  if (sheetTop == null) return { mode: 'bars' }
  if (sheetTop - gap - pill < ceiling) return { mode: 'top' }
  return { mode: 'sheet', bottom: Math.round(layoutHeight - sheetTop + gap) }
}

/** The top edge of the highest modal sheet standing flush on the foot of what the screen shows —
 *  the layout viewport's bottom, or the keyboard's top when a lift has stood it there. */
export function openSheetTop(): number | null {
  const vv = window.visualViewport
  const bottoms = [window.innerHeight, vv ? vv.offsetTop + vv.height : window.innerHeight]
  let top: number | null = null
  for (const el of document.querySelectorAll<HTMLElement>(SHEET_SEL)) {
    if (el.closest('.toaster')) continue
    const r = el.getBoundingClientRect()
    if (r.height <= 0 || r.width <= 0) continue
    if (!bottoms.some((b) => Math.abs(r.bottom - b) <= 2)) continue
    top = top == null ? r.top : Math.min(top, r.top)
  }
  return top
}

function px(name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(v) ? v : fallback
}

/**
 * Keeps the toaster's `data-lane` (+ `--msg-sheet-bottom`) in step with the open sheets while a
 * message is up. Width-blind on purpose: only the PHONE's stylesheet reads the attribute
 * (15-mobile.css). Written to the element, not rendered: the sheet grows as it hugs its content
 * and rides the keyboard, and a React state per change would re-render the whole host for a
 * number CSS alone consumes.
 */
export function useToastLane(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const host = ref.current
    if (!host || !active) return
    let frame = 0
    const measure = () => {
      frame = 0
      const bar = document.querySelector('.topbar')?.getBoundingClientRect()
      const lane = laneOverSheet(openSheetTop(), {
        layoutHeight: window.innerHeight,
        ceiling: bar && bar.height > 0 ? bar.top : 8,
        // --float-h / --float-gap are calc()s of tokens; their resolved numbers are the tokens'
        pill: px('--tap', 44) + 2 * px('--msg-pad', 4),
        gap: px('--float-gap', 8),
      })
      if (lane.mode === 'bars') host.removeAttribute('data-lane')
      else host.setAttribute('data-lane', lane.mode)
      if (lane.mode === 'sheet') host.style.setProperty('--msg-sheet-bottom', `${lane.bottom}px`)
      else host.style.removeProperty('--msg-sheet-bottom')
    }
    const update = () => { if (!frame) frame = requestAnimationFrame(measure) }
    // a sheet opening or closing is a portal container coming or going on <body>; a sheet that
    // grows is a resize; one sliding in is an animation that ends; a keyboard is the viewport
    // (ResizeObserver is optional: jsdom has none, and every other trigger still works without it)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    const watch = () => { if (!ro) return; ro.disconnect(); for (const el of document.querySelectorAll(SHEET_SEL)) ro.observe(el) }
    const mo = new MutationObserver(() => { update(); watch() })
    mo.observe(document.body, { childList: true })
    watch()
    document.addEventListener('animationend', update, true)
    document.addEventListener('transitionend', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    update()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      mo.disconnect(); ro?.disconnect()
      document.removeEventListener('animationend', update, true)
      document.removeEventListener('transitionend', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.removeEventListener('resize', update)
      host.removeAttribute('data-lane')
      host.style.removeProperty('--msg-sheet-bottom')
    }
  }, [ref, active])
}
