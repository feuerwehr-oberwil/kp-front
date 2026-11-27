// @vitest-environment jsdom
// M7 C (13.11.2026): «✓ Fertig» commits a draft; the ✕ closes, at the dock's end. Round 2b + round
// 15.11.2026 #2: the dock follows the rails – every item worded with «Beschriftung» on (the phone's
// row too), every item bare off, never a mix.
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

  it('draws every item bare with the words off', () => {
    savePrefs({ ...loadPrefs(), railLabels: 'off', railLabelsChosen: true })
    vi.mocked(useIsPhone).mockReturnValue(true)
    expect(words(render(<ToolDock groups={lineDock()} />).container)).toEqual([])
  })

  // owner picks 14 + 15 (17.11.2026, from the owner's phone WIP of 16.11.): the dock LEADS with the
  // armed tool on the phone's bar and the tablet's column alike – a plain readout, the ✕ still last
  it('leads with the armed tool as a plain tile, on a phone and a tablet', () => {
    const armed = { glyph: <svg />, name: 'Linie' }
    for (const phone of [false, true]) {
      vi.mocked(useIsPhone).mockReturnValue(phone)
      const { container } = render(<ToolDock armed={armed} groups={lineDock()} />)
      expect(words(container)).toEqual(['Linie', ...lineWords])
      const tile = screen.getByRole('img', { name: 'Linie' })
      expect(tile.tagName).toBe('DIV') // a readout, not a control
      expect(container.querySelector('.wb-dock')!.firstElementChild).toBe(tile)
      expect(container.querySelector('.wb-dock')!.lastElementChild!.classList.contains('wb-dock-x')).toBe(true)
      cleanup()
    }
  })

  // Üben feedback 27.11.2026 (owner: «on modules it seems to be somewhat centered and in the map
  // it's at the top»): the column stands level with the rail's top on the Karte AND on every Plan –
  // it looked for the Karte's `.tool-rail` alone and fell back to the centring on `.wb-tools`
  it('stands level with the rail beside it, whichever surface owns the rail', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    // jsdom lays nothing out, so the rail gets its box by hand: its top 90px, under the top bar
    const placed = (el: HTMLElement | null) => { if (el) vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(1072, 90, 92, 494)) }
    for (const hook of ['tool-rail', 'wb-tools']) {
      const { container } = render(<><aside className={`vrail rail ${hook}`} ref={placed} /><ToolDock groups={lineDock()} /></>)
      expect(container.querySelector<HTMLElement>('.wb-dock')!.style.top).toBe('90px')
      cleanup()
    }
    vi.unstubAllGlobals()
  })

  // Üben feedback 27.11.2026: a standing Meldeleiste lay on the column's first tile – the lane ends
  // left of the column by its width (08-toasts), so the column says how wide it is while it stands
  it('tells the message lane how wide the column beside the rail is, and takes it back', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(92)
    const root = document.documentElement.style
    const { unmount } = render(<><aside className="vrail rail tool-rail" /><ToolDock groups={lineDock()} /></>)
    expect(root.getPropertyValue('--dock-w')).toBe('92px')
    unmount()
    expect(root.getPropertyValue('--dock-w')).toBe('')
    // the phone's dock is a bottom bar, nowhere near the lane
    vi.mocked(useIsPhone).mockReturnValue(true)
    render(<><aside className="vrail rail tool-rail" /><ToolDock groups={lineDock()} /></>)
    expect(root.getPropertyValue('--dock-w')).toBe('')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
})
