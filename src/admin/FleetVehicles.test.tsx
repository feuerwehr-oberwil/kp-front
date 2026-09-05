// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The vehicle list is what «Einrichtung» sends a fresh station here for, and it is written through
// the SAME full-document PUT as every other Station page. So what this file pins is the one rule
// that keeps that safe: a row the backend would refuse (`id`/`label` are min_length=1, and a
// duplicate id would silently merge two vehicles) never reaches the config document — because one
// invalid row 422s every other Station page too, in a 700 ms autosave retry loop.

const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))
// the symbol viewer under the editor fetches the symbol library — not what this is about
vi.mock('./FleetAttributesViewer', () => ({ FleetAttributesViewer: () => null }))

import { ConfigProvider } from './ConfigContext'
import { FleetSection } from './ConfigSections'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.fleet
const STORED = { id: 'tlf-1', label: 'TLF Talheim 1', winfapAlias: 'TLF' }

/** The vehicles in the most recent PUT body. */
const sentVehicles = () => {
  const calls = apiPut.mock.calls
  const last = calls[calls.length - 1]
  return (last?.[1] as { fleet?: { vehicles?: unknown[] } })?.fleet?.vehicles
}

const rowInputs = (i: number) =>
  document.querySelectorAll('.adm-formlink')[i].querySelectorAll('input')

/** Let the 700 ms autosave debounce elapse. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue({ fleet: { vehicles: [STORED] }, version: 'v1' })
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup() {
  await act(async () => { render(<ConfigProvider><FleetSection /></ConfigProvider>) })
  await waitFor(() => expect(document.querySelectorAll('.adm-formlink').length).toBe(1))
}

describe('Fahrzeuge — what reaches the config document', () => {
  it('never sends the empty row «Fahrzeug hinzufügen» has to create', async () => {
    await setup()
    await act(async () => { screen.getByText(C.vehicleAdd).click() })
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.vehicleIncomplete)).toBeTruthy()
  })

  it('stores the row once it is complete — and keeps the CLI-written winfapAlias of the others', async () => {
    await setup()
    await act(async () => { screen.getByText(C.vehicleAdd).click() })
    await act(async () => { fireEvent.change(rowInputs(1)[0], { target: { value: 'ADL Talheim 5' } }) })
    await settle()
    expect(sentVehicles()).toEqual([
      STORED,
      // the Kennung follows the Bezeichnung until it is edited by hand
      { id: 'adl-talheim-5', label: 'ADL Talheim 5' },
    ])
  })

  it('refuses a duplicate Kennung rather than merging two vehicles into one', async () => {
    await setup()
    await act(async () => { screen.getByText(C.vehicleAdd).click() })
    await act(async () => { fireEvent.change(rowInputs(1)[0], { target: { value: 'Zweites TLF' } }) })
    await act(async () => { fireEvent.change(rowInputs(1)[1], { target: { value: 'tlf-1' } }) })
    await settle()
    // nothing is written at all: the stored list is unchanged, so there is not even a PUT
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.vehicleDuplicate)).toBeTruthy()
  })

  // Two taps, not one: the bin arms and names the consequence first (ui · ConfirmButton).
  // A vehicle is a row of the Ausrückzeiten grid and the key a milestone webhook reports
  // against, and the page autosaves 700 ms later — there is no undo on the page itself.
  it('removes a vehicle only after the confirm', async () => {
    await setup()
    await act(async () => { screen.getByLabelText(C.vehicleRemove).click() })
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.vehicleRemoveConfirm)).toBeTruthy()

    await act(async () => { screen.getByText(appConfig.copy.admin.common.confirmYes).click() })
    await settle()
    expect(sentVehicles()).toEqual([])
  })
})
