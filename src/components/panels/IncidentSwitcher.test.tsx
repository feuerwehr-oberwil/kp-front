// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { IncidentSwitcher } from './IncidentSwitcher'
import { appConfig } from '../../config/appConfig'

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

// Owner 16.10.2026: «Karte & Objekte» heads the «App» group, and says where it picks up again.
describe('IncidentSwitcher · Karte & Objekte', () => {
  afterEach(() => sessionStorage.clear())

  it('heads the App group and invites to look when the viewer was not used yet', () => {
    const open = vi.fn()
    renderSwitcher({ onKarte: open, onObjectVisits: () => {} })
    const row = screen.getByRole('button', { name: /Karte & Objekte/ })
    expect(row.textContent).toContain('Objekte, Pläne und Gebäude ansehen')
    // first in its group: before Objektbesuche
    const visits = screen.getByRole('button', { name: appConfig.copy.objectVisits.launcher })
    expect(row.compareDocumentPosition(visits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(row)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('names where the viewer was left', () => {
    sessionStorage.setItem('kp.karte.view', JSON.stringify({
      center: [7.57, 47.52], zoom: 17, bearing: 0, objectId: 'schloss', surface: { plan: 'p1' }, label: 'Schloss Musterdorf · Modul 1',
    }))
    renderSwitcher({ onKarte: () => {} })
    expect(screen.getByRole('button', { name: /Karte & Objekte/ }).textContent).toContain('Zurück zu Schloss Musterdorf · Modul 1')
  })

  it('draws no row for a link session (no door handed in)', () => {
    renderSwitcher()
    expect(screen.queryByRole('button', { name: /Karte & Objekte/ })).toBeNull()
  })
})
