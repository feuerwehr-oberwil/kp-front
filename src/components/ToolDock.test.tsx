// @vitest-environment jsdom
// M7 C (13.11.2026): «✓ Fertig» commits a draft; the ✕ closes, at the dock's end. Round 2b: the dock
// follows the rail – every item worded with «Beschriftung» on, every item bare off, never a mix.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolDock, type DockItem } from './ToolDock'
import { appConfig } from '../config/appConfig'
import { loadPrefs, savePrefs } from '../lib/prefs'

afterEach(() => {
  cleanup()
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

describe('ToolDock', () => {
  it('commits on «Fertig», and keeps the ✕ last', () => {
    const commit = vi.fn()
    const { container } = render(<ToolDock groups={lineDock(commit)} />)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.done }))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.wb-dock')!.lastElementChild!.classList.contains('wb-dock-x')).toBe(true)
  })

  it('words every item under its glyph while the rails wear their words', () => {
    const { container } = render(<ToolDock groups={lineDock()} />)
    expect(words(container)).toEqual(['Freihand', 'Punkte', appConfig.copy.done, appConfig.copy.toolDock.infoWord, appConfig.copy.cancel])
  })

  it('draws every item bare with the words off, and a dock with a swatch stays bare', () => {
    savePrefs({ ...loadPrefs(), railLabels: 'off', railLabelsChosen: true })
    const { container } = render(<ToolDock groups={lineDock()} />)
    expect(words(container)).toEqual([])
    cleanup()
    savePrefs({ ...loadPrefs(), railLabels: 'short', railLabelsChosen: true })
    const swatch = render(<ToolDock groups={[...lineDock(), [{ type: 'colors', value: '#000', onChange: () => {} }]]} />)
    expect(words(swatch.container)).toEqual([])
  })
})
