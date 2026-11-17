import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { useAuth } from '../lib/auth'
import { adminLogout } from './adminAuth'
import { IconSprite, Icon } from '../lib/icons'
import { InfoTip } from './InfoTip'
import { ConfigProvider, ConfigGate, ConfigAutosaveStatus } from './ConfigContext'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { ADMIN_ENTRIES, ADMIN_NAV, adminAreaOf, adminSectionFromPath, adminSectionHref, resolveAdminSection, type SectionId } from './adminNavigation'
import { appConfig } from '../config/appConfig'
import {
  IdentitySection,
  DoctrineSection,
  ReportSection,
  AlarmsSection,
  FleetSection,
  LayersSection,
  ModulesSection,
} from './ConfigSections'
import { MembersView } from './MembersView'
import { RosterView } from './RosterView'
import { LinksView } from './LinksView'
import { AlarmProviderView, VehicleProviderView } from './DataView'
import { StationWorkbookView } from './StationWorkbookView'
import { MaterialView } from './MaterialView'
import { SystemView } from './SystemView'
import { BackupView } from './BackupView'
import { IncidentHistoryView } from './IncidentHistoryView'
import { ChecklistsView } from './ChecklistsView'
import { CredentialsView } from './CredentialsView'
import { ObjectVisitsView } from './ObjectVisitsView'
import { BoardTemplatesView } from './BoardTemplatesView'

/** A nav entry's resolved label/title/lede/tip from the active locale's copy catalogue.
 *  ⚠️ The lede is OPTIONAL: a page whose surfaces already say what they are (Objektpläne) drops
 *  it rather than repeating its own sidebar entry in a sentence — the ⓘ on the h1 keeps the
 *  explanation. Missing must render nothing at all, not an empty paragraph holding its margin. */
function navCopy(id: SectionId): { label: string; title: string; lede?: string; tip?: string } {
  const c = appConfig.copy.admin.nav[id] as { label: string; title: string; lede?: string; tip?: string }
  return c
}

/** Explicit URLs win over the remembered page. Unknown explicit paths land on System,
 *  never on an unrelated cookie choice; only bare /admin resumes the last visited page. */
function initialSection(): SectionId {
  return adminSectionFromPath(window.location.pathname)
    ?? resolveAdminSection(loadPrefs().adminSection)
    ?? 'system'
}

// Station pages that read the shared config document — they get the ConfigGate (draft-loading state).
// 'mannschaft' is on the list for ONE config field (the station's name order); the rest of that
// page talks to the personnel API directly.
const CONFIG_SECTIONS = new Set<SectionId>(['identitaet', 'doktrin', 'rapport', 'alarme', 'fahrzeuge', 'material', 'ebenen', 'objektplaene', 'mannschaft', 'objektbesuche'])
// Of those, only the genuinely-editable pages get the sticky autosave bar. Objektpläne is a
// read-only viewer — edited via the CLI — so no save bar. 'fahrzeuge' IS on the list: its vehicle
// list is edited in place (ConfigSections · FleetVehiclesEditor), and a page that autosaves
// without saying so is a page nobody can tell has saved. 'ebenen' likewise, since its raster
// layers (WMS/WMTS) became editable (ConfigSections · ReferenceRasterEditor) — the overview
// above them stays a viewer.
const AUTOSAVE_SECTIONS = new Set<SectionId>(['identitaet', 'doktrin', 'rapport', 'alarme', 'fahrzeuge', 'ebenen', 'mannschaft', 'objektbesuche'])

/** A page's «go there» callback, narrowed by a real lookup rather than a cast: the pages that
 *  link out name their target as a plain string (they have no business importing this union),
 *  and a typo there should do nothing rather than push an id the shell cannot render. */
function navigator(navigate: (id: SectionId) => void) {
  return (id: string) => {
    const hit = ADMIN_ENTRIES.find((e) => e.id === id)
    if (hit) navigate(hit.id)
  }
}

