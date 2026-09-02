import { useEffect, useRef, useState, type ComponentProps, type PointerEvent } from 'react'
import { clampRailWidth, snapExpanded } from './navRail'
import type { RailLabels } from './prefs'
import { scrollBehavior } from './reducedMotion'

// The rail MECHANIC, shared by the left NavRail and the right ToolRail: edge-of-scroll
// tracking, the "scroll for more" nudge, keeping the active item revealed, publishing the live
// width as a CSS custom property, and the drag grip. The two rails are the same object in two
// mirror images — they were 63 byte-identical lines apart, and every fix to one had to be
// re-applied to the other by hand. What stays in the components is what actually differs: their
// content, their copy, and where the expanded state is STORED (NavRail per mount, ToolRail in a
// module-scoped value so it survives a surface switch).
//
// The pure half — the clamp and the snap point — lives in lib/navRail.ts and is tested there.

export interface RailOptions {
  /** the CSS custom property this rail publishes on <html>: `--rail-w` (left) / `--vrail-w`
   *  (right). Every neighbour offsets itself off it with calc(), so it is a wire name — see the
   *  consumers in 06-contextpanel.css, 08-toasts.css, 09-whiteboard.css and the surface shells. */
  varName: `--${string}`
  /** the collapsed width to publish — RAIL_COMPACT, or RAIL_LABELLED while the words are on */
  compactW: number
  /** the committed expanded width */
  wideW: number
  /** how far a drag may pull the rail (default: `wideW`). The right rail lets go further than it
   *  snaps to, so a pull past the snap point still tracks the finger. */
  maxW?: number
  /** which edge the grip sits on: a 'left' rail grows as the pointer moves right, a 'right' rail
   *  (anchored to the right edge, opening leftward) grows as it moves left */
  side: 'left' | 'right'
  /** the committed expanded state and its setter — owned by the component, because where it is
   *  stored is a per-rail decision */
  expanded: boolean
  setExpanded: (v: boolean) => void
  /** device pref (lib/prefs · railLabels): with the words on there is nothing left to expand, so
   *  an expanded rail collapses and the chevron + grip go away (the CSS hides the grip) */
  labels?: RailLabels
  /** how many items the scroller holds — re-measures the edges when the list grows or shrinks */
  itemCount: number
  /** selector of the lit item inside the scroller, e.g. `.nav-item.on` */
  activeSelector: string
  /** changes whenever the lit item may have moved (surface · plan · tool), so the reveal looks
   *  again. A string rather than a deps array: a fresh array every render would reveal on every
   *  render, and a spread deps list is not statically checkable. */
  revealKey: string
  /** class toggled on <html> for the length of a drag, so rail-tracking overlays can drop their
   *  easing and stay locked to the edge instead of rubber-banding behind it */
  dragClass?: string
  /** drop the published width when the rail unmounts. The right rail does (its two surfaces each
   *  mount their own, and a value from the other one must not leak across); the left rail does
   *  not — removing `--rail-w` would fall back to the token's 60px and every surface beside it
   *  would jump. */
  releaseOnUnmount?: boolean
}

/** Grip handlers, ready to spread onto the `<button className="…-grip">`. */
type GripProps = Pick<ComponentProps<'button'>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>

