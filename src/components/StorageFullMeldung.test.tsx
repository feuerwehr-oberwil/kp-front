// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { StorageFullMeldung } from './StorageFullMeldung'
import { Meldeleiste } from './Meldeleiste'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

// S1 (20.10.2026): «Speicher voll» was a chip alone — on a phone a bare glyph — and never reached
// the Meldeleiste, while it is the one state that loses work.
describe('StorageFullMeldung', () => {
  it('raises a row that cannot be waved away and offers «Einträge sichern»', () => {
    const onExport = vi.fn()
    render(<><StorageFullMeldung onExport={onExport} onSyncNow={() => Promise.resolve()} /><Meldeleiste /></>)
    const row = document.querySelector('.ml .ml-row')!
    expect(row.textContent).toContain(appConfig.copy.incidentSwitcher.storageMeldung)
    expect(row.querySelector('.ml-x')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.journal.delivery.export }))
    expect(onExport).toHaveBeenCalledOnce()
  })
})
