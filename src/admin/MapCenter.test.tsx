// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Startansicht der Lagekarte, and the one rule that keeps it from taking the rest of the
// config down with it: the centre is ONE value — `[lng, lat]` (schemas.py · MapDefaultView) —
// typed into two boxes, and Verwaltung PUTs the WHOLE document.
//
// What this file pins is the two halves of a real setup failure:
//   · the pair must leave as a LIST, not as an object keyed by index. Writing the boxes as two
//     paths (`center.0`, `center.1`) built `{"0": 8.1148}`, which the API refuses — and that one
//     422 also refused the App-Name, Markenfarbe and Kommandant typed on the same page.
//   · half a pair must not reach the document at all, however long the second box stays empty.

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

/** lon / lat / zoom, in DOM order — of the FIRST card only. MapSection also renders the
 *  Adresssuche and the Kartenportale below it, and their inputs are not this pair. */
const boxes = () =>
  Array.from(document.querySelectorAll<HTMLElement>('.adm-card')[0]?.querySelectorAll<HTMLInputElement>('input') ?? [])
const type = (i: number, value: string) => act(async () => { fireEvent.change(boxes()[i], { target: { value } }) })

/** `map.defaultView` of the most recent PUT body. */
const sentView = () => {
  const last = apiPut.mock.calls[apiPut.mock.calls.length - 1]
  return (last?.[1] as { map?: { defaultView?: { center?: unknown; centerLv95?: unknown; zoom?: unknown } } })?.map?.defaultView
}

/** Let the 700 ms autosave debounce elapse. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })

/** A fresh station: nothing configured yet, which is the state the bug needs. */
const EMPTY = { map: { defaultView: { center: null, centerLv95: null, zoom: null } }, version: 'v1' }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue(EMPTY)
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup(cfg: unknown = EMPTY) {
  apiGet.mockResolvedValue(cfg)
  render(<ConfigProvider><MapSection /></ConfigProvider>)
  await waitFor(() => expect(boxes().length).toBe(3))
}

describe('Kartenzentrum — one value in two boxes', () => {
  it('stores the pair as a [lng, lat] LIST carrying BOTH coordinates', async () => {
    await setup()
    await type(0, '8.1148')
    await type(1, '47.1723')
    await settle()
    const center = sentView()?.center
    expect(Array.isArray(center)).toBe(true)
    expect(center).toEqual([8.1148, 47.1723])
  })

  it('sends nothing while only one half is filled in — and says so on screen', async () => {
    await setup()
    await type(0, '8.1148')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.centerIncomplete)).toBeTruthy()
    // …and the moment the pair is complete it goes, without the operator doing anything else
    await type(1, '47.1723')
    await settle()
    expect(sentView()?.center).toEqual([8.1148, 47.1723])
    expect(screen.queryByText(C.centerIncomplete)).toBeNull()
  })

  it('keeps the stored centre while an edit of it is half-finished', async () => {
    await setup({ map: { defaultView: { center: [8.1148, 47.1723], zoom: 14 } }, version: 'v1' })
    await type(1, '') // clearing the latitude alone is not «remove the centre»
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.centerIncomplete)).toBeTruthy()
  })

  it('refuses a coordinate outside the world rather than storing it', async () => {
    await setup()
    await type(0, '8.1148')
    await type(1, '471.723') // a mistyped latitude
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.centerOutOfRange)).toBeTruthy()
  })

  it('clearing both boxes removes the centre — the zoom is independent of it', async () => {
    await setup({ map: { defaultView: { center: [8.1148, 47.1723], zoom: 14 } }, version: 'v1' })
    await type(0, '')
    await type(1, '')
    await settle()
    expect(sentView()?.center).toBeNull()
    expect(sentView()?.zoom).toBe(14)
  })
})

// The other half of the same value: a Swiss station's own coordinates are LV95, and the form
// only ever offered WGS84. `center` and `centerLv95` are MUTUALLY EXCLUSIVE on the backend
// (schemas.py · MapDefaultView._one_crs), so a document carrying both is refused — and since
// Verwaltung PUTs the whole document, that would wedge every other Station page. Hence one
// control with a form switch, and these tests exist to keep it one.

/** Choose an option of the (non-native) CRS listbox by its label. */
const pickCrs = async (label: string) => {
  await act(async () => { fireEvent.click(screen.getByLabelText(C.pickCrs)) })
  await act(async () => { fireEvent.mouseDown(screen.getByText(label)) })
}

describe('Kartenzentrum — WGS84 oder LV95, nie beides', () => {
  it('stores an LV95 pair as centerLv95 and NULLs the WGS84 one in the same edit', async () => {
    await setup()
    await pickCrs(C.crsLv95)
    await type(0, '2611500')
    await type(1, '1258300')
    await settle()
    expect(sentView()?.centerLv95).toEqual([2611500, 1258300])
    expect(sentView()?.center).toBeNull()
  })

  it('converts what is already typed when the form is switched — and stores only the new one', async () => {
    await setup({ map: { defaultView: { center: [7.438632495, 46.951082563], zoom: 14 } }, version: 'v1' })
    await pickCrs(C.crsLv95)
    await settle()
    // swisstopo's own reference point: the Bern observatory IS the LV95 origin
    const lv95 = sentView()?.centerLv95 as [number, number]
    expect(lv95[0]).toBeCloseTo(2_600_000, 0)
    expect(lv95[1]).toBeCloseTo(1_200_000, 0)
    expect(sentView()?.center).toBeNull()
  })

  it('shows an LV95-shaped centre in LV95 without being told', async () => {
    await setup({ map: { defaultView: { centerLv95: [2611500, 1258300], zoom: 14 } }, version: 'v1' })
    expect(boxes()[0].value).toBe('2611500')
    expect(boxes()[1].value).toBe('1258300')
  })

  it('refuses an LV03 pair (600 000 / 200 000) rather than putting the Lage in the Atlantic', async () => {
    await setup()
    await pickCrs(C.crsLv95)
    await type(0, '611500')
    await type(1, '258300')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.centerLv95OutOfRange)).toBeTruthy()
  })
})