function renderSection(id: SectionId, navigate: (id: SectionId) => void) {
  const go = navigator(navigate)
  switch (id) {
    case 'identitaet': return <IdentitySection />
    case 'doktrin': return <DoctrineSection />
    case 'rapport': return <ReportSection />
    case 'alarme': return <AlarmsSection />
    case 'fahrzeuge': return <FleetSection />
    // A CONFIG_SECTION (it reads `mittel.*` off the shared draft) but NOT an AUTOSAVE_SECTION:
    // it is a viewer, like Objektpläne. The Mittel catalogue is written by the Arbeitsmappe
    // alone, so this page only links there — it never forks that write path.
    case 'material': return <MaterialView onNavigate={go} />
    case 'ebenen': return <LayersSection />
    case 'objektplaene': return <ModulesSection />
    // Not a CONFIG_SECTION: checklist templates are reference datasets, not config-document
    // fields, so this page needs no draft and must not sit behind the ConfigGate.
    case 'checklisten': return <ChecklistsView />
    // reference datasets like the checklists: no config draft, outside the ConfigGate
    case 'tafel': return <BoardTemplatesView />
    // the module's `objectVisits` config section (autosaved) plus its own admin API
    case 'objektbesuche': return <ObjectVisitsView onNavigate={go} />
    case 'mitglieder': return <MembersView />
    case 'mannschaft': return <RosterView />
    case 'einsaetze': return <IncidentHistoryView />
    // Both report «nicht konfiguriert» on a fresh instance and can do nothing about it
    // themselves — the key is entered one page further on, so they link there.
    case 'divera': return <AlarmProviderView onNavigate={go} />
    case 'traccar': return <VehicleProviderView onNavigate={go} />
    // Not a CONFIG_SECTION: the workbook is parsed and applied SERVER-side, so this page holds
    // no config draft — one that did would be the client-side full-document write the whole
    // design exists to avoid.
    case 'arbeitsmappe': return <StationWorkbookView />
    // Also not a CONFIG_SECTION, and this one deliberately so: integration credentials live in
    // their own table, NOT in the config document — GET /api/config is public and the Sicherung
    // round-trip replaces that document wholesale.
    case 'zugaenge': return <CredentialsView />
    // the Alarm-Webhook row has no key of its own — it is set one page back, so this one navigates.
    case 'links': return <LinksView onNavigate={go} />
    // the Einrichtung card links into the pages that fix each row, so this one navigates.
    case 'system': return <SystemView onNavigate={go} />
    case 'sicherung': return <BackupView />
  }
}

