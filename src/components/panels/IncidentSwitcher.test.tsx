// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { IncidentSwitcher } from './IncidentSwitcher'
import { appConfig } from '../../config/appConfig'
import type { IncidentMeta } from '../../lib/incidents'

afterEach(cleanup)

function renderSwitcher(extra: Partial<Parameters<typeof IncidentSwitcher>[0]> = {}) {
  render(
    <IncidentSwitcher
      active={null}
      incidents={[]}
      isEditor
      syncStatus="synced"
      lastSyncedAt={null}
      user={{ display_name: 'Muster Anna', color: null, role: 'editor' }}
      onSwitch={() => {}}
      onDivera={() => {}}
      onHelp={() => {}}
      onSyncNow={() => {}}
      {...extra}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: appConfig.copy.incidentSwitcher.noIncident }))
}

/** The menu over an open Einsatz: the pill is named after it. */
function renderActive(extra: Partial<Parameters<typeof IncidentSwitcher>[0]> & { active: IncidentMeta }) {
  render(
    <IncidentSwitcher
      incidents={[]}
      isEditor
      syncStatus="synced"
      lastSyncedAt={null}
      user={{ display_name: 'Muster Anna', color: null, role: 'editor' }}
      onSwitch={() => {}}
      onDivera={() => {}}
      onHelp={() => {}}
      onSyncNow={() => {}}
      {...extra}
    />,
  )
  // a closed one's pill also says so («…, Einsatz abgeschlossen»)
  fireEvent.click(screen.getByRole('button', { name: (n) => n.startsWith(extra.active.title) }))
}

