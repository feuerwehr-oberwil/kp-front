import { useState } from 'react'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { useAuth } from '../lib/auth'
import { adminLogout } from './adminAuth'
import { IconSprite, Icon } from '../lib/icons'
import { ConfigProvider, ConfigGate, ConfigAutosaveStatus } from './ConfigContext'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { appConfig } from '../config/appConfig'
import {
  IdentitySection,
  DoctrineSection,
  JournalSection,
  FleetSection,
  LayersSection,
  ModulesSection,
} from './ConfigSections'
import { MembersView } from './MembersView'
import { RosterView } from './RosterView'
import { CaptureAdminView } from './CaptureAdminView'
import { StatsAdminView } from './StatsAdminView'
import { AlarmProviderView, VehicleProviderView } from './DataView'
import { SystemView } from './SystemView'
import { BackupView } from './BackupView'
import { IncidentHistoryView } from './IncidentHistoryView'

// Every admin destination. The sidebar is the ONE navigation surface — no in-page
// anchor sub-nav, no giant scrolling forms. The former 7-section Konfiguration page is
// split into five focused "Station" pages that share a single config draft + Save bar
// (see ConfigContext); everything else is one self-contained page per entry.
type SectionId =
  | 'identitaet' | 'doktrin' | 'journal' | 'fahrzeuge' | 'ebenen' | 'objektplaene'
  | 'mitglieder' | 'mannschaft' | 'erfassung'
  | 'einsaetze' | 'divera' | 'traccar' | 'statistik'
  | 'system' | 'sicherung'

// Nav copy (label/title/lede/[tip]) lives in appConfig.copy.admin.nav.<id>; entries carry
// only their stable id + icon + which copy group heading they sit under. Resolved to strings
// inside the component (never at module top level), so locale switches apply.
interface NavEntry {
  id: SectionId
  icon: string
}
type GroupKey = 'groupStation' | 'groupPersonen' | 'groupDaten' | 'groupSystem'
interface NavGroup {
  heading: GroupKey
  entries: NavEntry[]
}

const NAV: NavGroup[] = [
  {
    heading: 'groupStation',
    entries: [
      { id: 'identitaet', icon: 'flag' },
      { id: 'doktrin', icon: 'compass' },
      { id: 'journal', icon: 'history' },
      { id: 'fahrzeuge', icon: 'truck' },
      { id: 'ebenen', icon: 'layers' },
      { id: 'objektplaene', icon: 'doc' },
    ],
  },
  {
    heading: 'groupPersonen',
    entries: [
      { id: 'mitglieder', icon: 'lock' },
      { id: 'mannschaft', icon: 'people' },
      { id: 'erfassung', icon: 'pen' },
    ],
  },
  {
    heading: 'groupDaten',
    entries: [
      { id: 'einsaetze', icon: 'history' },
      { id: 'divera', icon: 'radio' },
      { id: 'traccar', icon: 'truck' },
      { id: 'statistik', icon: 'gauge' },
    ],
  },
  {
    heading: 'groupSystem',
    entries: [
      { id: 'system', icon: 'gauge' },
      { id: 'sicherung', icon: 'swap' },
    ],
  },
]

const ALL_ENTRIES = NAV.flatMap((g) => g.entries)

/** A nav entry's resolved label/title/lede/tip from the active locale's copy catalogue. */
function navCopy(id: SectionId): { label: string; title: string; lede: string; tip?: string } {
  const c = appConfig.copy.admin.nav[id] as { label: string; title: string; lede: string; tip?: string }
  return c
}

/** Last-visited section from the device cookie, validated against the current nav (a stale
 *  or renamed id falls back to the first page). */
function initialSection(): SectionId {
  const saved = loadPrefs().adminSection
  if (saved === 'karte') return 'identitaet'
  // System & Wartung replaced the former Übersicht as the landing page (2026-07-18) —
  // it answers "is everything healthy/connected?" at a glance, which IS the landing question.
  if (saved === 'uebersicht') return 'system'
  return ALL_ENTRIES.some((e) => e.id === saved) ? (saved as SectionId) : 'system'
}

// Station pages that read the shared config document — they get the ConfigGate (draft-loading state).
const CONFIG_SECTIONS = new Set<SectionId>(['identitaet', 'doktrin', 'journal', 'fahrzeuge', 'ebenen', 'objektplaene'])
// Of those, only the genuinely-editable pages get the sticky autosave bar. The viewers
// (Fahrzeuge, Kartenebenen, Objektpläne) are read-only — edited via the CLI — so no save bar.
const AUTOSAVE_SECTIONS = new Set<SectionId>(['identitaet', 'doktrin', 'journal'])

function renderSection(id: SectionId, _navigate: (id: SectionId) => void) {
  switch (id) {
    case 'identitaet': return <IdentitySection />
    case 'doktrin': return <DoctrineSection />
    case 'journal': return <JournalSection />
    case 'fahrzeuge': return <FleetSection />
    case 'ebenen': return <LayersSection />
    case 'objektplaene': return <ModulesSection />
    case 'mitglieder': return <MembersView />
    case 'mannschaft': return <RosterView />
    case 'erfassung': return <CaptureAdminView />
    case 'einsaetze': return <IncidentHistoryView />
    case 'divera': return <AlarmProviderView />
    case 'traccar': return <VehicleProviderView />
    case 'statistik': return <StatsAdminView />
    case 'system': return <SystemView />
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
  // Lightweight local section switch (no router); the last page is remembered per device.
  const [section, setSection] = useState<SectionId>(initialSection)
  // Mobile drawer open state — desktop ignores this (sidebar is always shown).
  const [navOpen, setNavOpen] = useState(false)

  const active = ALL_ENTRIES.find((e) => e.id === section) ?? ALL_ENTRIES[0]
  const activeCopy = navCopy(active.id)
  const isConfig = CONFIG_SECTIONS.has(section)

  const select = (id: SectionId) => {
    setSection(id)
    setNavOpen(false)
    savePrefs({ ...loadPrefs(), adminSection: id })
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
              <Icon id={navOpen ? 'close' : 'layers'} />
            </button>
            <span className="adm-station">{appName}</span>
            <span className="adm-verwaltung">{C.shell.verwaltung}</span>
          </div>
          <div className="adm-header-right">
            <a className="adm-link" href="/">{C.shell.toLageMap}</a>
            <button type="button" className="btn adm-logout" onClick={() => void fullLogout()}>
              {C.shell.logout}
            </button>
          </div>
        </header>

        <div className="adm-body">
          <nav
            className={`adm-side${navOpen ? ' open' : ''}`}
            aria-label={C.shell.navAria}
          >
            {NAV.map((group) => (
              <div className="adm-side-group" key={group.heading}>
                <p className="adm-side-heading">{C.nav[group.heading]}</p>
                <ul className="adm-side-list">
                  {group.entries.map((entry) => {
                    const on = entry.id === section
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          className={`adm-side-item${on ? ' on' : ''}`}
                          aria-current={on ? 'page' : undefined}
                          onClick={() => select(entry.id)}
                        >
                          <Icon id={entry.icon} className="adm-side-ic" />
                          <span className="adm-side-label">{navCopy(entry.id).label}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
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

          <main className="adm-main">
            <div className="adm-col">
              <div className="adm-pagehead">
                <div>
                  <h1 className="adm-h1">
                    {activeCopy.title}
                  </h1>
                  <p className="adm-lede">{activeCopy.lede}</p>
                </div>
                {AUTOSAVE_SECTIONS.has(section) && <ConfigAutosaveStatus />}
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
