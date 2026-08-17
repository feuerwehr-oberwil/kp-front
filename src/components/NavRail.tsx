import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import type { RailLabels } from '../lib/prefs'
import type { PlanDocument } from '../types'
import { clampRailWidth, snapExpanded, planGlyph } from '../lib/navRail'
import { SURFACE_KEY } from '../lib/hotkeys'

// precomposed Unicode fraction glyphs for combined-module monograms (clean proper fractions);
// anything without one falls back to a compact diagonal rendering.
const FRAC_GLYPH: Record<string, string> = {
  '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/6': '⅙', '5/6': '⅚',
}

interface Props {
  mode: 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel' | 'rapport'
  onMode: (m: 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel' | 'rapport') => void
  planDocs: PlanDocument[]
  activePlanId: string
  onSelectPlan: (id: string) => void
  /** Atemschutz contact-clock alarm tier (0 silent · 1 fällig · 2 überfällig) — drives a
   *  cross-surface dot on the Atemschutz item so a due Trupp is visible from any surface */
  azSeverity?: 0 | 1 | 2
  /** trailing slot after the surface list — the phone's 🔧 Bearbeiten toggle lives here
   *  (bar swap: tapping it replaces this surface bar with the tool rail) */
  trailing?: ReactNode
  /** device pref: put each surface's WORD under its glyph (lib/prefs · railLabels). Distinct from
   *  the expand chevron, which widens the rail and sets the word beside the glyph for as long as
   *  it stays open — this is a standing decision and costs ~10px, not 156. */
  labels?: RailLabels
}

/** ⚠️ LABELLED is the compact width with room for a word under the glyph — «Anwesenheit» measures
 *  76px in the app's own Sora at 10.5px, so 88 is what fits with the rail's padding. It has to be a
 *  number here as well as a width in CSS: everything that sits beside the rail (the map controls,
 *  the docks) is positioned off `--rail-w`, so a rail that got wider only in the stylesheet would
 *  be overlapped by them. */
const COMPACT = 60, LABELLED = 88, WIDE = 216

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

  // Tapping a "scroll for more" chevron pages by one screenful, keeping ~one item of overlap so
  // nothing is stepped over — EXCEPT when what's left is under a screenful, where it still jumps
  // to the end. That last part is the earlier fix, and it was right for the case it was written
  // for: on a tablet the whole list is one screenful away, so paging over/under-shot.
  //
  // Jumping unconditionally broke the case it was never measured against. On a landscape phone
  // the rail has 289px of band for 576px of content — 4 of 11 surfaces visible — so one tap flew
  // past the middle to the last item, and «Atemschutz», «Anwesenheit» and «Checkliste» were
  // reachable by neither end. The chevron is the entire route to seven surfaces there.
  const nudge = (dir: 1 | -1) => {
    const el = scrollRef.current
    if (!el) return
    const page = Math.max(el.clientHeight - 50, 50)   // a screenful, less one item of overlap
    const rest = dir === 1 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop
    const top = rest <= page ? (dir === 1 ? el.scrollHeight : 0) : el.scrollTop + dir * page
    el.scrollTo({ top, behavior: 'smooth' })
  }

