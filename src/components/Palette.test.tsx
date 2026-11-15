// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { SymbolsApi } from '../lib/useSymbols'
import { Palette } from './Palette'

// the on-screen keyboard, as the measuring hook reports it (jsdom has no visual viewport)
const kb = vi.hoisted(() => ({ inset: 0 }))
vi.mock('../lib/useKeyboardInset', async (orig) => ({
  ...(await orig<typeof import('../lib/useKeyboardInset')>()),
  useKeyboardInset: () => kb.inset,
}))

afterEach(() => { cleanup(); kb.inset = 0 })

const sym: SymbolsApi = {
  ready: true, error: false, reload: vi.fn(),
  order: ['Wasser'], symbols: [{ cat: 'Wasser', name: 'Hydrant', svg: '<svg/>' }], byName: { Hydrant: '<svg/>' },
}

// scroll sweep 15.11.2026 #5: the hand-rolled palette ignored the keyboard – the keys covered the
// lower half of the grid. Through `Overlay` it is lifted and capped like every other sheet.
describe('the symbol palette and the keyboard', () => {
  it('opens without the keyboard: focus is on the sheet, not in the search', async () => {
    render(<Palette sym={sym} onPick={vi.fn()} onClose={vi.fn()} />)
    const sheet = screen.getByRole('dialog')
    await waitFor(() => expect(document.activeElement).toBe(sheet))
    expect(sheet.classList.contains('is-kb')).toBe(false)
  })

  it('with the keys up it is lifted onto them and wears `is-kb` (the height cap)', () => {
    kb.inset = 300
    render(<Palette sym={sym} onPick={vi.fn()} onClose={vi.fn()} />)
    const sheet = screen.getByRole('dialog')
    expect(sheet.classList.contains('is-kb')).toBe(true)
    expect(sheet.style.getPropertyValue('--kb-inset')).toBe('300px')
    expect(sheet.style.marginBottom).not.toBe('')
  })
})
