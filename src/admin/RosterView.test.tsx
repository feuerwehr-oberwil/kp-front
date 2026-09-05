// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The CSV import stops BEFORE it writes — for EVERY file, not only for one that uses a
// Dienstgrad the station's rank list does not know. What is asserted here is the part a person
// can see:
//   • picking the file imports nobody — the confirmation appears first, ranks known or not;
//   • it says how many people are new and how many it would update in place;
//   • one unknown VALUE is one row, whatever the number of people behind it;
//   • «Abbrechen» sends nothing at all;
//   • the decisions leave for the server exactly as they were made.
// Two bugs live here. The old import wrote all 40 people first and listed «Zeile 12: unbekannter
// Grad 'Sdt'» afterwards, under a green «40 importiert» badge. Its replacement only asked when a
// rank was unknown — so a station that re-picked an already-imported file got its whole Wehr a
// second time, silently, because by then every rank was known.

const { previewRosterCsv, importRosterCsv, listRoster } = vi.hoisted(() => ({
  previewRosterCsv: vi.fn(),
  importRosterCsv: vi.fn(),
  listRoster: vi.fn(),
}))
vi.mock('./rosterApi', () => ({
  listRoster,
  previewRosterCsv,
  importRosterCsv,
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  deactivatePerson: vi.fn(),
}))

const apiGet = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiGet: (p: string) => apiGet(p), apiPut: vi.fn() }
})

import { RosterView } from './RosterView'
import { ConfigProvider } from './ConfigContext'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

const C = appConfig.copy.admin.roster

const KNOWN = [
  { key: 'oblt', label: 'Oberleutnant', abbr: 'Oblt' },
  { key: 'fwm', label: 'Feuerwehrmann', abbr: 'Fwm' },
]

/** «Sdt» three times (nothing like it in the list) and one near-miss the server proposes. */
const PREVIEW = {
  total: 40,
  creates: 40,
  updates: 0,
  skipped: 0,
  errors: [],
  known_ranks: KNOWN,
  has_own_ranks: true,
  unknown_ranks: [
    { value: 'Sdt', count: 3, people: ['Berger Luca', 'Frei Nadja', 'Sutter Ivo'], suggestion: null },
    { value: 'Oblt.', count: 2, people: ['Kunz Bea', 'Roth Tim'], suggestion: 'oblt' },
  ],
}

const RESULT = { imported: 40, created: 40, updated: 0, skipped: 0, errors: [], adopted_ranks: [] }

beforeEach(() => {
  vi.clearAllMocks()
  listRoster.mockResolvedValue([])
  importRosterCsv.mockResolvedValue(RESULT)
  apiGet.mockResolvedValue({ integrations: {} })
})
afterEach(cleanup)

/** Mount the page and hand it a file, as the operator does. */
async function pickFile(preview: unknown = PREVIEW) {
  previewRosterCsv.mockResolvedValue(preview)
  const { container } = await act(async () => render(<ConfigProvider><RosterView /></ConfigProvider>))
  const input = await waitFor(() => {
    const el = container.querySelector('input[type="file"]')
    if (!el) throw new Error('no file input')
    return el as HTMLInputElement
  })
  const file = new File(['name,rank\n'], 'mannschaft-2026.csv', { type: 'text/csv' })
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(previewRosterCsv).toHaveBeenCalled())
}

const primary = () => screen.getByRole('button', { name: /importieren$/i }) as HTMLButtonElement

/** Choose an option in one row's «Wird zu» picker. */
function choose(rowValue: string, optionLabel: string) {
  fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.mapTargetFor, { value: rowValue }) }))
  fireEvent.click(screen.getByRole('option', { name: optionLabel }))
}

