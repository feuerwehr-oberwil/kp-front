// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'

// ⚠️ The decision this file pins (owner, 28.09.2026): a yes/no is ONE control app-wide — the
// `OnOff` pair, «Aus» left and «An» right. The Einstellungen built their own pairs with «on» on
// the LEFT («Ein | Aus», «Erlaubt | Aus», «Automatisch | Nur manuell»), and the Übung was a
// tick-box chip. Same thumb position, opposite answer, depending on the sheet.

vi.mock('../../lib/incidents', () => ({
  createIncident: vi.fn(), patchIncident: vi.fn(),
  getIncident: vi.fn(() => Promise.resolve({ text: '' })),
  listObjects: vi.fn(() => Promise.resolve([])),
  listPersonnel: vi.fn(() => Promise.resolve([])),
  geocodeSearch: vi.fn(() => Promise.resolve([])),
  geocodeReverse: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../MapPicker', () => ({ MapPicker: () => null }))
vi.mock('./_shared', async (orig) => ({
  ...(await orig<typeof import('./_shared')>()),
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const { EinsatzWizard } = await import('./EinsatzWizard')
const { SettingsSheet } = await import('./SettingsSheet')

const D = appConfig.copy.drawingEditor
afterEach(cleanup)

/** the pair's two answers, in screen order, and which one is pressed */
const pair = (label: string) => {
  const group = screen.getByRole('group', { name: label })
  const btns = within(group).getAllByRole('button')
  return { words: btns.map((b) => b.textContent), pressed: btns.map((b) => b.getAttribute('aria-pressed')), btns }
}

describe('Übung on the Einsatz form', () => {
  const ix = appConfig.copy.intake

  it('answers «Übung?» with Nein | Ja on a phone, keeping the false answer first', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
    try {
      render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
      expect(pair(ix.exerciseLabel).words).toEqual([ix.exerciseNo, ix.exerciseYes])
      fireEvent.click(pair(ix.exerciseLabel).btns[1])
      expect(pair(ix.exerciseLabel).pressed).toEqual(['false', 'true'])
    } finally { vi.unstubAllGlobals() }
  })

  it('is the Aus | An pair, off for a fresh Einsatz', () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    const p = pair(ix.exerciseLabel)
    expect(p.words).toEqual([D.off, D.on])
    expect(p.pressed).toEqual(['true', 'false'])
  })

  it('turns on with «An», and the words never change', () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    fireEvent.click(pair(ix.exerciseLabel).btns[1])
    const p = pair(ix.exerciseLabel)
    expect(p.words).toEqual([D.off, D.on])
    expect(p.pressed).toEqual(['false', 'true'])
  })
})

describe('the Einstellungen yes/no rows', () => {
  const cp = appConfig.copy.settings
  const onKeepScreenOn = vi.fn(), onRailLabels = vi.fn()
  const mount = () => render(
    <SettingsSheet onClose={() => {}} symbolScale={{ map: 1, board: 1 }} onSymbolScale={() => {}}
      symbolCaptions="auto" onSymbolCaptions={() => {}} railLabels="off" onRailLabels={onRailLabels}
      offlineRadiusM={1000} onOfflineRadius={() => {}} offlineAuto onOfflineAuto={() => {}}
      keepScreenOn onKeepScreenOn={onKeepScreenOn} themeCoord={null} elView={false} onElView={() => {}}
      shareAs={null} onSharePosition={() => {}} />)

  it('all read «Aus | An», in that order', () => {
    mount()
    for (const label of [cp.railLabels, cp.offlineAuto, cp.keepScreenOn, cp.elView, appConfig.copy.sharePosition.settingsLabel]) {
      expect(pair(label).words, label).toEqual([D.off, D.on])
    }
    expect(pair(cp.keepScreenOn).pressed).toEqual(['false', 'true'])
    expect(pair(cp.railLabels).pressed).toEqual(['true', 'false'])
  })

  it('hand the caller the answer', () => {
    mount()
    fireEvent.click(pair(cp.keepScreenOn).btns[0])
    expect(onKeepScreenOn).toHaveBeenCalledWith(false)
    // the rail words keep their stored 'off' | 'short' names behind the pair
    fireEvent.click(pair(cp.railLabels).btns[1])
    expect(onRailLabels).toHaveBeenCalledWith('short')
  })
})
