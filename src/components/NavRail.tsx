import { useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import type { RailLabels } from '../lib/prefs'
import type { PlanDocument } from '../types'
import { RAIL_COMPACT, RAIL_LABELLED, RAIL_WIDE, planGlyph } from '../lib/navRail'
import { useRail } from '../lib/useRail'
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
   *  cross-surface dot on the «Trupps» item so a due Trupp is visible from any surface */
  azSeverity?: 0 | 1 | 2
  /** trailing slot after the surface list — the phone's 🔧 Bearbeiten toggle lives here
   *  (bar swap: tapping it replaces this surface bar with the tool rail) */
  trailing?: ReactNode
  /** device pref: put each surface's WORD under its glyph (lib/prefs · railLabels). Distinct from
   *  the expand chevron, which widens the rail and sets the word beside the glyph for as long as
   *  it stays open — this is a standing decision and costs ~10px, not 156. */
  labels?: RailLabels
}

// The single left navigation rail: it switches the whole surface (Karte · the
// current object's Pläne · Checkliste) and replaces both the old TopBar mode-switch
// and the old map-panel Rail. Compact shows glyphs only; expanded adds labels. A
// drag grip on the right edge live-resizes the rail and snaps on release — overlays
// track its width through the `--rail-w` CSS variable.
//
// The mechanic itself — the scroll edges, the nudge, revealing the active surface, publishing
// the width, the grip — is lib/useRail, shared with the right ToolRail. Only the content and
// the policy below are this rail's own.
export function NavRail(p: Props) {
  const [expanded, setExpanded] = useState(false)
  const nav = appConfig.copy.navRail

  const rail = useRail({
    varName: '--rail-w',
    compactW: p.labels === 'short' ? RAIL_LABELLED : RAIL_COMPACT,
    wideW: RAIL_WIDE,
    side: 'left',
    expanded, setExpanded,
    labels: p.labels,
    itemCount: p.planDocs.length,
    activeSelector: '.nav-item.on',
    // ⚠️ the plan tiles arrive AFTER boot and land in the middle of the list, without `mode` or
    // `activePlanId` changing — their count is part of the key so the reveal looks again.
    revealKey: `${p.mode}·${p.activePlanId}·${p.planDocs.length}`,
    // the map-control overlays drop their easing while this rail is being dragged
    dragClass: 'rail-dragging',
  })

  return (
    <nav className={`navrail rail${expanded ? ' expanded' : ''}${rail.dragging ? ' dragging' : ''}${p.labels === 'short' ? ' labelled' : ''}`}>
      {/* ⚠️ NO «Ausklappen» while the words are on. The chevron exists to reveal exactly what this
          setting already shows — with it on, expanding buys 128px of nothing but a second label
          position. It stays for everybody else, which is who it was for: somebody who does not
          know the glyphs yet and wants the names once, without a trip to the Einstellungen. */}
      {p.labels !== 'short' && (
        <button className="nav-exp rail-exp" onClick={() => rail.apply(!expanded)} aria-expanded={expanded} aria-label={expanded ? nav.collapse : nav.expand}>
          <span className="nav-exp-ic rail-exp-ic"><Icon id="chevron" className="chev" /></span><span className="rail-exp-t">{expanded ? nav.collapse : nav.expand}</span>
        </button>
      )}

      {/* surfaces — scroll if the list grows; the pinned map-controls below never scroll away.
          The wrap holds an unmasked chevron at whichever edge has hidden items (the fade alone
          was too subtle), making "scroll for more" explicit.
          ⚠️ Every rail element carries its own class AND the shared `rail-*` base (04b-rail.css):
          the base paints it, the `nav-*` name is the hook the rest of the cascade keys off — the
          phone bar rules in 15-mobile.css use several of them. */}
      <div className="rail-scroll-wrap">
      {rail.edge.top && <button type="button" className="nav-more rail-more rail-more-up" aria-label={nav.scrollMore} onClick={() => rail.nudge(-1)}><Icon id="chevron-down" /></button>}
      {rail.edge.bottom && <button type="button" className="nav-more rail-more rail-more-down" aria-label={nav.scrollMore} onClick={() => rail.nudge(1)}><Icon id="chevron-down" /></button>}
      <div ref={rail.scrollRef} className={`nav-scroll rail-scroll${rail.edge.top ? ' more-top' : ''}${rail.edge.bottom ? ' more-bottom' : ''}`}>
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
          {/* ⚠️ A STOPWATCH, not the pressure dial this item wore until 04.09. The surface is
              «Trupps» now and it carries work squads too — a Manometer names a cylinder half of
              them do not have, while the clocks (Kontaktuhr, Einsatzzeit, Pause) are what every
              Trupp on it has and what the alarm dot beside it is about. */}
          <span className="nav-glyph"><Icon id="stopwatch" />{(p.azSeverity ?? 0) >= 2 ? <span className="nav-live nav-alarm crit" /> : null}</span>
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
      <button className={`nav-grip rail-grip${rail.dragging ? ' drag' : ''}`} aria-label={nav.resize} {...rail.gripProps} />
    </nav>
  )
}
