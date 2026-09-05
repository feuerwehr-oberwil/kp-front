// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Rapport → Rundung: the two numbers that decide what the Gemeinde is billed, plus the merge gap
// that decides what the Personalblatt says a person's time was. All three are plain `int` on the
// backend — `stepMin` (ge=1, le=480), `graceMin` (ge=0, le=479), `attendanceMergeGapMin`
// (ge=0, le=240) — with NO null among them, and all three are always populated by the GET
// projection (schemas.py · ReportConfig / HoursRoundingConfig).
//
// They had no test, and they wrote `numOrNull(...)` straight into the draft. So backspacing «30»
// to type «60» — the ordinary way anyone changes a two-digit number — put `null` into a field
// that has no null, and that 422 stopped the 700 ms autosave for every Station page at once,
// including the four nobody was looking at. docs/CONFIGURATION.md now sends stations here to set
// these, so it is newly advertised ground.

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
import { ReportSection } from './ConfigSections'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { expectAccepted } from './configSchema.test-utils'

const R = appConfig.copy.admin.report
const N = appConfig.copy.admin.numbers

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })
const sent = () => apiPut.mock.calls[apiPut.mock.calls.length - 1]?.[1] as
  { report?: { hoursRounding?: Record<string, unknown>; attendanceMergeGapMin?: unknown } } | undefined
const type = (el: Element, value: string) => act(async () => { fireEvent.change(el, { target: { value } }) })
const range = (min: number, max: number) => fillTemplate(N.integerRange, { min, max })

/** A station as the API projects it — every default filled in, which is exactly what makes an
 *  emptied box a 422 rather than «no value». */
const STATION = {
  version: 'v1',
  identity: { appName: 'Feuerwehr Steintal' },
  report: {
    partnerOrgs: [], links: [], reversePrintOrder: true,
    hoursRounding: { stepMin: 30, graceMin: 5 },
    attendanceMergeGapMin: 15,
  },
}

/** stepMin, graceMin, attendanceMergeGapMin — in DOM order. */
const nums = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="number"]'))

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue(structuredClone(STATION))
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function open() {
  await act(async () => { render(<ConfigProvider><ReportSection /></ConfigProvider>) })
  await waitFor(() => expect(nums().length).toBe(3))
}

describe('Rundung — a station that counts whole hours sets it here', () => {
  it('stores the block size and the grace', async () => {
    await open()
    await type(nums()[0], '60')
    await type(nums()[1], '10')
    await settle()
    expect(sent()?.report?.hoursRounding).toEqual({ stepMin: 60, graceMin: 10 })
    expectAccepted(sent())
  })

  it('an EMPTIED box is not a null — it is held back, and the stored rule keeps applying', async () => {
    await open()
    await type(nums()[0], '')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(range(1, 480))).toBeTruthy()
  })

  it('survives the ordinary way a two-digit number is retyped: clear, then type', async () => {
    // ⚠️ The actual failure. Nobody selects «30» and overwrites it; they backspace it away first,
    // and until the new number is typed the box is empty. The debounce is 700 ms, so anyone who
    // pauses — to check the docs, to be interrupted, to think — autosaves that emptiness. Which
    // is why each step here waits: this is the real timing, not a burst of keystrokes.
    await open()
    await type(nums()[0], '3')
    await settle()
    await type(nums()[0], '')
    await settle()
    await type(nums()[0], '6')
    await settle()
    await type(nums()[0], '60')
    await settle()
    expect(sent()?.report?.hoursRounding?.stepMin).toBe(60)
    // EVERY document that went out along the way is one the API takes, not just the last
    for (const call of apiPut.mock.calls) expectAccepted(call[1])
  })

  it('refuses a block size past the API maximum — and the field beside it still saves', async () => {
    await open()
    await type(nums()[0], '999')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(range(1, 480))).toBeTruthy()

    await type(nums()[1], '10')
    await settle()
    expect(sent()?.report?.hoursRounding).toEqual({ stepMin: 30, graceMin: 10 }) // stored step, new grace
    expectAccepted(sent())
  })

  it('refuses a fraction: minutes are whole numbers on the backend', async () => {
    await open()
    await type(nums()[1], '7.5')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('refuses a negative grace, which the HTML min attribute alone never did', async () => {
    await open()
    await type(nums()[1], '-5')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(range(0, 479))).toBeTruthy()
  })

  it('keeps the worked example on the STORED rule while a typed one is refused', async () => {
    await open()
    const before = screen.getByText(new RegExp(R.example)).closest('.adm-field')?.textContent
    await type(nums()[0], '')
    await settle()
    expect(screen.getByText(new RegExp(R.example)).closest('.adm-field')?.textContent).toBe(before)
  })
})

describe('attendanceMergeGapMin — how short a break still counts as one stretch', () => {
  it('stores a whole number in range', async () => {
    await open()
    await type(nums()[2], '20')
    await settle()
    expect(sent()?.report?.attendanceMergeGapMin).toBe(20)
    expectAccepted(sent())
  })

  it('takes 0 — «print every block exactly as recorded» is a real setting', async () => {
    await open()
    await type(nums()[2], '0')
    await settle()
    expect(sent()?.report?.attendanceMergeGapMin).toBe(0)
    expectAccepted(sent())
  })

  it('holds back an emptied box and a value past the API maximum', async () => {
    await open()
    await type(nums()[2], '')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(range(0, 240))).toBeTruthy()

    await type(nums()[2], '600')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
  })
})