export function useRail(o: RailOptions) {
  const { varName, compactW, wideW, side, expanded, setExpanded, labels, activeSelector, revealKey } = o
  const maxW = o.maxW ?? wideW
  const [dragging, setDragging] = useState(false)

  /** write the live width so everything that sits beside the rail can follow it via calc() */
  const setRailVar = (px: number) => document.documentElement.style.setProperty(varName, `${px}px`)

  // The vertical rail scrolls when its list outgrows the viewport (the common case on an iPad:
  // Anwesenheit sits just below the fold). Without a cue that's invisible, so we fade whichever
  // edge has more content — the same "scroll for more" affordance the phone bottom-bar uses, here
  // on the vertical axis. (On phones the rail is a horizontal bar with its own right-edge fade,
  // where scrollTop stays 0, so neither class is applied.)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ top: false, bottom: false })
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      const top = el.scrollTop > 1
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
      setEdge((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (ro) { ro.observe(el); for (const c of Array.from(el.children)) ro.observe(c) }
    window.addEventListener('resize', update)
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); window.removeEventListener('resize', update) }
  }, [o.itemCount, expanded])

  // Tapping a "scroll for more" chevron pages by one screenful, keeping ~one item of overlap so
  // nothing is stepped over — EXCEPT when what's left is under a screenful, where it still jumps
  // to the end. That last part is the earlier fix, and it was right for the case it was written
  // for: on a tablet the whole list is one screenful away, so paging over/under-shot.
  //
  // Jumping unconditionally broke the case it was never measured against. On a landscape phone
  // the rail has 289px of band for 576px of content — 4 of 11 surfaces visible — so one tap flew
  // past the middle to the last item, and «Atemschutz», «Anwesenheit» and «Checkliste» were
  // reachable by neither end. The chevron is the entire route to seven surfaces there. The right
  // rail shows 2 of 9 tools at 852×393, where a jump to the end skipped «Symbol».
  const nudge = (dir: 1 | -1) => {
    const el = scrollRef.current
    if (!el) return
    const page = Math.max(el.clientHeight - 50, 50)   // a screenful, less one item of overlap
    const rest = dir === 1 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop
    const top = rest <= page ? (dir === 1 ? el.scrollHeight : 0) : el.scrollTop + dir * page
    el.scrollTo({ top, behavior: scrollBehavior() })
  }

  // keep the ACTIVE item visible: the phone bottom bar (and a crowded tablet rail) scrolls, and
  // after a switch via deep link — or a thumb-scroll that drifted — the highlighted item could
  // sit outside the visible strip, leaving no "you are here". `nearest` never moves an
  // already-visible item. (Optional call: jsdom has no scrollIntoView.)
  //
  // On a RELOAD this used to leave the bar parked at its start with the restored surface off
  // screen. Two reasons, both handled here:
  //  - the plan tiles are fetched after boot, so on the first pass the restored surface often
  //    isn't in the DOM yet — and once it arrives it lands in the MIDDLE of the list, shifting
  //    everything after it. `revealKey` therefore carries the list length as well as the
  //    selection, so the effect looks again when the tiles land.
  //  - first-frame measurements aren't final (fonts, safe-area insets, the bar's own wrap), so
  //    the one synchronous attempt could compute against a stale width.
  const revealedRef = useRef(false)
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const reveal = () => {
      const el = box.querySelector(activeSelector)
      if (!el) return
      // The first reveal after a mount is a jump, not a journey: there is nothing for the eye to
      // follow yet, and a smooth scroll begun during mount gets cut short by the next layout.
      const behavior: ScrollBehavior = revealedRef.current ? scrollBehavior() : 'auto'
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior })
      revealedRef.current = true
    }
    reveal()
    if (typeof requestAnimationFrame !== 'function') return
    const raf = requestAnimationFrame(reveal) // once more after layout settles
    return () => cancelAnimationFrame(raf)
  }, [revealKey, activeSelector])

  /** commit an expanded state and publish the width that goes with it */
  const apply = (exp: boolean) => { setExpanded(exp); setRailVar(exp ? wideW : compactW) }

  // Publish the width the rail actually shows. The width itself lives in CSS; the offset every
  // neighbour reads lives in the custom property, and the two must not disagree — so this runs
  // when the PREFERENCE changes as well as on mount (a rail remounting already-expanded, which
  // the right rail does on every surface switch, has to publish the WIDE width it shows).
  // ⚠️ Switching the words ON also collapses an expanded rail — its «Einklappen» chevron is gone
  // in that mode, so an expanded rail would be 216px wide with nothing left to close it.
  useEffect(() => {
    const release = o.releaseOnUnmount ? () => { document.documentElement.style.removeProperty(varName) } : undefined
    if (labels === 'short' && expanded) { setExpanded(false); setRailVar(compactW); return release }
    setRailVar(expanded ? wideW : compactW)
    return release
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pref-driven; `expanded` is read, not
    // tracked: every toggle goes through apply(), which publishes the width itself.
  }, [compactW, labels])

  // pull the grip to resize (pointer-capture pattern mirrors lib/useHoldEntry); labels stay
  // hidden during the drag so they never clip mid-resize — they fade in on snap. The start width
  // is the committed one: a drag always begins from a rail at rest, since the previous one ended
  // in a snap back to compact or wide.
  const onGripDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
    if (o.dragClass) document.documentElement.classList.add(o.dragClass)
    e.currentTarget.dataset.startx = String(e.clientX)
    e.currentTarget.dataset.startw = String(expanded ? wideW : compactW)
  }
  const onGripMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    const startX = Number(e.currentTarget.dataset.startx), startW = Number(e.currentTarget.dataset.startw)
    const delta = side === 'left' ? e.clientX - startX : startX - e.clientX
    setRailVar(clampRailWidth(startW + delta, compactW, maxW))
  }
  const onGripUp = () => {
    if (!dragging) return
    setDragging(false)
    if (o.dragClass) document.documentElement.classList.remove(o.dragClass)
    const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(varName)) || compactW
    apply(snapExpanded(w))   // the midpoint of the shared compact→wide travel, for both rails
  }
  const gripProps: GripProps = { onPointerDown: onGripDown, onPointerMove: onGripMove, onPointerUp: onGripUp, onPointerCancel: onGripUp }

  return { scrollRef, edge, dragging, nudge, apply, gripProps }
}
