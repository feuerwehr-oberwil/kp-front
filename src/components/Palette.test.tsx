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

// the station's Bezeichnung list for the generic Fahrzeug (station config, lib/symbols)
vi.mock('../lib/symbols', async (orig) => ({
  ...(await orig<typeof import('../lib/symbols')>()),
  symbolTitleOptions: (name?: string) => (name === 'VKF Fahrzeug' ? ['TLF', 'MTF'] : undefined),
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

// owner pick, morning round 26.11.2026 («TLF» search): the station's own vehicles are big named
// tiles – first among a search's hits, and without a search just before the Fahrzeug's category
describe('own vehicles in the palette', () => {
  const fleet: SymbolsApi = {
    ...sym,
    order: ['Wasser', 'Fahrzeuge'],
    symbols: [...sym.symbols, { cat: 'Fahrzeuge', name: 'VKF Fahrzeug', svg: '<svg/>' }],
  }
  const heads = () => [...document.querySelectorAll('.sym-ghead')].map((h) => h.textContent)

  it('stand before the Fahrzeug category without a search, each a tile wearing its name', () => {
    render(<Palette sym={fleet} onPick={vi.fn()} onClose={vi.fn()} />)
    expect(heads()).toEqual(['Wasser', 'Eigene Fahrzeuge', 'Fahrzeuge'])
    expect(screen.getByRole('button', { name: 'TLF' }).className).toBe('sym-vtile')
  })

  it('picks the generic Fahrzeug already named', () => {
    const onPick = vi.fn()
    render(<Palette sym={fleet} onPick={onPick} onClose={vi.fn()} />)
    screen.getByRole('button', { name: 'MTF' }).click()
    expect(onPick).toHaveBeenCalledWith('VKF Fahrzeug', 'MTF')
  })
})
