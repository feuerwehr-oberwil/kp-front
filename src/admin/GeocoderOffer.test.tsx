// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Adresssuche's search area, and the one moment in which everything needed to fill it in is
// already known: the map centre is stored, the bbox is not, and ±5 km around that centre is one
// subtraction away. Until now that derivation sat behind a button two cards below the fold that
// a station only found if it went looking — so the address search stayed country-wide, and
// «Hauptstrasse 3» came back from a village three cantons away during an Einsatz.
//
// What this file pins: the offer appears only in that exact state, it shows the value it would
// write BEFORE writing it, one tap stores it, and it never nags — «Nicht jetzt» and an existing
// bbox both silence it.

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
import { MapSection } from './ConfigSections'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.map

/** A station whose centre is stored and whose Adresssuche is still empty. */
const CENTRED = {
  map: { defaultView: { center: [7.5547, 47.5072], zoom: 14 }, geocoder: { defaultLocality: null, bboxLv95: null } },
  version: 'v1',
}
/** The real ±5 km LV95 box around that centre — the value the offer promises. */
const DERIVED = '2603745,1256834,2613745,1266834'

const offer = () => screen.queryByText(C.bboxOfferTitle)
/** The Suchbereich input — third card, second field. */
const bboxBox = () =>
  document.querySelectorAll<HTMLElement>('.adm-card')[1].querySelectorAll<HTMLInputElement>('input')[1]

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup(cfg: unknown = CENTRED) {
  apiGet.mockReset().mockResolvedValue(cfg)
  render(<ConfigProvider><MapSection /></ConfigProvider>)
  await waitFor(() => expect(document.querySelectorAll('.adm-card').length).toBeGreaterThan(1))
}

describe('Suchbereich — das Angebot im richtigen Moment', () => {
  it('shows the derived box before writing it, and stores exactly that on one tap', async () => {
    await setup()
    expect(offer()).toBeTruthy()
    // the value that WOULD be written is on screen — an offer nobody can read is a dice roll
    expect(screen.getByText(DERIVED)).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: C.bboxOfferApply })) })
    expect(bboxBox().value).toBe(DERIVED)
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    const last = apiPut.mock.calls[apiPut.mock.calls.length - 1]
    expect((last?.[1] as { map?: { geocoder?: { bboxLv95?: string } } })?.map?.geocoder?.bboxLv95).toBe(DERIVED)
    // …and having been taken, it is gone
    expect(offer()).toBeNull()
  })

  it('goes away for this visit on «Nicht jetzt» — and writes nothing', async () => {
    await setup()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: C.bboxOfferDismiss })) })
    expect(offer()).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(apiPut).not.toHaveBeenCalled()
    // the button that does the same job stays where it was — dismissing hides the offer, not the way
    expect(screen.getByRole('button', { name: C.bboxFromCenter })).toBeTruthy()
  })

  it('never appears where there is nothing to derive from, or nothing left to offer', async () => {
    await setup({ map: { defaultView: { center: null, centerLv95: null } }, version: 'v1' })
    expect(offer()).toBeNull()

    cleanup()
    await setup({ ...CENTRED, map: { ...CENTRED.map, geocoder: { bboxLv95: '2600000,1200000,2610000,1210000' } } })
    expect(offer()).toBeNull()
  })

  // An LV95 station never types a WGS84 coordinate, and the derivation has to work from the form
  // the document is actually in — otherwise the offer is missing for exactly the Swiss default.
  it('derives from an LV95 centre too', async () => {
    await setup({ map: { defaultView: { centerLv95: [2608745, 1261834], zoom: 14 } }, version: 'v1' })
    expect(offer()).toBeTruthy()
    const box = document.querySelector('.adm-offer-preview')?.textContent ?? ''
    const [minE, minN, maxE, maxN] = box.split(',').map(Number)
    // ±5 km around the stored centre — the round trip through WGS84 costs a metre, not a village
    expect((minE + maxE) / 2).toBeCloseTo(2_608_745, -1)
    expect((minN + maxN) / 2).toBeCloseTo(1_261_834, -1)
    expect(maxE - minE).toBe(10_000)
    expect(maxN - minN).toBe(10_000)
  })
})
