// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ConfirmCard } from './ConfirmCard'

afterEach(cleanup)

const ask = { title: 'Abmelden?', message: 'Danach …', confirmLabel: 'Abmelden', cancelLabel: 'Abbrechen' }

describe('ConfirmCard · initial focus', () => {
  // a keyboard cover's Enter pressed «to get the dialog away» must not confirm a destructive ask
  it('focuses «Abbrechen» first on a danger ask', async () => {
    render(<ConfirmCard open {...ask} danger onResolve={vi.fn()} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Abbrechen' })))
  })

  it('focuses the confirm on an ordinary ask — the operator came here to do it', async () => {
    render(<ConfirmCard open {...ask} onResolve={vi.fn()} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Abmelden' })))
  })
})

// the double-contact question: «OK» (writes nothing) is the one a reflex presses (25.09.2026)
describe('ConfirmCard · safeAnswer', () => {
  const echo = { message: 'T1: Kontakt wurde vor 21 s schon bestätigt.', confirmLabel: 'Nochmals', cancelLabel: 'OK' }

  it('makes the safe answer the filled, focused, right-hand button and the confirm the quiet one', async () => {
    render(<ConfirmCard open {...echo} safeAnswer="cancel" onResolve={vi.fn()} />)
    const ok = screen.getByRole('button', { name: 'OK' })
    const again = screen.getByRole('button', { name: 'Nochmals' })
    await waitFor(() => expect(document.activeElement).toBe(ok))
    expect(ok.className).toContain('primary')
    expect(again.className).not.toContain('primary')
    const order = Array.from(document.querySelectorAll('.confirm-actions button')).map((b) => b.textContent)
    expect(order).toEqual(['Nochmals', 'OK'])
  })

  it('still answers true for the confirm and false for the safe answer', () => {
    const onResolve = vi.fn()
    render(<ConfirmCard open {...echo} safeAnswer="cancel" onResolve={onResolve} />)
    screen.getByRole('button', { name: 'OK' }).click()
    expect(onResolve).toHaveBeenLastCalledWith(false)
    screen.getByRole('button', { name: 'Nochmals' }).click()
    expect(onResolve).toHaveBeenLastCalledWith(true)
  })
})

describe('ConfirmCard · safeAnswer on the alternative', () => {
  it('focuses and fills the alternative, and the confirm goes quiet', async () => {
    render(<ConfirmCard open message="1 Trupp noch angemeldet." confirmLabel="Schliessen" cancelLabel="Abbrechen"
      altLabel="Zur Tafel" safeAnswer="alt" onResolve={vi.fn()} />)
    const alt = screen.getByRole('button', { name: 'Zur Tafel' })
    await waitFor(() => expect(document.activeElement).toBe(alt))
    expect(alt.className).toContain('primary')
    expect(screen.getByRole('button', { name: 'Schliessen' }).className).not.toContain('primary')
  })
})
