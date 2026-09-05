// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Verwaltung › Station › Material. The Mittel catalogue used to be reachable from nowhere in
// /admin: it is empty on a fresh instance, it is written only by a spreadsheet, and the only
// clue it exists at all was a sheet name inside a file nobody had downloaded. A station could
// run for a year with «kein Material» on every Rapport and never learn why.
//
// The rule this file pins is the one that keeps that entry honest: this page SHOWS the
// catalogue and never writes it. `mittel.*` has exactly one writer — the Arbeitsmappe, which
// parses server-side and previews the impact first — so the only action here is the way there.

const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))

import { ConfigProvider } from './ConfigContext'
import { MaterialView } from './MaterialView'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.material

const STOCKED = {
  mittel: {
    catalogue: [
      { id: 'luefter', label: 'Lüfter', unit: 'Stk', category: 'Geräte', stock: [{ source: 'tlf', qty: 2 }] },
      { id: 'bindemittel', label: 'Bindemittel', unit: 'Sack', verbrauchbar: true },
    ],
    sources: [{ id: 'tlf', label: 'TLF 31' }],
    units: ['Stk', 'l'],
  },
  version: 'v1',
}

beforeEach(() => { apiPut.mockReset() })
afterEach(cleanup)

async function setup(cfg: unknown) {
  apiGet.mockReset().mockResolvedValue(cfg)
  const onNavigate = vi.fn()
  await act(async () => { render(<ConfigProvider><MaterialView onNavigate={onNavigate} /></ConfigProvider>) })
  await waitFor(() => expect(document.querySelectorAll('.adm-card').length).toBe(3))
  return onNavigate
}

describe('Material — der Katalog, sichtbar statt unsichtbar', () => {
  it('lists the catalogue with the source names its stock rows point at', async () => {
    await setup(STOCKED)
    expect(screen.getByText('Lüfter')).toBeTruthy()
    // the stock row names its source, not the id an operator has never seen
    expect(screen.getByText('TLF 31: 2')).toBeTruthy()
    expect(screen.getByText(C.stockNone)).toBeTruthy()
    // consumable vs equipment is the difference between a Nachschub line and a Retablierung line
    expect(screen.getByText(C.kindConsumable)).toBeTruthy()
    expect(screen.getByText(C.kindEquipment)).toBeTruthy()
  })

  // The state a fresh station is actually in — and the one this entry exists for.
  it('says what an empty catalogue costs, and offers the one surface that fills it', async () => {
    const onNavigate = await setup({ mittel: {}, version: 'v1' })
    expect(screen.getByText(C.empty)).toBeTruthy()
    expect(screen.getByText(C.emptyHint)).toBeTruthy()
    expect(screen.getByText(C.sourcesEmpty)).toBeTruthy()
    expect(screen.getByText(C.unitsEmpty)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: C.openWorkbook }))
    expect(onNavigate).toHaveBeenCalledWith('arbeitsmappe')
  })

  // ⚠️ A second writer into `mittel.*` would be a full-document config write without the
  // Arbeitsmappe's server-side preview. This page must never grow one.
  it('writes nothing — there is no input on it at all', async () => {
    await setup(STOCKED)
    expect(document.querySelectorAll('input, textarea').length).toBe(0)
    expect(apiPut).not.toHaveBeenCalled()
  })

  // A hand-edited document (admin_config CLI) must not white-screen the page that shows it.
  it('survives a catalogue that is not a list', async () => {
    await setup({ mittel: { catalogue: {}, sources: null, units: 'Stk' }, version: 'v1' })
    expect(screen.getByText(C.empty)).toBeTruthy()
  })
})
