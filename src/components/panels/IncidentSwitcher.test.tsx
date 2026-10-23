// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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
      onDatenquellen={() => {}}
      onHelp={() => {}}
      onOfflineReadiness={() => {}}
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
      onDatenquellen={() => {}}
      onHelp={() => {}}
      onOfflineReadiness={() => {}}
      onSyncNow={() => {}}
      {...extra}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: extra.active.title }))
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
