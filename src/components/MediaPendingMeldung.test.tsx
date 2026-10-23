// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { MediaPendingMeldung } from './MediaPendingMeldung'
import { Meldeleiste } from './Meldeleiste'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

// S3 (20.10.2026): captures an Abschluss left in the queue were the closing toast's second half —
// five seconds while the screen moved to the launcher. Now a row names the Einsatz and stays.
describe('MediaPendingMeldung', () => {
  it('names the Einsatz and the count, and can be waved away', () => {
    const onDismiss = vi.fn()
    render(<><MediaPendingMeldung pending={{ id: 'inc-1', title: 'Brand Musterhaus', n: 2 }} onDismiss={onDismiss} /><Meldeleiste /></>)
    const row = document.querySelector('.ml .ml-row')!
    expect(row.textContent).toContain('Brand Musterhaus')
    expect(row.textContent).toContain('2')
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.abschluss.mediaPendingDismiss }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
