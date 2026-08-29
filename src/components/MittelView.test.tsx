// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { DeploymentConfig } from '../lib/deploymentConfig'
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

const mount = (over: Partial<Parameters<typeof MittelView>[0]> = {}) => {
  const onSave = vi.fn<(d: MittelDraft) => void>()
  render(<MittelView entries={[]} canEdit onSave={onSave} {...over} />)
  return onSave
}

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
