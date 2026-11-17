// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { appConfig } from '../config/appConfig'

const api = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('../lib/incidents', () => ({
  personnelSyncPreview: () => Promise.resolve({ new: [{}], updated: [], unchanged: [], stale: [] }),
  personnelSyncExecute: api.execute,
}))
const ui = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../lib/ui', () => ({ toast: ui.toast }))
const { PersonnelSyncDialog } = await import('./PersonnelSyncDialog')

afterEach(cleanup)

// duck sweep FEEDBACK.12 (17.11.2026): a failed sync replaced the whole sheet with its error line,
// and the button to try again went with it
describe('PersonnelSyncDialog – a sync that fails', () => {
  it('is said by a toast, and the sheet keeps its counts and its «Synchronisieren»', async () => {
    api.execute.mockRejectedValueOnce(new Error('Divera antwortet nicht'))
    render(<PersonnelSyncDialog provider="Divera" onClose={() => {}} onSynced={() => {}} />)
    const sync = await screen.findByRole('button', { name: appConfig.copy.personnelSync.sync })
    fireEvent.click(sync)
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith('Divera antwortet nicht', expect.objectContaining({ tone: 'warn' })))
    expect(await screen.findByRole('button', { name: appConfig.copy.personnelSync.sync })).toBeTruthy()
    expect(screen.queryByText('Divera antwortet nicht')).toBeNull()
  })
})
