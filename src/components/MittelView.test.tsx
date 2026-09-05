// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import type { MittelEntry } from '../types'
import type { MittelDraft } from './MittelView'

// MittelView reads the deployment catalogue through the getDeploymentConfig() singleton — mock
// just that accessor so each test can put its own catalogue/sources under the component.
const cfg: { current: DeploymentConfig } = { current: {} }
vi.mock('../lib/deploymentConfig', async () => {
  const actual = await vi.importActual<typeof import('../lib/deploymentConfig')>('../lib/deploymentConfig')
  return { ...actual, getDeploymentConfig: () => cfg.current }
})
const { MittelView } = await import('./MittelView')

afterEach(cleanup)
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
beforeEach(() => { cfg.current = {} })

const M = appConfig.copy.mittel
const sources = [{ id: 'tlf', label: 'TLF Oberwil' }, { id: 'mag', label: 'Magazin' }]
// one stocked source, one candidate → fully unambiguous
const tauchpumpe = { id: 'tp', label: 'Tauchpumpe', symbol: 'FW Tauchpumpe', stock: [{ source: 'tlf', qty: 1 }] }
// one candidate, TWO stocked sources → the «booked from where?» question
const oelbinder = { id: 'oel', label: 'Ölbinder', symbol: 'FW Oelbinder', stock: [{ source: 'tlf', qty: 2 }, { source: 'mag', qty: 10 }] }
// TWO cells, but only ONE Fahrzeug actually carries it → a multi-source row with no question
const schaum = { id: 'sm', label: 'Schaummittel', stock: [{ source: 'tlf', qty: 0 }, { source: 'mag', qty: 4 }] }

const mount = (over: Partial<Parameters<typeof MittelView>[0]> = {}) => {
  const onSave = vi.fn<(d: MittelDraft) => void>()
  render(<MittelView entries={[]} canEdit onSave={onSave} {...over} />)
  return onSave
}

/** MittelView is CONTROLLED: it reports a new running total and gets its entries back as props.
 *  «One tap, not two» is a statement about exactly that round trip, so the compact-row tests
 *  drive the real one instead of a vi.fn() that swallows the write. */
function Live({ initial = [], saves }: { initial?: MittelEntry[]; saves: MittelDraft[] }) {
  const [entries, setEntries] = useState<MittelEntry[]>(initial)
  return (
    <MittelView
      entries={entries} canEdit
      onSave={(d) => {
        saves.push(d)
        setEntries((cur) => [...cur, {
          id: `e${cur.length + 1}`, materialId: d.materialId, label: d.label, unit: d.unit,
          sourceId: d.sourceId, sourceLabel: d.sourceLabel, menge: d.menge,
          at: new Date(Date.now() + cur.length).toISOString(),
        }])
      }}
    />
  )
}

