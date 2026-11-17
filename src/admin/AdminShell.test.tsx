// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet, apiPut, prefs, savePrefs } = vi.hoisted(() => ({
  apiGet: vi.fn(), apiPut: vi.fn(), prefs: { adminSection: '' }, savePrefs: vi.fn(),
}))
vi.mock('../lib/auth', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('../lib/prefs', () => ({ loadPrefs: () => prefs, savePrefs }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), apiGet, apiPut }))
// Branding refresh after a successful save is independent of the shared-draft lifetime.
vi.mock('../lib/deploymentConfig', async (original) => ({
  ...await original<typeof import('../lib/deploymentConfig')>(),
  loadDeploymentConfig: vi.fn(async () => ({})), applyDeploymentBranding: vi.fn(),
}))
vi.mock('./SystemView', () => ({ SystemView: () => <p>system page</p> }))
vi.mock('./RosterView', () => ({ RosterView: () => <p>personnel page</p> }))
vi.mock('./MembersView', () => ({ MembersView: () => <p>accounts page</p> }))
vi.mock('./ConfigSections', async () => {
  const { useConfig } = await import('./ConfigContext')
  function Edit() {
    const { set, draft } = useConfig()
    return <><button onClick={() => set(['identity', 'appName'], 'Changed station')}>edit station</button><span>{draft?.identity?.appName}</span></>
  }
  return { IdentitySection: Edit, ReportSection: () => <p>report page</p> }
})

import { AdminShell } from './AdminShell'
import { ApiError } from '../lib/api'
import { appConfig } from '../config/appConfig'
const C = appConfig.copy.admin

beforeEach(() => {
  vi.clearAllMocks()
  prefs.adminSection = ''
  window.history.replaceState(null, '', '/admin')
  apiGet.mockResolvedValue({ identity: { appName: 'Station' }, version: 'v1' })
  apiPut.mockResolvedValue({ identity: { appName: 'Changed station' }, version: 'v2' })
})
afterEach(cleanup)

async function mount() { await act(async () => { render(<AdminShell />) }) }
function go(path: string) {
  window.history.replaceState(null, '', path)
  fireEvent.popState(window)
}

describe('admin shell navigation', () => {
  it('uses a direct URL before the remembered page and canonicalizes an old bookmark', async () => {
    prefs.adminSection = 'mitglieder'
    window.history.replaceState(null, '', '/admin/journal')
    await mount()
    expect(window.location.pathname).toBe('/admin/station/rapport')
  })

  it('opens the remembered page only at the bare entry, and opens its area', async () => {
    prefs.adminSection = 'mitglieder'
    await mount()
    expect(screen.getByText('accounts page')).toBeTruthy()
    expect(window.location.pathname).toBe('/admin/personal/mitglieder')
    expect(screen.getByRole('link', { name: C.nav.mitglieder.label }).getAttribute('aria-current')).toBe('page')
  })

  it('follows page links and popstate without remounting or losing the configuration draft', async () => {
    window.history.replaceState(null, '', '/admin/identitaet')
    await mount()
    fireEvent.click(screen.getByText('edit station'))
    act(() => go('/admin/personal/mannschaft'))
    expect(screen.getByText('personnel page')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: C.nav.mitglieder.label }))
    expect(window.location.pathname).toBe('/admin/personal/mitglieder')
    expect(screen.getByText('accounts page')).toBeTruthy()
    await act(async () => { window.history.back() })
    await waitFor(() => expect(screen.getByText('personnel page')).toBeTruthy())
    await act(async () => { window.history.forward() })
    await waitFor(() => expect(screen.getByText('accounts page')).toBeTruthy())
    act(() => go('/admin/station/identitaet'))
    expect(screen.getByText('Changed station')).toBeTruthy()
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('opens an area without navigating and follows its actual page link', async () => {
    await mount()
    fireEvent.click(screen.getByText(C.nav.groupPersonen))
    expect(screen.getByText('system page')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('link', { name: C.nav.mannschaft.label })).toBeTruthy())
    fireEvent.click(screen.getByRole('link', { name: C.nav.mannschaft.label }))
    expect(screen.getByText('personnel page')).toBeTruthy()
    expect(window.location.pathname).toBe('/admin/personal/mannschaft')
  })

  it('opens System for an unknown explicit path, even with a different device preference', async () => {
    prefs.adminSection = 'mitglieder'
    window.history.replaceState(null, '', '/admin/not-a-page')
    await mount()
    expect(screen.getByText('system page')).toBeTruthy()
    expect(window.location.pathname).toBe('/admin/uebersicht/system')
  })

  it('keeps a refused save visible once on an unrelated page', async () => {
    apiPut.mockRejectedValue(new ApiError(422, 'Coordinate refused'))
    window.history.replaceState(null, '', '/admin/identitaet')
    await mount()
    expect(screen.getByRole('status').textContent).toBe('')
    fireEvent.click(screen.getByText('edit station'))
    act(() => go('/admin/personal/mitglieder'))
    await waitFor(() => expect(within(screen.getByRole('status')).getByText('Coordinate refused')).toBeTruthy())
    expect(screen.getAllByText('Coordinate refused')).toHaveLength(1)
    expect(screen.getByText('accounts page')).toBeTruthy()
    act(() => go('/admin/station/identitaet'))
    expect(screen.getAllByText('Coordinate refused')).toHaveLength(1)
    expect(screen.getByText('Changed station')).toBeTruthy()
  })
})