describe('CSV-Import · Grade zuordnen', () => {
  it('imports nobody until the unknown ranks are decided', async () => {
    await pickFile()
    await screen.findByText(C.mapTitle)
    expect(importRosterCsv).not.toHaveBeenCalled()
  })

  it('asks once per VALUE, not once per person', async () => {
    await pickFile()
    await screen.findByText(C.mapTitle)
    expect(screen.getAllByText('Sdt')).toHaveLength(1)
    expect(screen.getByText(fillTemplate(C.mapPeopleCount, { n: 3 }))).toBeTruthy()
    expect(screen.getByText('Berger Luca, Frei Nadja, Sutter Ivo')).toBeTruthy()
  })

  it('writes nothing at all when the mapping is cancelled', async () => {
    await pickFile()
    await screen.findByText(C.mapTitle)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common2.cancel }))
    await waitFor(() => expect(screen.queryByText(C.mapTitle)).toBeNull())
    expect(importRosterCsv).not.toHaveBeenCalled()
  })

  it('sends the decisions as they were made — a proposal is preselected, never applied silently', async () => {
    await pickFile()
    await screen.findByText(C.mapTitle)
    // «Oblt.» came back with a proposal, «Sdt» with none: the one is preselected on the rank,
    // the other on «neuer Grad».
    expect(screen.getByText('Oberleutnant · Oblt')).toBeTruthy()
    choose('Sdt', C.mapDropOption)
    fireEvent.click(primary())

    await waitFor(() => expect(importRosterCsv).toHaveBeenCalled())
    expect(importRosterCsv.mock.calls[0][1]).toEqual([
      { value: 'Sdt', action: 'skip' },
      { value: 'Oblt.', action: 'map', rank: 'oblt' },
    ])
  })

  it('takes the whole column in one press when the station has no rank list of its own', async () => {
    await pickFile({ ...PREVIEW, has_own_ranks: false })
    await screen.findByText(C.mapNoOwnListTitle)
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.mapAdoptAll, { n: 2 }) }))

    // the primary action says what it now does — «übernehmen», not «zuordnen»
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.mapAdoptAndImport, { n: 40 }) }))
    await waitFor(() => expect(importRosterCsv).toHaveBeenCalled())
    expect(importRosterCsv.mock.calls[0][1]).toEqual([
      { value: 'Sdt', action: 'adopt' },
      { value: 'Oblt.', action: 'adopt' },
    ])
  })

  it('confirms a file whose ranks are all known too — without a mapping table', async () => {
    await pickFile({ ...PREVIEW, unknown_ranks: [] })
    await screen.findByText(C.confirmTitle)
    expect(importRosterCsv).not.toHaveBeenCalled()
    expect(screen.queryByText(C.mapColValue)).toBeNull()

    fireEvent.click(primary())
    await waitFor(() => expect(importRosterCsv).toHaveBeenCalled())
    expect(importRosterCsv.mock.calls[0][1]).toEqual([])
    expect(await screen.findByText(fillTemplate(C.createdBadge, { n: 40 }))).toBeTruthy()
  })

  // The blocker: 14 people imported, the same file picked again. Nothing about it looks
  // different — same green sheet, same button — except the one line that matters.
  it('says «nothing new, 14 updates» when the file has already been imported', async () => {
    await pickFile({ ...PREVIEW, total: 14, creates: 0, updates: 14, unknown_ranks: [] })
    await screen.findByText(C.confirmTitle)
    expect(screen.getByText(fillTemplate(C.confirmNew, { n: 0 }))).toBeTruthy()
    expect(screen.getByText(fillTemplate(C.confirmUpdated, { n: 14 }))).toBeTruthy()
    expect(importRosterCsv).not.toHaveBeenCalled()
  })

  it('writes nothing when a plain confirmation is cancelled', async () => {
    await pickFile({ ...PREVIEW, creates: 0, updates: 40, unknown_ranks: [] })
    await screen.findByText(C.confirmTitle)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common2.cancel }))
    await waitFor(() => expect(screen.queryByText(C.confirmTitle)).toBeNull())
    expect(importRosterCsv).not.toHaveBeenCalled()
  })

  it('offers no import at all for a file that would touch nobody', async () => {
    await pickFile({ ...PREVIEW, total: 0, creates: 0, updates: 0, skipped: 3, unknown_ranks: [] })
    await screen.findByText(C.confirmNothing)
    expect(primary().disabled).toBe(true)
  })
})