  // keep the ACTIVE surface visible: the phone bottom bar (and a crowded tablet rail) scrolls,
  // and after a switch via deep link — or a thumb-scroll that drifted — the highlighted item
  // could sit outside the visible strip, leaving no "you are here". `nearest` never moves an
  // already-visible item. (Optional call: jsdom has no scrollIntoView.)
  //
  // On a RELOAD this used to leave the bar parked at its start with the restored surface off
  // screen. Two reasons, both fixed here:
  //  - the plan tiles are fetched after boot, so on the first pass the restored surface often
  //    isn't in the DOM yet — and once it arrives it lands in the MIDDLE of the list, shifting
  //    everything after it. `mode`/`activePlanId` don't change when that happens, so without
  //    planDocs in the deps the effect looked once, found nothing, and never looked again.
  //  - first-frame measurements aren't final (fonts, safe-area insets, the bar's own wrap), so
  //    the one synchronous attempt could compute against a stale width.
  const revealedRef = useRef(false)
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const reveal = () => {
      const el = box.querySelector('.nav-item.on')
      if (!el) return
      // The first reveal after a reload is a jump, not a journey: there is nothing for the eye to
      // follow yet, and a smooth scroll begun during mount gets cut short by the next layout.
      const behavior: ScrollBehavior = revealedRef.current ? 'smooth' : 'auto'
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior })
      revealedRef.current = true
    }
    reveal()
    if (typeof requestAnimationFrame !== 'function') return
    const raf = requestAnimationFrame(reveal) // once more after layout settles
    return () => cancelAnimationFrame(raf)
  }, [p.mode, p.activePlanId, p.planDocs.length])

  // write the live width so the map-control overlays can follow the rail via calc()
  const setRailVar = (px: number) => document.documentElement.style.setProperty('--rail-w', `${px}px`)
  const compactW = p.labels === 'short' ? LABELLED : COMPACT
  const apply = (exp: boolean) => { setExpanded(exp); setRailVar(exp ? WIDE : compactW) }
  // …and the same when the PREFERENCE changes while the rail sits collapsed: the width lives in
  // CSS, the offset every neighbour reads lives in `--rail-w`, and the two must not disagree.
  // ⚠️ Switching the words ON also collapses an expanded rail — its «Einklappen» chevron is gone
  // in that mode, so an expanded rail would be 216px wide with nothing left to close it.
  useEffect(() => {
    if (p.labels === 'short' && expanded) { setExpanded(false); setRailVar(compactW); return }
    if (!expanded) setRailVar(compactW)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on the pref/collapse change only
  }, [compactW, expanded, p.labels])

  // pull the grip to resize (pointer-capture pattern mirrors lib/useHoldEntry); labels
  // stay hidden during the drag so they never clip mid-resize — they fade in on snap.
  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
    document.documentElement.classList.add('rail-dragging')  // overlays drop easing → stay locked to the edge
    const startX = e.clientX, startW = expanded ? WIDE : compactW
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
    const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) || compactW
    apply(snapExpanded(w))
  }

  return (
    <nav className={`navrail${expanded ? ' expanded' : ''}${dragging ? ' dragging' : ''}${p.labels === 'short' ? ' labelled' : ''}`}>
      {/* ⚠️ NO «Ausklappen» while the words are on. The chevron exists to reveal exactly what this
          setting already shows — with it on, expanding buys 128px of nothing but a second label
          position. It stays for everybody else, which is who it was for: somebody who does not
          know the glyphs yet and wants the names once, without a trip to the Einstellungen. */}
      {p.labels !== 'short' && (
        <button className="nav-exp" onClick={() => apply(!expanded)} aria-label={expanded ? nav.collapse : nav.expand}>
          <span className="nav-exp-ic"><Icon id="chevron" /></span><span className="nav-exp-t">{expanded ? nav.collapse : nav.expand}</span>
        </button>
      )}

      {/* surfaces — scroll if the list grows; the pinned map-controls below never scroll away.
          The wrap holds an unmasked chevron at whichever edge has hidden items (the fade alone
          was too subtle), making "scroll for more" explicit. */}
      <div className="nav-scroll-wrap">
      {edge.top && <button type="button" className="nav-more nav-more-up" aria-label={nav.scrollMore} onClick={() => nudge(-1)}><Icon id="chevron-down" /></button>}
      {edge.bottom && <button type="button" className="nav-more nav-more-down" aria-label={nav.scrollMore} onClick={() => nudge(1)}><Icon id="chevron-down" /></button>}
      <div ref={scrollRef} className={`nav-scroll${edge.top ? ' more-top' : ''}${edge.bottom ? ' more-bottom' : ''}`}>
        <button className={`nav-item${p.mode === 'map' ? ' on' : ''}`} aria-pressed={p.mode === 'map'} aria-label={nav.map} onClick={() => p.onMode('map')}>
          <span className="nav-glyph"><Icon id="map" /></span>
          <span className="nav-label">{nav.map}</span>
          <span className="nav-key" aria-hidden>{SURFACE_KEY.map}</span>
        </button>

        {/* divider ABOVE the plan group too, so the module/floor tabs read as their own
            navigable "Pläne" cluster instead of blending into the Karte icon above them */}
        {p.planDocs.length > 0 && <div className="nav-sep" />}
        {p.planDocs.map((doc) => {
          const g = planGlyph(doc)
          const on = p.mode === 'plans' && p.activePlanId === doc.id
          // short code ("Modul 3") as the label — the descriptive title overflows the rail.
          // Module monograms sit in a bordered chip (.nav-mono-chip) so they read as document
          // tabs, not bare tool glyphs; the Gebäude/Umgebung/Tafel icon-docs stay un-chipped.
          return (
            <button key={doc.id} className={`nav-item${on ? ' on' : ''}`} aria-pressed={on} aria-label={doc.code} onClick={() => p.onSelectPlan(doc.id)}>
              {'mono' in g ? (
                g.mono.includes('/') ? (
                  // combined module ("2/3") as a proper typographic fraction — a precomposed glyph
                  // (⅔ …) where one exists, else a compact diagonal fallback. Single-glyph footprint.
                  FRAC_GLYPH[g.mono] ? (
                    <span className="nav-glyph mono nav-frac" aria-hidden><span className="nav-mono-chip">{FRAC_GLYPH[g.mono]}</span></span>
                  ) : (
                    <span className="nav-glyph mono nav-frac nav-frac-diag" aria-hidden><span className="nav-mono-chip">
                      <span className="nav-frac-n">{g.mono.split('/')[0]}</span>
                      <span className="nav-frac-s">/</span>
                      <span className="nav-frac-d">{g.mono.split('/')[1]}</span>
                    </span></span>
                  )
                ) : (
                  // The glyph column is 46px wide and the chip has to fit INSIDE it, border and
                  // all. A single digit does at 15px; a three-letter sub-slot acronym ("RWA")
                  // does not — it pushed its own border past the rail edge. The letter count
                  // picks the size (see .nav-mono-chip), because CSS can't count characters.
                  <span className="nav-glyph mono" data-mono-len={g.mono.length}>
                    <span className="nav-mono-chip">{g.mono}</span>
                  </span>
                )
              ) : (
                <span className="nav-glyph"><Icon id={g.icon} /></span>
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
        {/* The Rapport is a SURFACE, not a dialog: it is filled in across a whole Einsatz, it
            wants the full width its Zeiten grid and roster need, and as a sheet it had the Kroki
            framing modal opening on top of it — two dialogs deep. It carries R like every other
            surface carries its letter; what R used to do (Nach Norden) has the compass, which is
            on screen at all times and rotates to say so (see lib/hotkeys). */}
        <button className={`nav-item${p.mode === 'rapport' ? ' on' : ''}`} aria-pressed={p.mode === 'rapport'} aria-label={appConfig.copy.modes.rapport} onClick={() => p.onMode('rapport')}>
          <span className="nav-glyph"><Icon id="doc" /></span>
          <span className="nav-label">{appConfig.copy.modes.rapport}</span>
          <span className="nav-key" aria-hidden>{SURFACE_KEY.rapport}</span>
        </button>

        {/* (no object switch here: this rail is pure navigation, and collapsed — its default —
            it is a 60px glyph column with no room to say WHICH object is loaded. It lives on
            the Plan surface itself now, Whiteboard · .wb-object) */}
      </div>
      </div>

      {p.trailing}

      {/* drag GRIP — aria-label only (a native `title` would pop the OS tooltip box) */}
      <button className={`nav-grip${dragging ? ' drag' : ''}`} aria-label={nav.resize}
        onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp} />
    </nav>
  )
}
