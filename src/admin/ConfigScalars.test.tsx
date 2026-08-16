// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The scalars and paste-a-value fields that had no browser form at all: the Hilfe intro, the two
// geocoder settings, the printer switch, the three incident clocks and the webhooks.
//
// Every one of them sits on a page that PUTs the WHOLE config document with a 700 ms autosave, so
// the rule they all follow is the one FleetVehiclesEditor and the map centre already follow: an
// incomplete or out-of-range value stays in LOCAL state with a German warning and never enters the
// draft. What these tests pin is that rule — a refused value must leave its siblings saveable.

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
import { AlarmsSection, IdentitySection, MapSection, ReportSection } from './ConfigSections'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

const M = appConfig.copy.admin.map
const A = appConfig.copy.admin.alarms
const R = appConfig.copy.admin.report
const I = appConfig.copy.admin.identity

/** Let the 700 ms autosave debounce elapse. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })
/** The most recent PUT body. */
const sent = () => apiPut.mock.calls[apiPut.mock.calls.length - 1]?.[1] as Record<string, any> | undefined
const type = (el: Element, value: string) => act(async () => { fireEvent.change(el, { target: { value } }) })

/** A station as the API projects it: every default filled in, which is what makes an EMPTIED
 *  number field a 422 rather than a null (schemas.py · AlarmsConfig has no optional int). */
