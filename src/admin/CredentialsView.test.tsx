// @vitest-environment jsdom
//
// What this pins is the page's half of the write-only contract. The server never sends a
// secret — that is tested in backend/tests/test_integration_credentials.py — and this file
// asserts the three things the UI could still get wrong on its own:
//
//   1. a field the SERVER supplies must not offer an input, because a box that cannot take
//      effect is the «typed it in and nothing happened» failure the whole change removes;
//   2. «unlesbar» must read as «set it again», not as «not configured»;
//   3. a saved value must be sent to the right endpoint and the box must clear, so nobody
//      is left looking at a secret they just typed.

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiGet = vi.fn()
const apiPut = vi.fn()
const apiDelete = vi.fn()

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    apiGet: (p: string) => apiGet(p),
    apiPut: (p: string, b: unknown) => apiPut(p, b),
    apiDelete: (p: string) => apiDelete(p),
  }
})

import { CredentialsView } from './CredentialsView'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.zugaenge

interface Cred {
  name: string; group: string; label: string; secret: boolean
  source: string; configured: boolean; env: string
  value: string | null; updatedAt: string | null; updatedByName: string | null
}

const cred = (over: Partial<Cred>): Cred => ({
  name: 'stt_api_key', group: 'stt', label: 'STT-API-Key', secret: true,
  source: 'unset', configured: false, env: 'STT_API_KEY',
  value: null, updatedAt: null, updatedByName: null, ...over,
})

function serve(creds: Cred[], audit: unknown[] = []) {
  apiGet.mockImplementation((p: string) =>
    Promise.resolve(p.startsWith('/api/integrations/credentials-audit') ? audit : creds))
}

beforeEach(() => { apiGet.mockReset(); apiPut.mockReset(); apiDelete.mockReset() })
afterEach(cleanup)

describe('a credential the server supplies', () => {
  it('names the variable instead of offering a box that could not take effect', async () => {
    serve([cred({ name: 'divera_access_key', group: 'divera', label: 'Divera Accesskey', source: 'env', configured: true, env: 'DIVERA_ACCESS_KEY' })])
    render(<CredentialsView />)

    expect(await screen.findByText(C.stateEnv)).toBeTruthy()
    expect(screen.getByText('DIVERA_ACCESS_KEY')).toBeTruthy()
    // No input, no save button — «.env wins» is visible, not merely enforced server-side.
    expect(document.querySelector('.adm-cred-edit')).toBeNull()
  })
})

describe('a credential that will not decrypt', () => {
  it('says «unlesbar» and asks for it again, never «nicht gesetzt»', async () => {
    serve([cred({ source: 'unreadable', configured: false, updatedAt: '2026-08-01T10:00:00Z' })])
    render(<CredentialsView />)

    expect(await screen.findByText(C.stateUnreadable)).toBeTruthy()
    expect(screen.getByText(C.unreadableHint)).toBeTruthy()
    expect(screen.queryByText(C.stateUnset)).toBeNull()
    // …and it still offers the box, because «set it again» is the whole instruction.
    expect(document.querySelector('.adm-cred-edit')).not.toBeNull()
  })
})

describe('saving', () => {
  it('sends the value to its own endpoint and clears the box afterwards', async () => {
    serve([cred({})])
    apiPut.mockResolvedValue({})
    render(<CredentialsView />)

    const box = await screen.findByLabelText('STT-API-Key')
    fireEvent.change(box, { target: { value: 'sk-live-abc' } })
    fireEvent.click(screen.getByRole('button', { name: C.saveBtn }))

    await waitFor(() => expect(apiPut).toHaveBeenCalledWith(
      '/api/integrations/credentials/stt_api_key', { value: 'sk-live-abc' }))
    // Cleared, so the one place the secret was visible stops being visible.
    await waitFor(() => expect((box as HTMLInputElement).value).toBe(''))
  })

  it('shows the server refusal verbatim — it is the useful sentence', async () => {
    serve([cred({ name: 'traccar_url', group: 'traccar', label: 'Traccar-Server', secret: false, env: 'TRACCAR_URL' })])
    apiPut.mockRejectedValue(new Error('Die Traccar-Adresse muss mit https:// beginnen – sonst bleibt die Ortung aus.'))
    render(<CredentialsView />)

    fireEvent.change(await screen.findByLabelText('Traccar-Server'), { target: { value: 'http://gps.example.org' } })
    fireEvent.click(screen.getByRole('button', { name: C.saveBtn }))

    expect(await screen.findByText(/muss mit https:\/\/ beginnen/)).toBeTruthy()
  })
})

describe('the page says what a browser deliberately cannot set', () => {
  it('names SECRET_KEY and ADMIN_SECRET with the reason each stays in .env', async () => {
    serve([cred({})])
    render(<CredentialsView />)

    expect(await screen.findByText('SECRET_KEY')).toBeTruthy()
    expect(screen.getByText('ADMIN_SECRET')).toBeTruthy()
    expect(screen.getByText('KP_TELEMETRY_ENABLED / _DSN')).toBeTruthy()
  })
})
