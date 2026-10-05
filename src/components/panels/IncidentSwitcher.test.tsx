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