const STATION = {
  version: 'v1',
  identity: { appName: 'Feuerwehr Musterdorf', helpIntro: null },
  map: { defaultView: { center: [7.5547, 47.5072], zoom: 14 }, geocoder: { defaultLocality: null, bboxLv95: null }, externalLinks: [] },
  report: { reversePrintOrder: true, links: [], partnerOrgs: [] },
  alarms: { autoArchiveDays: 7, staleIncidentDays: 30, captureWindowHours: 12, webhooks: [] },
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue(structuredClone(STATION))
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup(node: React.ReactNode, ready: () => unknown) {
  render(<ConfigProvider>{node}</ConfigProvider>)
  await waitFor(() => expect(ready()).toBeTruthy())
}

describe('identity.helpIntro — the paragraph every new AdF reads', () => {
  it('stores what is typed, and clearing it goes back to the shipped text (null, not "")', async () => {
    await setup(<IdentitySection />, () => screen.getByPlaceholderText(appConfig.copy.help.introFallback))
    const box = screen.getByPlaceholderText(appConfig.copy.help.introFallback)
    await type(box, 'Die digitale Einsatzführung der Feuerwehr Musterdorf.')
    await settle()
    expect(sent()?.identity.helpIntro).toBe('Die digitale Einsatzführung der Feuerwehr Musterdorf.')
    await type(box, '')
    await settle()
    expect(sent()?.identity.helpIntro).toBeNull()
  })

  it('is labelled as its own field, not folded into the Kommandant row', async () => {
    await setup(<IdentitySection />, () => screen.getByText(I.helpIntro))
    expect(screen.getByText(I.helpIntro)).toBeTruthy()
  })
})

describe('map.geocoder — without these two, address search is national', () => {
  const open = () => setup(<MapSection />, () => screen.queryByPlaceholderText(M.localityPlaceholder))

  it('stores the home locality', async () => {
    await open()
    await type(screen.getByPlaceholderText(M.localityPlaceholder), '4104 Musterdorf BL')
    await settle()
    expect(sent()?.map.geocoder.defaultLocality).toBe('4104 Musterdorf BL')
  })

  it('stores a well-formed LV95 bbox', async () => {
    await open()
    await type(screen.getByPlaceholderText(M.bboxPlaceholder), '2606000,1253000,2616000,1263000')
    await settle()
    expect(sent()?.map.geocoder.bboxLv95).toBe('2606000,1253000,2616000,1263000')
  })

  it('holds back a malformed bbox — and the locality beside it still saves', async () => {
    await open()
    await type(screen.getByPlaceholderText(M.bboxPlaceholder), '2606000,1253000')
    await settle()
    expect(screen.getByText(M.bboxInvalid)).toBeTruthy()
    expect(apiPut).not.toHaveBeenCalled()
    // …the sibling is not taken down with it, which is the whole point of holding it locally
    await type(screen.getByPlaceholderText(M.localityPlaceholder), '4104 Musterdorf BL')
    await settle()
    expect(sent()?.map.geocoder.defaultLocality).toBe('4104 Musterdorf BL')
    expect(sent()?.map.geocoder.bboxLv95).toBeNull()
  })

  it('refuses a reversed box (min past max) rather than un-biasing every search silently', async () => {
    await open()
    await type(screen.getByPlaceholderText(M.bboxPlaceholder), '2616000,1263000,2606000,1253000')
    await settle()
    expect(screen.getByText(M.bboxInvalid)).toBeTruthy()
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('derives a box from the configured centre, because nobody knows their own by heart', async () => {
    await open()
    await act(async () => { fireEvent.click(screen.getByText(M.bboxFromCenter)) })
    await settle()
    const box = String(sent()?.map.geocoder.bboxLv95).split(',').map(Number)
    expect(box).toHaveLength(4)
    expect(box[2] - box[0]).toBe(10_000)
    expect(box[3] - box[1]).toBe(10_000)
  })
})

describe('map.externalLinks — the cantonal GIS deep links', () => {
  it('stores a complete row and holds back the empty one «hinzufügen» creates', async () => {
    await setup(<MapSection />, () => screen.queryByText(M.extAdd))
    await act(async () => { fireEvent.click(screen.getByText(M.extAdd)) })
    await settle()
    // an empty row is a dead button in the panel — it must not reach the document, and since
    // the filtered list is still `[]` there is nothing to save at all
    expect(apiPut).not.toHaveBeenCalled()
    await type(screen.getByPlaceholderText(M.extLabelPlaceholder), 'GeoView BL')
    await type(screen.getByPlaceholderText(M.extUrlPlaceholder), 'https://geoview.bl.ch/?E={E}&N={N}')
    await settle()
    expect(sent()?.map.externalLinks).toEqual([
      { label: 'GeoView BL', urlTemplate: 'https://geoview.bl.ch/?E={E}&N={N}' },
    ])
  })

  it('resolves the placeholders in the preview, so a wrong parameter name shows up here', async () => {
    await setup(<MapSection />, () => screen.queryByText(M.extAdd))
    await act(async () => { fireEvent.click(screen.getByText(M.extAdd)) })
    await type(screen.getByPlaceholderText(M.extLabelPlaceholder), 'GeoView BL')
    await type(screen.getByPlaceholderText(M.extUrlPlaceholder), 'https://geoview.bl.ch/?E={E}&N={N}')
    const preview = document.querySelector('.adm-formlink-preview')!.textContent!
    expect(preview).toContain('E=26')
    expect(preview).not.toContain('{E}')
  })
})

describe('report.reversePrintOrder — the one switch a print-relay station meets', () => {
  it('starts from the shipped default (on) and stores the flip', async () => {
    await setup(<ReportSection />, () => screen.queryByText(R.reverseOrder))
    const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(box.checked).toBe(true)
    await act(async () => { fireEvent.click(box) })
    await settle()
    expect(sent()?.report.reversePrintOrder).toBe(false)
  })
})

describe('alarms — three numbers with hard bounds on the backend', () => {
  /** autoArchiveDays / staleIncidentDays / captureWindowHours, in DOM order. */
  const nums = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="number"]'))
  const open = () => setup(<AlarmsSection />, () => nums().length === 3)

  it('stores each of the three', async () => {
    await open()
    await type(nums()[0], '14')
    await type(nums()[1], '60')
    await type(nums()[2], '48')
    await settle()
    expect(sent()?.alarms).toMatchObject({ autoArchiveDays: 14, staleIncidentDays: 60, captureWindowHours: 48 })
  })

  it('an EMPTIED field is not a null — it is held back, because the API has no optional int here', async () => {
    await open()
    await type(nums()[0], '')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(fillTemplate(A.numberRange, { min: 0, max: 3650 }))).toBeTruthy()
  })

  it('refuses a capture window past the API maximum — and the field beside it still saves', async () => {
    await open()
    await type(nums()[2], '999')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(fillTemplate(A.numberRange, { min: 1, max: 168 }))).toBeTruthy()
    await type(nums()[0], '14')
    await settle()
    expect(sent()?.alarms.autoArchiveDays).toBe(14)
    expect(sent()?.alarms.captureWindowHours).toBe(12) // the stored value, untouched
  })

  it('refuses a fraction: these are integers on the backend', async () => {
    await open()
    await type(nums()[1], '7.5')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
  })
})

describe('alarms.webhooks — how a second system learns an Einsatz exists', () => {
  const open = () => setup(<AlarmsSection />, () => screen.queryByText(A.webhookAdd))

  it('holds back the empty row and stores the address once it is one', async () => {
    await open()
    await act(async () => { fireEvent.click(screen.getByText(A.webhookAdd)) })
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    await type(screen.getByPlaceholderText(A.webhookPlaceholder), 'https://rueck.example.ch/api/alarms')
    await settle()
    expect(sent()?.alarms.webhooks).toEqual(['https://rueck.example.ch/api/alarms'])
  })

  it('says so when the address is not one, rather than never delivering in silence', async () => {
    await open()
    await act(async () => { fireEvent.click(screen.getByText(A.webhookAdd)) })
    await type(screen.getByPlaceholderText(A.webhookPlaceholder), 'rueck.example.ch/api/alarms')
    await settle()
    expect(screen.getByText(A.webhookInvalid)).toBeTruthy()
    expect(apiPut).not.toHaveBeenCalled()
  })
})