// Desktop admin chrome: a calm header bar over a left sidebar nav + a content column.
// NOT the 3am-tablet ergonomics of the field app — this is a back-office surface — but
// the controls still respect --tap and the global token palette so day/night both work.
// On narrow widths the sidebar collapses to a toggleable slide-in drawer.
export function AdminShell() {
  const { logout } = useAuth()
  // Logging out of the shell clears the admin session too, not just the kiosk login.
  const fullLogout = async () => {
    try { await adminLogout() } catch { /* best-effort */ }
    await logout()
  }
  const C = appConfig.copy.admin
  const appName = getDeploymentConfig().identity?.appName ?? 'KP Front'
  // Local route state; stable paths and popstate give every page refresh/Back support. The
  // sidebar shows seven areas; opening one exposes its page links. Navigation changes only the
  // page: the one ConfigProvider stays mounted, preserving its draft and guards.
  const [section, setSection] = useState<SectionId>(initialSection)
  const [expandedArea, setExpandedArea] = useState<string | null>(() => adminAreaOf(section).id)
  const mainRef = useRef<HTMLElement>(null)
  // Mobile drawer open state — desktop ignores this (sidebar is always shown).
  const [navOpen, setNavOpen] = useState(false)

  /** Shows a page without touching history – the one place section state and prefs change. */
  const show = (id: SectionId) => {
    setSection(id)
    setExpandedArea(adminAreaOf(id).id)
    setNavOpen(false)
    savePrefs({ ...loadPrefs(), adminSection: id })
  }

  useEffect(() => {
    const initial = initialSection()
    savePrefs({ ...loadPrefs(), adminSection: initial })
    // canonical URL for whatever was asked (bare /admin, a single segment, an old id)
    window.history.replaceState(window.history.state, '', adminSectionHref(initial) + window.location.search + window.location.hash)
    const onPop = () => show(initialSection())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0 }, [section])
  // the phone's sections drawer closes on Escape as on its scrim (S8, 20.10.2026)
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navOpen])

  const activeCopy = navCopy(section)
  const isConfig = CONFIG_SECTIONS.has(section)

  const select = (id: SectionId) => {
    if (window.location.pathname !== adminSectionHref(id)) {
      window.history.pushState(null, '', adminSectionHref(id))
    }
    show(id)
  }

  const follow = (event: MouseEvent<HTMLAnchorElement>, id: SectionId) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    select(id)
  }

  return (
    <ConfigProvider>
      <div className="adm">
        <IconSprite />

        <header className="adm-header">
          <div className="adm-header-left">
            <button
              type="button"
              className="adm-navtoggle"
              aria-label={navOpen ? C.shell.closeSections : C.shell.openSections}
              aria-expanded={navOpen}
              onClick={() => setNavOpen((o) => !o)}
            >
              <Icon id={navOpen ? 'close' : 'menu'} />
            </button>
            <span className="adm-station">{appName}</span>
            <span className="adm-verwaltung">{C.shell.verwaltung}</span>
          </div>
          <div className="adm-header-right">
            {/* docs/ is written for exactly this reader and was linked from nowhere in /admin.
                Persistent rather than per-page: whatever the question is, the answer is in the
                same manual. Address lives in the copy layer so a fork retargets it once. */}
            <a className="adm-link adm-header-out" href={`${C.docs.repo}${C.docs.root}`} target="_blank" rel="noreferrer">
              {C.shell.docs}
            </a>
            <a className="adm-link adm-header-out" href="/">{C.shell.toLageMap}</a>
            <button type="button" className="btn adm-logout" onClick={() => void fullLogout()}>
              {C.shell.logout}
            </button>
          </div>
        </header>

        <div className="adm-save-alert" role="status">
          <ConfigAutosaveStatus scope="attention" />
        </div>

        <div className="adm-body">
          <nav
            className={`adm-side${navOpen ? ' open' : ''}`}
            aria-label={C.shell.navAria}
          >
            {/* Phone only (admin.css · .adm-side-out): the header's two links move in here, so the
                bar keeps room for the station name and Abmelden — at 390px the four of them had
                squeezed the name down to «F…». On top of the drawer, not under its 20 entries:
                «Zur Karte» is the way out and should not need a scroll to find. */}
            <div className="adm-side-group adm-side-out">
              <ul className="adm-side-list">
                <li>
                  <a className="adm-side-item" href="/">
                    <Icon id="map" className="adm-side-ic" />
                    <span className="adm-side-label">{C.shell.toLageMapNav}</span>
                  </a>
                </li>
                <li>
                  <a className="adm-side-item" href={`${C.docs.repo}${C.docs.root}`} target="_blank" rel="noreferrer">
                    <Icon id="info" className="adm-side-ic" />
                    <span className="adm-side-label">{C.shell.docs}</span>
                  </a>
                </li>
              </ul>
            </div>
            {ADMIN_NAV.map((group) => {
              const activeArea = group.entries.some((entry) => entry.id === section)
              const first = group.entries[0]
              const pageLink = (entry: typeof first, label: string) => (
                <a
                  className={`adm-side-item${entry.id === section ? ' on' : ''}`}
                  href={adminSectionHref(entry.id)}
                  aria-current={entry.id === section ? 'page' : undefined}
                  onClick={(event) => follow(event, entry.id)}
                >
                  <Icon id={entry.icon} className="adm-side-ic" />
                  <span className="adm-side-label">{label}</span>
                </a>
              )
              if (group.entries.length === 1) {
                return <div className="adm-side-group" key={group.id}>{pageLink(first, C.nav[group.heading])}</div>
              }
              return (
                <details
                  className="adm-side-group"
                  key={group.id}
                  open={expandedArea === group.id}
                  onToggle={(event) => {
                    if (event.currentTarget.open) setExpandedArea(group.id)
                    else setExpandedArea((current) => current === group.id ? null : current)
                  }}
                >
                  {/* Native disclosure, rather than ListRow: summary owns keyboard/expanded
                      semantics and exposes the area without navigating to an arbitrary page. */}
                  <summary className={`adm-side-item${activeArea ? ' on' : ''}`}>
                    <Icon id={group.icon} className="adm-side-ic" />
                    <span className="adm-side-label">{C.nav[group.heading]}</span>
                    <Icon id="chevron-down" className="adm-side-ic" />
                  </summary>
                  <ul className="adm-side-list adm-side-pages">
                    {group.entries.map((entry) => (
                      <li key={entry.id}>{pageLink(entry, navCopy(entry.id).label)}</li>
                    ))}
                  </ul>
                </details>
              )
            })}
          </nav>

          {/* scrim closes the mobile drawer on tap-away */}
          {navOpen && (
            <button
              type="button"
              className="adm-side-scrim"
              aria-label={C.shell.closeSections}
              onClick={() => setNavOpen(false)}
            />
          )}

          <main className="adm-main" ref={mainRef}>
            <div className="adm-col">
              <div className="adm-pagehead">
                <div>
                  <h1 className="adm-h1">
                    {activeCopy.title}
                    {/* The page's own ⓘ. `tip` had been in the copy catalogue for months and was
                        rendered nowhere, so every page that had more to say than one sentence
                        said it in the lede — which is how a caption becomes a paragraph. The
                        lede is now what the page IS; the tip is how it works. */}
                    {activeCopy.tip && <InfoTip label={activeCopy.title} text={activeCopy.tip} />}
                  </h1>
                  {activeCopy.lede && <p className="adm-lede">{activeCopy.lede}</p>}
                </div>
                {AUTOSAVE_SECTIONS.has(section) && <ConfigAutosaveStatus scope="calm" />}
              </div>

              {isConfig ? (
                <ConfigGate>
                  <div className="adm-editor">
                    {renderSection(section, select)}
                  </div>
                </ConfigGate>
              ) : (
                renderSection(section, select)
              )}
            </div>
          </main>
        </div>
      </div>
    </ConfigProvider>
  )
}