// Staging 03.10.2026: a device that always opens its running Einsatz never sees the launcher,
// so Objektbesuche has a second door in the menu every Einsatz carries.
describe('IncidentSwitcher · Objektbesuche', () => {
  it('offers Objektbesuche when the app hands a door, and opens it', () => {
    const open = vi.fn()
    renderSwitcher({ onObjectVisits: open })
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.objectVisits.launcher }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('draws no row where the module is off or the session is a link', () => {
    renderSwitcher()
    expect(screen.queryByRole('button', { name: appConfig.copy.objectVisits.launcher })).toBeNull()
  })
})

// Owner 17.10.2026: the row to «Karte & Objekte» is «Einsatz verlassen» (it was «Karte & Objekte»
// in the App group). It is about THIS Einsatz, so it heads the doors out of it, and its sub line
// says the Einsatz keeps running — «verlassen» must never read as closing it.
describe('IncidentSwitcher · Einsatz verlassen', () => {
  afterEach(() => sessionStorage.clear())
  const active = {
    id: 'inc-1', title: 'Brand Musterhaus', address: 'Musterweg 1', started_at: new Date(Date.now() - 600_000).toISOString(),
    status: 'offen', is_archived: false, is_exercise: false,
  } as unknown as IncidentMeta
  const other = { ...active, id: 'inc-2', title: 'Ölspur Hauptstrasse', address: 'Hauptstrasse 2' } as IncidentMeta

  it('sits under the running rows, above «Alle Einsätze», and says the Einsatz runs on', () => {
    const leave = vi.fn()
    renderActive({ active, incidents: [active, other], onKarte: leave, onHistory: () => {}, onObjectVisits: () => {} })
    const row = screen.getByRole('button', { name: /Einsatz verlassen/ })
    expect(row.textContent).toContain('Läuft weiter – zur Karte')
    const running = screen.getByRole('button', { name: /Ölspur Hauptstrasse/ })
    const history = screen.getByRole('button', { name: appConfig.copy.incidentSwitcher.allIncidents })
    const visits = screen.getByRole('button', { name: appConfig.copy.objectVisits.launcher })
    expect(running.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // no longer in the «App» group
    expect(row.compareDocumentPosition(visits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Karte & Objekte/ })).toBeNull()
    fireEvent.click(row)
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('names where the viewer picks up again', () => {
    sessionStorage.setItem('kp.karte.view', JSON.stringify({
      center: [7.57, 47.52], zoom: 17, bearing: 0, objectId: 'schloss', surface: { plan: 'p1' }, label: 'Schloss Musterdorf · Modul 1',
    }))
    renderActive({ active, incidents: [active], onKarte: () => {} })
    expect(screen.getByRole('button', { name: /Einsatz verlassen/ }).textContent).toContain('Läuft weiter – zurück zu Schloss Musterdorf · Modul 1')
  })

  it('draws no row for a link session (no door handed in), and no Einsätze group either', () => {
    renderActive({ active, incidents: [active], isEditor: false })
    expect(screen.queryByRole('button', { name: /Einsatz verlassen/ })).toBeNull()
    expect(screen.queryByRole('button', { name: appConfig.copy.incidentSwitcher.allIncidents })).toBeNull()
    expect(screen.queryByText(appConfig.copy.incidentSwitcher.noOpenIncidents)).toBeNull()
  })
})

// S8 (20.10.2026, owner: «all dropdowns, popovers … closable by Escape»). The menu stays
// non-modal; one Escape closes it and nothing behind it — the workspace's own Escape listens on
// window and must not also peel the map's next layer.
describe('IncidentSwitcher · Escape', () => {
  it('closes the menu, and the key does not travel on to the workspace', () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    try {
      renderSwitcher()
      expect(document.querySelector('.ip-menu')).not.toBeNull()
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(document.querySelector('.ip-menu')).toBeNull()
      expect(behind).not.toHaveBeenCalled()
      // closed: the next Escape is the workspace's again
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(behind).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', behind)
    }
  })

  it('leaves the key to a sheet opened from the menu', () => {
    renderSwitcher({ sheetOpen: true })
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', behind)
    expect(behind).toHaveBeenCalledTimes(1)
  })
})

// Sweep #5 (27.10.2026, owner pick B): a closed Einsatz wears its lock in the pill's ✓ slot, and
// the card's «Gespeichert» becomes «Abgeschlossen <time>» – a pill that folds out the sentence and
// the exits only when tapped. The sentence is the session's own (RBAC audit 22.10.2026).
describe('IncidentSwitcher · closed Einsatz', () => {
  const C = appConfig.copy.archived
  const closed = {
    id: 'inc-1', title: 'Brandmeldeanlage', address: 'Gewerbestrasse 4', started_at: new Date(Date.now() - 3_600_000).toISOString(),
    status: 'abgeschlossen', is_archived: true, is_exercise: false, closed_at: new Date(Date.now() - 1_800_000).toISOString(),
    last_closed_at: new Date(Date.now() - 600_000).toISOString(),
  } as unknown as IncidentMeta
  const pill = () => screen.getByRole('button', { name: new RegExp(`^${C.closedAt.replace('{t}', '')}`) })

  it('replaces «Gespeichert» with the close time and folds out the exits only on tap', async () => {
    const reopen = vi.fn(async () => 'ok' as const)
    const back = vi.fn()
    renderActive({ active: closed, onReactivate: reopen, onBackFromArchive: back })
    expect(screen.queryByText(appConfig.copy.incidentSwitcher.saved)).toBeNull()
    expect(screen.queryByText(C.reactivate)).toBeNull()
    fireEvent.click(pill())
    expect(screen.getByText(C.hint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: C.reactivate }))
    expect(reopen).toHaveBeenCalledTimes(1)
  })

  it('is the sentence alone in a link session', () => {
    renderActive({ active: closed, user: { display_name: 'Link', color: null, role: 'viewer' } })
    fireEvent.click(pill())
    expect(screen.getByText(C.hintViewOnly)).toBeTruthy()
    expect(screen.queryByRole('button', { name: C.back })).toBeNull()
  })
})

// M6 A (13.11.2026): a session that writes nothing here says «Nur ansehen» in the ✓'s slot, and
// its reason in the opened card. M11 B: another Einsatz's alarm puts a red dot on the shut pill.
describe('IncidentSwitcher · Nur ansehen and the foreign-alarm dot', () => {
  const cp = appConfig.copy.incidentSwitcher
  const active = {
    id: 'inc-1', title: 'Zimmerbrand', address: 'Schlossgasse 10', started_at: new Date(Date.now() - 600_000).toISOString(),
    status: 'offen', is_archived: false, is_exercise: false,
  } as unknown as IncidentMeta
  const pill = () => screen.getByRole('button', { name: (n) => n.startsWith(active.title) })
  const renderShut = (extra: Partial<Parameters<typeof IncidentSwitcher>[0]>) => render(
    <IncidentSwitcher active={active} incidents={[active]} isEditor={false} syncStatus="synced" lastSyncedAt={null}
      user={{ display_name: 'Betrachter', color: null, role: 'viewer' }} onSwitch={() => {}} onDivera={() => {}}
      onHelp={() => {}} onSyncNow={() => {}} {...extra} />,
  )

  it('wears «Nur ansehen» instead of the ✓, and the card names the reason', () => {
    renderShut({ viewOnly: 'viewer' })
    expect(pill().getAttribute('aria-label')).toContain(cp.viewOnly)
    expect(pill().querySelector('.ip-viewonly-chip')?.textContent).toBe(cp.viewOnly)
    expect(pill().querySelector('.ip-status')).toBeNull()
    fireEvent.click(pill())
    expect(screen.getByText(`${cp.viewOnly} · ${cp.viewOnlyWhy.viewer}`)).toBeTruthy()
  })

  // round 2b (owner's pick «Only show problems»): all saved → no mark; the ✓ is the card's
  it('shows no mark where the session writes and all is saved, and a sync warning outranks «Nur ansehen»', () => {
    renderShut({ viewOnly: null })
    expect(pill().querySelector('.ip-viewonly-chip')).toBeNull()
    expect(pill().querySelector('.ip-status')).toBeNull()
    expect(pill().dataset.sync).toBe('synced')
    cleanup()
    renderShut({ viewOnly: 'el', syncStatus: 'offline' })
    expect(pill().querySelector('.ip-viewonly-chip')).toBeNull()
    expect(pill().textContent).toContain(cp.offlineShort)
  })

  // round 2b: «Nicht synchronisiert» speaks up only once it outlasts a normal save; Offline wears
  // the struck-through cloud, pending the plain one
  it('marks pending only after the grace, and offline with the struck-through cloud', () => {
    vi.useFakeTimers()
    try {
      renderShut({ syncStatus: 'pending' })
      expect(pill().querySelector('.ip-status')).toBeNull()
      act(() => { vi.advanceTimersByTime(10_000) })
      expect(pill().querySelector('.ip-status-pending use')?.getAttribute('href')).toBe('#wx-cloud')
      cleanup()
      renderShut({ syncStatus: 'offline' })
      expect(pill().querySelector('.ip-sync-word use')?.getAttribute('href')).toBe('#cloud-off')
    } finally { vi.useRealTimers() }
  })

  it('dots the shut pill while another running Einsatz has a Trupp at the alarm tier', () => {
    const other = { ...active, id: 'inc-2', title: 'BMA Gewerbestrasse', atemschutz_due: [{ id: 't1', name: 'Trupp 1', reason: 'contact' }] } as unknown as IncidentMeta
    renderShut({ incidents: [active, other] })
    expect(pill().querySelector('.ip-foreign-dot')).not.toBeNull()
    expect(pill().getAttribute('aria-label')).toContain(cp.foreignAlarmDot)
    cleanup()
    // its own Trupps are the workspace's alarm, not a dot; and the dot goes once the list is quiet
    renderShut({ incidents: [{ ...active, atemschutz_due: [{ id: 't1', name: 'Trupp 1', reason: 'contact' }] } as unknown as IncidentMeta, { ...other, atemschutz_due: [] }] })
    expect(pill().querySelector('.ip-foreign-dot')).toBeNull()
  })
})

// Round 2b (owner's pick M12 C «Der Name sagt es», 13.11.2026): an Übung wears no tag – a quiet
// «Übung ·» stands before its name in the head, on the card and in the running rows, and a screen
// reader hears «Übung, <name>» once.
describe('IncidentSwitcher · Übung', () => {
  const drill = {
    id: 'inc-1', title: 'Brand Musterhaus', address: null, started_at: new Date(Date.now() - 600_000).toISOString(),
    status: 'offen', is_archived: false, is_exercise: true,
  } as unknown as IncidentMeta
  const otherDrill = { ...drill, id: 'inc-2', title: 'Ölspur Hauptstrasse' } as IncidentMeta
  /** what the eye reads: the text without the screen reader's hidden comma */
  const seen = (sel: string) => {
    const el = document.querySelector(sel)!.cloneNode(true) as HTMLElement
    el.querySelectorAll('.sr-only').forEach((n) => n.remove())
    return el.textContent
  }

  it('puts «Übung ·» before the name everywhere it shows, and says it once', () => {
    render(
      <IncidentSwitcher active={drill} incidents={[drill, otherDrill]} isEditor syncStatus="synced" lastSyncedAt={null}
        user={{ display_name: 'Muster Anna', color: null, role: 'editor' }}
        onSwitch={() => {}} onDivera={() => {}} onHelp={() => {}} onSyncNow={() => {}} />,
    )
    const head = screen.getByRole('button', { name: 'Übung, Brand Musterhaus' })
    expect(seen('.ip-switch-title')).toBe('Übung · Brand Musterhaus')
    fireEvent.click(head)
    expect(seen('.ip-card-name')).toBe('Übung · Brand Musterhaus')
    // the row of the other Übung: its accessible name reads the prefix with a pause, not «·»
    // (jsdom trims each piece of a name; a browser reads the space after the comma)
    expect(screen.getByRole('button', { name: /Übung,\s?Ölspur Hauptstrasse/ })).toBeTruthy()
    expect(document.querySelector('.ip-badge')).toBeNull()
  })
})