describe('«In Verwendung» — the tick filter stays put while active', () => {
  it('never unmounts on click, so it can always be toggled back off', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const onSave = mount({
      entries: [{ id: 'e1', materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1, at: new Date().toISOString() }],
    })
    const btn = screen.getByRole('button', { name: M.viewBySource }) as HTMLButtonElement
    expect(btn.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(btn)
    // same node, now pressed — the control is not conditionally rendered on `view`
    expect(screen.getByRole('button', { name: M.viewBySource })).toBe(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(btn)
    expect(screen.getByRole('button', { name: M.viewBySource })).toBe(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('kompakte Ruhezeile — eine unberührte Position trägt nur ein «+»', () => {
  const addOne = (label: string) => fillTemplate(M.addOne, { label })
  const pickSource = (label: string) => fillTemplate(M.addPickSource, { label })
  /** the ±stepper of a row, by the aria-label MittelView gives it */
  const stepper = (name: string) => screen.queryByRole('group', { name })

  it('shows the «+» instead of the ±stepper while nothing is used', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    mount()
    expect(screen.getByRole('button', { name: addOne('Tauchpumpe') })).toBeTruthy()
    expect(stepper('Tauchpumpe Stk.')).toBeNull()
  })

  it('books 1 AND expands the row on the FIRST tap — one tap, not two', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const saves: MittelDraft[] = []
    render(<Live saves={saves} />)

    fireEvent.click(screen.getByRole('button', { name: addOne('Tauchpumpe') }))

    expect(saves).toEqual([{
      materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1,
    }])
    // the very same tap left the full form standing — «noch eine» lands on the ±stepper
    expect(stepper('Tauchpumpe Stk.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: addOne('Tauchpumpe') })).toBeNull()
  })

  it('keeps the stepper when the count is taken back to 0 — nothing is yanked from under the finger', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const saves: MittelDraft[] = []
    render(<Live saves={saves} />)

    fireEvent.click(screen.getByRole('button', { name: addOne('Tauchpumpe') }))
    // the ±buttons step on pointerdown (press-and-hold repeats — lib/useHoldRepeat), not on click
    fireEvent.pointerDown(screen.getByRole('button', { name: appConfig.copy.stepper.less }), { button: 0 })
    fireEvent.pointerUp(window)

    expect(saves.map((d) => d.menge)).toEqual([1, 0])
    expect(stepper('Tauchpumpe Stk.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: addOne('Tauchpumpe') })).toBeNull()
  })

  it('leaves a row that already carries a count in today\'s full form', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    mount({
      entries: [{ id: 'e1', materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1, at: new Date().toISOString() }],
    })
    expect(stepper('Tauchpumpe Stk.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: addOne('Tauchpumpe') })).toBeNull()
  })

  it('opens the sources instead of guessing when several Fahrzeuge carry the material', () => {
    cfg.current = { mittel: { catalogue: [oelbinder], sources } }
    const onSave = mount()

    fireEvent.click(screen.getByRole('button', { name: pickSource('Ölbinder') }))

    expect(onSave).not.toHaveBeenCalled()
    expect(stepper('Ölbinder · TLF Oberwil')).toBeTruthy()
    expect(stepper('Ölbinder · Magazin')).toBeTruthy()
  })

  it('books onto the one Fahrzeug that carries it when only one does', () => {
    cfg.current = { mittel: { catalogue: [schaum], sources } }
    const onSave = mount()

    fireEvent.click(screen.getByRole('button', { name: addOne('Schaummittel') }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith({
      materialId: 'sm', label: 'Schaummittel', unit: 'Stk.', sourceId: 'mag', sourceLabel: 'Magazin', menge: 1,
    })
  })
})

describe('«Gesetzt, aber nicht erfasst» — unambiguous vs. ambiguous', () => {
  it('books a fully unambiguous set with today\'s one-tap «Übernehmen», no sheet', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const onSave = mount({ placedSymbols: [{ symbol: 'FW Tauchpumpe' }] })

    fireEvent.click(screen.getByRole('button', { name: M.lageStripTake }))

    expect(screen.queryByText(M.lagePickTitle)).toBeNull()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith({
      materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1,
    })
  })

  it('reads «Erfassen …» when anything is ambiguous and opens the picker sheet instead of booking', () => {
    cfg.current = { mittel: { catalogue: [oelbinder], sources } }
    const onSave = mount({ placedSymbols: [{ symbol: 'FW Oelbinder' }] })

    expect(screen.queryByRole('button', { name: M.lageStripTake })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: M.lageStripCapture }))

    expect(screen.getByText(M.lagePickTitle)).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
    // the footer counts the open question and stays disabled until it is answered
    const foot = screen.getByRole('button', { name: M.lagePickOpenOne })
    expect((foot as HTMLButtonElement).disabled).toBe(true)
  })

  it('books the per-item source pick through onSave, and the unambiguous rest with it', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe, oelbinder], sources } }
    const onSave = mount({ placedSymbols: [{ symbol: 'FW Oelbinder' }, { symbol: 'FW Tauchpumpe' }] })

    fireEvent.click(screen.getByRole('button', { name: M.lageStripCapture }))
    // the Ölbinder group offers both stocked sources; pick the NON-default one (Magazin)
    fireEvent.click(screen.getByRole('radio', { name: /Magazin/ }))

    // answered → the footer now counts what one tap books
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(M.lagePickConfirm, { n: 2 }) }))

    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave.mock.calls.map(([d]) => d)).toEqual(expect.arrayContaining([
      { materialId: 'oel', label: 'Ölbinder', unit: 'Stk.', sourceId: 'mag', sourceLabel: 'Magazin', menge: 1 },
      { materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1 },
    ]))
    // booking everything closes the sheet
    expect(screen.queryByText(M.lagePickTitle)).toBeNull()
  })
})
