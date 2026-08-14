// @vitest-environment jsdom
import { StrictMode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { Journal } from './Journal'
import type { TimelineEvent } from '../types'

afterEach(cleanup)

const row = (id: string, at: number, text: string): TimelineEvent => ({
  id, t: '', at: new Date(at).toISOString(), text, icon: 'type', kind: 'journal',
})

// newest first, the order the Verlauf renders in
const events = [
  row('r3', 1_060_000, 'Feuer aus'),
  row('r2', 1_040_000, 'Trupp 1 im Einsatz'),
  row('r1', 1_010_000, 'Erkundung Nordseite läuft'),
]

const cls = (id: string) => document.querySelector(`[data-ev="${id}"]`)?.className ?? ''

/** ⚠️ Rendered in <StrictMode>, like the app itself (main.tsx). React runs every effect twice in
 *  development — effect, cleanup, effect — and an «already done» ref written on the first run
 *  makes the second run a no-op. That is not a hypothetical: the landing below shipped with such
 *  a guard and was dead code in dev, so «im Verlauf» opened the Verlauf and never scrolled. A
 *  test that mounts plainly cannot see it. */
function setup(over: Partial<React.ComponentProps<typeof Journal>> = {}) {
  const props: React.ComponentProps<typeof Journal> = {
    events, plans: [], onSelect: vi.fn(), onClose: vi.fn(), ...over,
  }
  render(<StrictMode><Journal {...props} /></StrictMode>)
  return props
}

describe('Journal · landing on one row («im Verlauf» on the Wiedergabe caption)', () => {
  it('⚠️ survives StrictMode’s double mount — the landing must not be a one-shot', async () => {
    setup({ landOn: { id: 'r2', nonce: 1 } })
    await waitFor(() => expect(cls('r2')).toContain('jr-flash'))
    expect(cls('r1')).not.toContain('jr-flash')
    expect(cls('r3')).not.toContain('jr-flash')
  })
})

describe('Journal · alongside a Wiedergabe', () => {
  it('⚠️ dims the rows the playhead has not reached — they had not been written yet', () => {
    setup({ replayAtMs: 1_040_000 })
    expect(cls('r3')).toContain('jr-future')
    // the row the playhead stands in, and everything before it, are the present and the past
    expect(cls('r2')).not.toContain('jr-future')
    expect(cls('r1')).not.toContain('jr-future')
  })

  it('a row sets the MOMENT instead of flying to a place', () => {
    const onSeekTo = vi.fn()
    const onSelect = vi.fn()
    setup({ replayAtMs: 1_040_000, onSeekTo, onSelect })
    fireEvent.click(screen.getByText('Erkundung Nordseite läuft'))
    expect(onSeekTo).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('…and with no replay running a row that has no place stays inert', () => {
    const onSelect = vi.fn()
    setup({ onSelect })
    fireEvent.click(screen.getByText('Erkundung Nordseite läuft'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
