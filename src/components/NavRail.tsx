import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import type { PlanDocument } from '../types'
import { clampRailWidth, snapExpanded, planGlyph } from '../lib/navRail'
import { SURFACE_KEY } from '../lib/hotkeys'

// precomposed Unicode fraction glyphs for combined-module monograms (clean proper fractions);
// anything without one falls back to a compact diagonal rendering.
const FRAC_GLYPH: Record<string, string> = {
  '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/6': '⅙', '5/6': '⅚',
}

interface Props {
  mode: 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel'
  onMode: (m: 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel') => void
  planDocs: PlanDocument[]
  activePlanId: string
  onSelectPlan: (id: string) => void
  /** green live-dot on Karte while at least one GPS vehicle is on the map */
  mapLive?: boolean
  /** Atemschutz contact-clock alarm tier (0 silent · 1 fällig · 2 überfällig) — drives a
   *  cross-surface dot on the Atemschutz item so a due Trupp is visible from any surface */
  azSeverity?: 0 | 1 | 2
  /** PHONE-ONLY map controls (Ebenen / Karte) pinned after the surface list — desktop and
   *  tablet render these in the right ToolRail extras / MapUtility instead, so this rail
   *  stays identical on every surface. Only passed in map mode on phones. */
  mapControls?: ReactNode
  /** trailing slot after the map controls — the phone's 🔧 Bearbeiten toggle lives here
   *  (bar swap: tapping it replaces this surface bar with the tool rail) */
  trailing?: ReactNode
}

const COMPACT = 60, WIDE = 216

// The single left navigation rail: it switches the whole surface (Karte · the
// current object's Pläne · Checkliste) and replaces both the old TopBar mode-switch
// and the old map-panel Rail. Compact shows glyphs only; expanded adds labels. A
// drag grip on the right edge live-resizes the rail and snaps on release — overlays
// track its width through the `--rail-w` CSS variable.
export function NavRail(p: Props) {
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const nav = appConfig.copy.navRail

  // The vertical rail scrolls when the surface list outgrows the viewport (the common case
  // on an iPad: Anwesenheit sits just below the fold). Without a cue that's invisible, so we
  // fade whichever edge has more content — the same "scroll for more" affordance the phone
  // bottom-bar uses, here on the vertical axis. (On phones the rail is a horizontal bar with
  // its own right-edge fade, where scrollTop stays 0, so neither class is applied.)
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
  }, [p.planDocs.length, expanded])

  // tapping a "scroll for more" chevron jumps fully to that end of the list (the rail is short,
  // so a single tap to the top/bottom is what's expected — earlier partial paging over/under-shot).
  const nudge = (dir: 1 | -1) => { const el = scrollRef.current; if (el) el.scrollTo({ top: dir === 1 ? el.scrollHeight : 0, behavior: 'smooth' }) }

  // keep the ACTIVE surface visible: the phone bottom bar (and a crowded tablet rail) scrolls,
  // and after a switch via deep link — or a thumb-scroll that drifted — the highlighted item
  // could sit outside the visible strip, leaving no "you are here". `nearest` never moves an
  // already-visible item. (Optional call: jsdom has no scrollIntoView.)
  useEffect(() => {
    scrollRef.current?.querySelector('.nav-item.on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [p.mode, p.activePlanId])

  // write the live width so the map-control overlays can follow the rail via calc()
  const setRailVar = (px: number) => document.documentElement.style.setProperty('--rail-w', `${px}px`)
  const apply = (exp: boolean) => { setExpanded(exp); setRailVar(exp ? WIDE : COMPACT) }

  // pull the grip to resize (pointer-capture pattern mirrors lib/useHoldEntry); labels
  // stay hidden during the drag so they never clip mid-resize — they fade in on snap.
  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
    document.documentElement.classList.add('rail-dragging')  // overlays drop easing → stay locked to the edge
    const startX = e.clientX, startW = expanded ? WIDE : COMPACT
    e.currentTarget.dataset.startx = String(startX); e.currentTarget.dataset.startw = String(startW)
  }
  const onGripMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    const startX = Number(e.currentTarget.dataset.startx), startW = Number(e.currentTarget.dataset.startw)
    setRailVar(clampRailWidth(startW + (e.clientX - startX)))
  }
  const onGripUp = () => {
    if (!dragging) return
    setDragging(false)
    document.documentElement.classList.remove('rail-dragging')
    const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) || COMPACT
    apply(snapExpanded(w))
  }

  return (
    <nav className={`navrail${expanded ? ' expanded' : ''}${dragging ? ' dragging' : ''}`}>
      <button className="nav-exp" onClick={() => apply(!expanded)} aria-label={expanded ? nav.collapse : nav.expand}>
        <span className="nav-exp-ic"><Icon id="chevron" /></span><span className="nav-exp-t">{expanded ? nav.collapse : nav.expand}</span>
      </button>

      {/* surfaces — scroll if the list grows; the pinned map-controls below never scroll away.
          The wrap holds an unmasked chevron at whichever edge has hidden items (the fade alone
          was too subtle), making "scroll for more" explicit. */}
      <div className="nav-scroll-wrap">
      {edge.top && <button type="button" className="nav-more nav-more-up" aria-label={nav.scrollMore} onClick={() => nudge(-1)}><Icon id="chevron-down" /></button>}
      {edge.bottom && <button type="button" className="nav-more nav-more-down" aria-label={nav.scrollMore} onClick={() => nudge(1)}><Icon id="chevron-down" /></button>}
      <div ref={scrollRef} className={`nav-scroll${edge.top ? ' more-top' : ''}${edge.bottom ? ' more-bottom' : ''}`}>
        <button className={`nav-item${p.mode === 'map' ? ' on' : ''}`} aria-pressed={p.mode === 'map'} aria-label={nav.map} onClick={() => p.onMode('map')}>
          <span className="nav-glyph"><Icon id="map" />{p.mapLive && <span className="nav-live" />}</span>
          <span className="nav-label">{nav.map}</span>
          <span className="nav-key" aria-hidden>{SURFACE_KEY.map}</span>
        </button>

        {p.planDocs.map((doc) => {
          const g = planGlyph(doc)
          const on = p.mode === 'plans' && p.activePlanId === doc.id
          // short code ("Modul 3") as the label — the descriptive title overflows the rail
          return (
            <button key={doc.id} className={`nav-item${on ? ' on' : ''}`} aria-pressed={on} aria-label={doc.code} onClick={() => p.onSelectPlan(doc.id)}>
              {'mono' in g && g.mono.includes('/') ? (
                // combined module ("2/3") as a proper typographic fraction — a precomposed glyph
                // (⅔ …) where one exists, else a compact diagonal fallback. Single-glyph footprint.
                FRAC_GLYPH[g.mono] ? (
                  <span className="nav-glyph mono nav-frac" aria-hidden>{FRAC_GLYPH[g.mono]}</span>
                ) : (
                  <span className="nav-glyph mono nav-frac nav-frac-diag" aria-hidden>
                    <span className="nav-frac-n">{g.mono.split('/')[0]}</span>
                    <span className="nav-frac-s">/</span>
                    <span className="nav-frac-d">{g.mono.split('/')[1]}</span>
                  </span>
                )
              ) : (
                <span className={`nav-glyph${'mono' in g ? ' mono' : ''}`}>{'mono' in g ? g.mono : <Icon id={g.icon} />}</span>
              )}
              <span className="nav-label">{doc.code}</span>
            </button>
          )
        })}

        <div className="nav-sep" />
        <button className={`nav-item${p.mode === 'checklists' ? ' on' : ''}`} aria-pressed={p.mode === 'checklists'} aria-label={appConfig.copy.modes.checklists} onClick={() => p.onMode('checklists')}>
          <span className="nav-glyph"><Icon id="checklist" /></span>
          <span className="nav-label">{appConfig.copy.modes.checklists}</span>
          <span className="nav-key" aria-hidden>{SURFACE_KEY.checklists}</span>
        </button>
        <button className={`nav-item${p.mode === 'atemschutz' ? ' on' : ''}`} aria-pressed={p.mode === 'atemschutz'} aria-label={appConfig.copy.modes.atemschutz} onClick={() => p.onMode('atemschutz')}>
          <span className="nav-glyph"><Icon id="gauge" />{(p.azSeverity ?? 0) >= 2 ? <span className="nav-live nav-alarm crit" /> : null}</span>
          <span className="nav-label">{appConfig.copy.modes.atemschutz}</span>
          <span className="nav-key" aria-hidden>{SURFACE_KEY.atemschutz}</span>
        </button>
        <button className={`nav-item${p.mode === 'anwesenheit' ? ' on' : ''}`} aria-pressed={p.mode === 'anwesenheit'} aria-label={appConfig.copy.modes.anwesenheit} onClick={() => p.onMode('anwesenheit')}>
          <span className="nav-glyph"><Icon id="people" /></span>
          <span className="nav-label">{appConfig.copy.modes.anwesenheit}</span>
          <span className="nav-key" aria-hidden>{SURFACE_KEY.anwesenheit}</span>
        </button>
        <button className={`nav-item${p.mode === 'mittel' ? ' on' : ''}`} aria-pressed={p.mode === 'mittel'} aria-label={appConfig.copy.modes.mittel} onClick={() => p.onMode('mittel')}>
          <span className="nav-glyph"><Icon id="box" /></span>
          <span className="nav-label">{appConfig.copy.modes.mittel}</span>
          <span className="nav-key" aria-hidden>{SURFACE_KEY.mittel}</span>
        </button>

        {/* (object switch moved to the incident dropdown's «Objekt: …» row, 2026-07-14) */}
      </div>
      </div>

      {/* map-only controls pinned at the bottom — Ebenen / Karte, always visible */}
      {p.mapControls && <div className="nav-mapctl">{p.mapControls}</div>}
      {p.trailing}

      {/* drag GRIP — aria-label only (a native `title` would pop the OS tooltip box) */}
      <button className={`nav-grip${dragging ? ' drag' : ''}`} aria-label={nav.resize}
        onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp} />
    </nav>
  )
}
