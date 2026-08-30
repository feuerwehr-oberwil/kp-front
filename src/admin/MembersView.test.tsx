// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// What this pins is the reason the Rolle stopped being a dropdown: it defaulted to «Betrachter»,
// which reads as a filled-in field rather than an open question, and a tester created three crew
// accounts that all came out read-only — discovered only when somebody could not write during an
// incident. So: no default, «Anlegen» refuses until the question is answered, and the answer is
// what actually reaches the server.

const { apiGet, apiPost, apiPatch, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiPatch: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPost, apiPatch, ApiError }))

import { MembersView } from './MembersView'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.members
const Cc = appConfig.copy.admin.common2

const EXISTING = {
  id: 'u1',
  username: 'fu',
  display_name: 'Führungsunterstützung',
  role: 'editor' as const,
  color: '#c0392b',
  is_active: true,
  created_at: '2026-08-01T10:00:00Z',
  last_login: null,
  el_view_default: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  apiGet.mockResolvedValue([EXISTING])
  apiPost.mockResolvedValue({})
})
afterEach(cleanup)

/** Open the add-member form and fill everything EXCEPT the role. */
const fillFormWithoutRole = async () => {
  render(<MembersView />)
  await waitFor(() => expect(screen.getByText('fu')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: C.add }))
  const inputs = document.querySelectorAll<HTMLInputElement>('.adm-members-form .adm-input')
  fireEvent.change(inputs[0], { target: { value: 'kunz' } })
  fireEvent.change(inputs[1], { target: { value: 'Kunz Bea' } })
  // the PIN field is the mono input in the second row
  const pin = screen.getByPlaceholderText('••••••')
  fireEvent.change(pin, { target: { value: '481592' } })
}

const createBtn = () => screen.getByRole('button', { name: Cc.create })

describe('Mitglied anlegen — die Rolle ist eine Frage, keine Voreinstellung', () => {
  it('keeps «Anlegen» disabled until a role is chosen, and names why', async () => {
    await fillFormWithoutRole()

    expect((createBtn() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(C.rolePickFirst)).toBeTruthy()
    // neither card starts selected
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: new RegExp(C.roleEditor) }))

    expect((createBtn() as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(C.rolePickFirst)).toBeNull()
  })

  it('sends the CHOSEN role — «Bearbeiter» does not silently become a viewer', async () => {
    await fillFormWithoutRole()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(C.roleEditor) }))
    fireEvent.click(createBtn())

    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    expect(apiPost.mock.calls[0][0]).toBe('/api/auth/users')
    expect((apiPost.mock.calls[0][1] as { role: string }).role).toBe('editor')
  })

  it('sends viewer when viewer is the card that was picked', async () => {
    await fillFormWithoutRole()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(C.roleViewer) }))
    fireEvent.click(createBtn())

    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    expect((apiPost.mock.calls[0][1] as { role: string }).role).toBe('viewer')
  })
})

// «Einrichtung» ticks «Eigene Zugänge» on `users > 1` — it counts accounts and cannot see a PIN.
// The seeded `fu` account therefore stays a working editor login behind a finished checklist, and
// this page is the only one that can say so and fix it in the same breath.
describe('das eingerichtete Erstkonto', () => {
  it('is called out while it is still active, with both ways out on the notice', async () => {
    apiGet.mockResolvedValue([EXISTING, { ...EXISTING, id: 'u2', username: 'kunz', display_name: 'Kunz Bea' }])
    render(<MembersView />)

    expect(await screen.findByText(C.seedAccountTitle.replace('{name}', 'fu'))).toBeTruthy()
    const notice = document.querySelector('.adm-seedwarn-actions') as HTMLElement
    expect(notice.querySelector('button')).toBeTruthy()
    expect(Array.from(notice.querySelectorAll('button')).map((b) => b.textContent))
      .toEqual([C.resetPin, C.deactivate])
  })

  it('says nothing once the account is deactivated', async () => {
    apiGet.mockResolvedValue([{ ...EXISTING, is_active: false }, { ...EXISTING, id: 'u2', username: 'kunz' }])
    render(<MembersView />)

    await waitFor(() => expect(screen.getByText('kunz')).toBeTruthy())
    expect(document.querySelector('.adm-seedwarn')).toBeNull()
  })
})

describe('Mitglied bearbeiten — dort EXISTIERT der Wert', () => {
  it('preselects the member\'s current role and never returns to «nothing chosen»', async () => {
    apiGet.mockResolvedValue([EXISTING, { ...EXISTING, id: 'u2', username: 'kunz', display_name: 'Kunz Bea', role: 'viewer' }])
    render(<MembersView />)
    await waitFor(() => expect(screen.getByText('kunz')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: `Geschützte Aktionen für Kunz Bea` }))
    fireEvent.click(await screen.findByText(Cc.edit))

    const viewerCard = screen.getByRole('radio', { name: new RegExp(C.roleViewer) })
    expect(viewerCard.getAttribute('aria-checked')).toBe('true')

    // switching to Bearbeiter and saving patches the role along with the rest
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(C.roleEditor) }))
    apiPatch.mockResolvedValue({})
    fireEvent.click(screen.getByRole('button', { name: Cc.save }))
    await waitFor(() => expect(apiPatch).toHaveBeenCalled())
    expect((apiPatch.mock.calls[0][1] as { role: string }).role).toBe('editor')
  })
})
