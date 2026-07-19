import { useEffect, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { clampRailWidth, snapExpanded } from '../lib/navRail'

export interface ToolDef {
  id: string
  icon: string
  label: string
  /** render a group divider instead of a button */
  sep?: boolean
  /** render the `primary` (Symbol) button at this position instead of pinning it to the top */
  slot?: boolean
}

interface Props {
  /** the ink "primary" button (Symbol); placed wherever the tool list carries a `slot` entry */
  primary: ToolDef
  /** the modal tool buttons */
  tools: readonly ToolDef[]
  /** the active tool id (lights its button) */
  active: string
  onPick: (id: string) => void
  /** optional refs to each tool button, so a tool's option dock can top-align to it */
  toolRefs?: React.MutableRefObject<Record<string, HTMLButtonElement | null>>
  /** surface-specific buttons appended after the tools (e.g. the plan's Trails toggle) */
  extras?: React.ReactNode
  /** pinned footer cluster — surface-specific (map nav vs plan zoom), rendered inside .vrail-nav */
  footer: React.ReactNode
  /** root class so each surface keeps its own selector hook (.tool-rail / .wb-tools) */
  className?: string
}

// the right rail mirrors the left NavRail's travel — compact shows glyphs only,
// expanded adds labels; it just opens leftward (anchored right) so the grip lives
// on the LEFT edge and the drag delta is inverted.
// COMPACT = icon-only width; WIDE = the drag snap threshold / clamp ceiling. The committed
// expanded width is measured from the content (longest label) so the rail fits it exactly,
// capped at MAXW.
const COMPACT = 60, WIDE = 216, MAXW = 280

// Shared right-edge vertical tool rail used by BOTH the Lage map and the Plan
// whiteboard: an expandable, icon-first rail (matching the left NavRail) with a
// scrolling tool section plus a pinned footer that always stays in reach. The
// Symbol "primary" button sits inline at the list's `slot` marker (between the
// selection and drawing groups), not pinned at the top. Each surface supplies its
// own tool list, optional extras, and footer; the shape + look (.vrail) are
// identical, so the two action sidebars stay in lockstep from one code object.
export function ToolRail({ primary, tools, active, onPick, toolRefs, extras, footer, className }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const railRef = useRef<HTMLElement>(null)
  const nav = appConfig.copy.navRail

  // "scroll for more" chevrons at whichever edge has hidden tools — mirrors the left NavRail
  // so the right rail gets the same affordance when the tool list outgrows the viewport.
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
  }, [tools.length, expanded])

  // tapping a "scroll for more" chevron jumps fully to that end of the tool list (the rail is
  // short, so a single tap to the top/bottom is what's expected — partial paging over/under-shot).
  const nudge = (dir: 1 | -1) => { const el = scrollRef.current; if (el) el.scrollTo({ top: dir === 1 ? el.scrollHeight : 0, behavior: 'smooth' }) }

  // keep the ACTIVE tool visible — same courtesy as the NavRail: picking a tool from the
  // palette (or a mode change) must never leave its lit button outside the scrolled strip.
  // `nearest` never moves an already-visible item. (Optional call: jsdom has no scrollIntoView.)
  useEffect(() => {
    scrollRef.current?.querySelector('.vrail-tool.on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [active])

  // width is published on the document root (like the left rail's --rail-w) so overlays
  // that sit beside the rail — the tool-option dock — can track it via calc(). Reset on
  // mount/unmount so a value from the other surface's rail can't leak across.
  const setW = (px: number) => document.documentElement.style.setProperty('--vrail-w', `${px}px`)
  // set the width IMMEDIATELY in both directions (mirrors the left NavRail) so expand and
  // collapse animate the same, smooth way. Earlier this deferred the expanded width to a
  // layout-effect that briefly forced `width: max-content` to fit the longest label — that
  // measurement flash interrupted the transition and made expanding look janky.
  const apply = (exp: boolean) => { setExpanded(exp); setW(exp ? WIDE : COMPACT) }
  useEffect(() => {
    setW(COMPACT)
    return () => { document.documentElement.style.removeProperty('--vrail-w') }
  }, [])

  // pull the LEFT-edge grip to resize: the rail grows as the pointer moves left, so the
  // delta is start − current (mirror of the left rail). Labels hide during the drag so
  // they never clip mid-resize; they fade back in once the rail snaps.
  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
    e.currentTarget.dataset.startx = String(e.clientX)
    const cur = railRef.current ? parseFloat(getComputedStyle(railRef.current).getPropertyValue('--vrail-w')) : NaN
    e.currentTarget.dataset.startw = String(Number.isNaN(cur) ? (expanded ? WIDE : COMPACT) : cur)
  }
  const onGripMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    const startX = Number(e.currentTarget.dataset.startx), startW = Number(e.currentTarget.dataset.startw)
    setW(clampRailWidth(startW + (startX - e.clientX), COMPACT, MAXW))
  }
  const onGripUp = () => {
    if (!dragging || !railRef.current) return
    setDragging(false)
    const w = parseFloat(getComputedStyle(railRef.current).getPropertyValue('--vrail-w')) || COMPACT
    apply(snapExpanded(w, (COMPACT + WIDE) / 2))
  }

  return (
    <aside ref={railRef} className={`vrail${expanded ? ' expanded' : ''}${dragging ? ' dragging' : ''} ${className ?? ''}`}>
      <button className="vrail-exp" onClick={() => apply(!expanded)} aria-label={expanded ? nav.collapse : nav.expand}>
        <span className="vrail-exp-ic"><Icon id="chevron" /></span><span className="vrail-exp-t">{expanded ? nav.collapse : nav.expand}</span>
      </button>

      {/* tools — scroll if the list grows; the pinned footer below never scrolls away.
          The wrap carries an edge chevron whenever there are hidden tools above/below. */}
      <div className="vrail-scroll-wrap">
      {edge.top && <button type="button" className="vrail-more vrail-more-up" aria-label={nav.scrollMore} onClick={() => nudge(-1)}><Icon id="chevron-down" /></button>}
      {edge.bottom && <button type="button" className="vrail-more vrail-more-down" aria-label={nav.scrollMore} onClick={() => nudge(1)}><Icon id="chevron-down" /></button>}
      <div ref={scrollRef} className={`vrail-scroll${edge.top ? ' more-top' : ''}${edge.bottom ? ' more-bottom' : ''}`}>
        {tools.map((t) => {
          // Symbol renders inline among the tools (between selection and drawing) as a plain
          // tool — no special "primary" ink styling, lighting up like any other when active.
          if (t.slot) {
            const on = active === primary.id
            return (
              <button
                key="__primary__"
                className={`vrail-tool ${on ? 'on' : ''}`}
                title={primary.label}
                aria-label={primary.label}
                aria-pressed={on}
                onClick={() => onPick(primary.id)}
              >
                <span className="vrail-glyph"><Icon id={primary.icon} /></span><span className="vrail-label">{primary.label}</span>
              </button>
            )
          }
          // a sentinel entry renders a group divider so the rail reads as clusters
          // (selection · symbol · create · annotate) instead of one undifferentiated stack
          if (t.sep) return <span key={t.id} className="vrail-sep" aria-hidden />
          const on = active === t.id
          return (
            <button
              key={t.id}
              ref={toolRefs ? (el) => { toolRefs.current[t.id] = el } : undefined}
              className={`vrail-tool ${on ? 'on' : ''}`}
              title={t.label}
              aria-label={t.label}
              aria-pressed={on}
              onClick={() => onPick(t.id)}
            >
              <span className="vrail-glyph"><Icon id={t.icon} /></span><span className="vrail-label">{t.label}</span>
            </button>
          )
        })}
        {extras}
      </div>
      </div>

      {/* pinned footer — surface-specific nav cluster (map: compass·zoom·fit·coords / plan: zoom·fit·%) */}
      <div className="vrail-sep vrail-sep-foot" />
      <div className="vrail-nav">{footer}</div>

      {/* drag GRIP on the left edge — aria-label only (a native title pops the OS tooltip) */}
      <button className={`vrail-grip${dragging ? ' drag' : ''}`} aria-label={nav.resize}
        onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp} />
    </aside>
  )
}
