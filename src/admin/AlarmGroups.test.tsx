// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Alarmgruppen are the group half of the Rapport's «Alarmierungszeiten» grid, and they are
// written through the SAME full-document PUT as every other Station page. So what this file pins
// is the rule that keeps that safe — a row the backend would refuse (`id`/`label` are min_length=1,
// and a duplicate id would silently merge two groups into one printed line) never reaches the
// config document — plus the one thing the whole-document model makes easy to get wrong: a
// half-typed group must not stop a SIBLING field on the same page from saving.

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
import { AlarmsSection } from './ConfigSections'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.alarms
// ⚠️ carries the two fields this form does NOT show. They are read by nothing today, but the CLI
// writes them and an edit made here must not delete them.
const STORED = { id: 'fwo-gruppe2', label: 'Gr. 2', color: 'Rot', winfapAlias: '2', tagespikett: false }

/** The groups in the most recent PUT body. */
const sentGroups = () => {
  const last = apiPut.mock.calls[apiPut.mock.calls.length - 1]
  return (last?.[1] as { alarms?: { groups?: unknown[] } })?.alarms?.groups
}
const sentBody = () => apiPut.mock.calls[apiPut.mock.calls.length - 1]?.[1] as
  { alarms?: { groups?: unknown[]; captureWindowHours?: number } }

const rowInputs = (i: number) =>
  document.querySelectorAll('.adm-formlink')[i].querySelectorAll('input')

/** Let the 700 ms autosave debounce elapse. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue({
    alarms: { groups: [STORED], captureWindowHours: 12 }, version: 'v1',
  })
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup() {
  render(<ConfigProvider><AlarmsSection /></ConfigProvider>)
  await waitFor(() => expect(document.querySelectorAll('.adm-formlink').length).toBe(1))
}

describe('Alarmgruppen — what reaches the config document', () => {
  it('never sends the empty row «Alarmgruppe hinzufügen» has to create', async () => {
    await setup()
    await act(async () => { screen.getByText(C.groupAdd).click() })
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.groupIncomplete)).toBeTruthy()
  })

  it('stores the row once it is complete — and keeps the CLI-written fields of the others', async () => {
    await setup()
    await act(async () => { screen.getByText(C.groupAdd).click() })
    await act(async () => { fireEvent.change(rowInputs(1)[0], { target: { value: 'Gr. 3' } }) })
    await settle()
    expect(sentGroups()).toEqual([
      STORED,
      // the Kennung follows the Bezeichnung until it is edited by hand
      { id: 'gr-3', label: 'Gr. 3' },
    ])
  })

  it('refuses a duplicate Kennung rather than merging two groups into one Rapport row', async () => {
    await setup()
    await act(async () => { screen.getByText(C.groupAdd).click() })
    await act(async () => { fireEvent.change(rowInputs(1)[0], { target: { value: 'Zweite Gruppe' } }) })
    await act(async () => { fireEvent.change(rowInputs(1)[1], { target: { value: 'FWO-Gruppe2' } }) })
    await settle()
    // nothing is written at all: the stored list is unchanged, so there is not even a PUT
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.groupDuplicate)).toBeTruthy()
  })

  it('lets a sibling field on the same page save while a row is still half-typed', async () => {
    await setup()
    await act(async () => { screen.getByText(C.groupAdd).click() })
    await act(async () => { fireEvent.change(rowInputs(1)[0], { target: { value: 'Gr. 9' } }) })
    await act(async () => { fireEvent.change(rowInputs(1)[1], { target: { value: '' } }) })
    // …and now the capture window, which lives in the same document and the same 700 ms save
    const hours = screen.getByDisplayValue('12')
    await act(async () => { fireEvent.change(hours, { target: { value: '48' } }) })
    await settle()
    expect(sentBody().alarms?.captureWindowHours).toBe(48)
    // the incomplete group stayed on screen and out of the document
    expect(sentBody().alarms?.groups).toEqual([STORED])
    expect(screen.getByText(C.groupIncomplete)).toBeTruthy()
  })

  it('edits the «Zusatz in Klammern» that the Rapport prints after the Bezeichnung', async () => {
    await setup()
    await act(async () => { fireEvent.change(rowInputs(0)[2], { target: { value: 'Kdo' } }) })
    await settle()
    expect(sentGroups()).toEqual([{ ...STORED, color: 'Kdo' }])
  })

  it('removes a group', async () => {
    await setup()
    await act(async () => { screen.getByLabelText(C.groupRemove).click() })
    await settle()
    expect(sentGroups()).toEqual([])
  })
})
