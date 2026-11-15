// @vitest-environment jsdom
// M7 C (13.11.2026): «✓ Fertig» commits a draft; the ✕ closes, at the dock's end. Round 2b + round
// 15.11.2026 #2: the dock follows the rails – every item worded with «Beschriftung» on (the phone's
// row too, and the Form's preview with its name), every item bare off, never a mix.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolDock, type DockItem } from './ToolDock'
import { appConfig } from '../config/appConfig'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { useIsPhone } from '../lib/useIsPhone'

vi.mock('../lib/useIsPhone', async (original) => ({ ...await original<typeof import('../lib/useIsPhone')>(), useIsPhone: vi.fn(() => false) }))

afterEach(() => {
  cleanup()
  vi.mocked(useIsPhone).mockReturnValue(false)
  savePrefs({ ...loadPrefs(), railLabels: undefined, railLabelsChosen: undefined })
})

const words = (container: HTMLElement) => [...container.querySelectorAll('.wb-dock-word')].map((w) => w.textContent)
const lineDock = (commit = vi.fn()): DockItem[][] => [
  [{ type: 'close', onClick: () => {} }],
  [
    { type: 'toggle', icon: 'pen', label: 'Freihand', on: false, onClick: () => {} },
    { type: 'toggle', icon: 'polygon', label: 'Punkte', on: true, onClick: () => {} },
    { type: 'go', onClick: commit },
  ],
  [{ type: 'info', text: 'Tippen setzt Punkte' }],
]
const lineWords = ['Freihand', 'Punkte', appConfig.copy.done, appConfig.copy.toolDock.infoWord, appConfig.copy.cancel]

describe('ToolDock', () => {
  it('commits on «Fertig», and keeps the ✕ last', () => {
    const commit = vi.fn()
    const { container } = render(<ToolDock groups={lineDock(commit)} />)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.done }))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.wb-dock')!.lastElementChild!.classList.contains('wb-dock-x')).toBe(true)
  })

  it('words every item under its glyph while the rails wear their words – on the phone too', () => {
    const { container } = render(<ToolDock groups={lineDock()} />)
    expect(words(container)).toEqual(lineWords)
    cleanup()
    vi.mocked(useIsPhone).mockReturnValue(true)
    const phone = render(<ToolDock groups={lineDock()} />)
    expect(words(phone.container)).toEqual(lineWords)
  })

  // round 15.11.2026 r2: a label too long for a tile brings a short word; the long form stays the name
  it('words a control with its short word and keeps the long one as its name', () => {
    const { container } = render(<ToolDock groups={[[{ type: 'toggle', icon: 'place-repeat', label: 'Mehrere platzieren', short: 'Mehrere', on: false, onClick: () => {} }]]} />)
    expect(words(container)).toEqual(['Mehrere'])
    expect(screen.getByRole('button', { name: 'Mehrere platzieren' }).title).toBe('Mehrere platzieren')
  })

  it('words the Form preview with its name, and draws every item bare with the words off', () => {
    const shapeDock: DockItem[][] = [[{ type: 'close', onClick: () => {} }], [{ type: 'glyph', node: <svg />, label: 'Rechteck' }]]
    const { container } = render(<ToolDock groups={shapeDock} />)
    expect(words(container)).toEqual(['Rechteck', appConfig.copy.cancel])
    cleanup()
    savePrefs({ ...loadPrefs(), railLabels: 'off', railLabelsChosen: true })
    vi.mocked(useIsPhone).mockReturnValue(true)
    expect(words(render(<ToolDock groups={[...lineDock(), ...shapeDock]} />).container)).toEqual([])
  })
})
