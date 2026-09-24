// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// /admin › Lage-Grundgerüst writes through the SAME full-document PUT as every other Station page.
// What this pins: the first edit of a preset list turns it into the station's own (the rest of
// the preset untouched), a half-made row never reaches the document, «Auf Preset zurücksetzen»
// drops the station's list, reorder writes the new order — and the served presets are never sent
// back.

const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))
vi.mock('../lib/useSymbols', () => ({
  useSymbols: () => ({
    ready: true, error: false, reload: () => {}, order: ['Führung'],
    symbols: [{ cat: 'Führung', name: 'VKF KP Front', svg: '<svg></svg>' }, { cat: 'Führung', name: 'FW Sammelplatz', svg: '<svg></svg>' }],
    byName: { 'VKF KP Front': '<svg></svg>', 'FW Sammelplatz': '<svg></svg>' },
  }),
}))

import { ConfigProvider } from './ConfigContext'
import { LageGrundgeruestSection } from './LageGrundgeruestSection'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.lageGrundgeruest
const KP = { id: 'kp', label: 'KP · Einsatzleitung', symbol: 'VKF KP Front', vorschlag: { wind: 'auf', m: 40 } }
const ZUFAHRT = { id: 'zufahrt', label: 'Zufahrt', linie: 'Zufahrt' }
const SAMMEL = { id: 'sammel', label: 'Sammelplatz', symbol: 'FW Sammelplatz' }
const PRESETS = {
  'fks-standard': { beschreibung: 'Brand · BMA', kategorien: { brandbekaempfung: [KP, ZUFAHRT, SAMMEL], bma_unechte_alarme: [KP] } },
  minimal: { beschreibung: 'KP · Zufahrt · Sammelplatz', kategorien: { brandbekaempfung: [KP, SAMMEL] } },
}

const sent = () => apiPut.mock.calls[apiPut.mock.calls.length - 1]?.[1] as Record<string, unknown> & {
  lageGrundgeruest?: { preset?: string; kategorien?: Record<string, unknown[]> }
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })

function serve(block: unknown) {
  apiGet.mockReset().mockResolvedValue({ lageGrundgeruest: block, lageGrundgeruestPresets: PRESETS, version: 'v1' })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  serve({ preset: 'fks-standard', kategorien: {} })
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup() {
  await act(async () => { render(<ConfigProvider><LageGrundgeruestSection /></ConfigProvider>) })
  await waitFor(() => expect(document.querySelectorAll('.adm-rec').length).toBe(3))
}

describe('Lage-Grundgerüst — what reaches the config document', () => {
  it('shows the preset\'s list and says nothing is adapted', async () => {
    await setup()
    expect(screen.getAllByText('Preset: fks-standard · keine Einsatzart angepasst').length).toBeGreaterThan(0)
    expect(screen.getByText(/Aus dem Preset «fks-standard»/)).toBeTruthy()
  })

  it('the first edit makes the list the station\'s own — and never sends the presets back', async () => {
    await setup()
    await act(async () => { screen.getAllByLabelText(C.edit)[2].click() })
    const label = screen.getByDisplayValue('Sammelplatz')
    await act(async () => { fireEvent.change(label, { target: { value: 'Sammelplatz Nord' } }) })
    await settle()
    expect(sent().lageGrundgeruest?.kategorien).toEqual({
      brandbekaempfung: [KP, ZUFAHRT, { ...SAMMEL, label: 'Sammelplatz Nord' }],
    })
    expect(sent()).not.toHaveProperty('lageGrundgeruestPresets')
    expect(screen.getAllByText('Preset: fks-standard · 1 Einsatzart angepasst').length).toBeGreaterThan(0)
  })

  it('a new element is not written until it names something to place', async () => {
    await setup()
    await act(async () => { screen.getByText(C.add).click() })
    await settle()
    expect(screen.getByText(C.incomplete)).toBeTruthy()
    // the station list exists now (the edit adopted it), but without the half-made row
    expect(sent()?.lageGrundgeruest?.kategorien?.brandbekaempfung).toEqual([KP, ZUFAHRT, SAMMEL])
  })

  it('reorders by writing the new order', async () => {
    await setup()
    await act(async () => { screen.getAllByLabelText(C.down)[0].click() })
    await settle()
    expect((sent().lageGrundgeruest?.kategorien?.brandbekaempfung as { id: string }[]).map((s) => s.id)).toEqual(['zufahrt', 'kp', 'sammel'])
  })

  it('«Auf Preset zurücksetzen» drops the station\'s list for that Einsatzart only', async () => {
    serve({ preset: 'fks-standard', kategorien: { brandbekaempfung: [SAMMEL], bma_unechte_alarme: [SAMMEL] } })
    await act(async () => { render(<ConfigProvider><LageGrundgeruestSection /></ConfigProvider>) })
    await waitFor(() => expect(document.querySelectorAll('.adm-rec').length).toBe(1))
    await act(async () => { screen.getByText(C.reset).click() })
    await act(async () => { screen.getByText(appConfig.copy.admin.common.confirmYes).click() })
    await settle()
    expect(sent().lageGrundgeruest?.kategorien).toEqual({ bma_unechte_alarme: [SAMMEL] })
  })

  it('switches the preset', async () => {
    await setup()
    await act(async () => { screen.getByLabelText(C.presetLabel).click() })
    await act(async () => { screen.getByRole('option', { name: /^minimal/ }).click() })
    await settle()
    expect(sent().lageGrundgeruest?.preset).toBe('minimal')
  })
})
