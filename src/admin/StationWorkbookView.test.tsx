// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ⚠️ THIS FILE EXISTS BECAUSE OF A SPECIFIC FAILURE IN THE SIBLING PRODUCT.
//
// kp-rueck's Excel import computes the deletion impact server-side, types it in its API client
// — and its settings page never renders it. Its own troubleshooting guide now carries a row
// titled «An Excel import deleted the whole roster», and the numbers that would have prevented
// it were sitting in the response the whole time. So the backend being right is not the thing
// under test here: the SCREEN is the safety feature, and these are the four things it has to
// put in front of the operator before a single row is written.
//
//   1. removals are NAMED, not counted — a number is useless to the person who has to act
//   2. «deaktiviert» (people, soft) and «entfernt» (list entries) are different words, because
//      they are different outcomes
//   3. an ABSENT sheet reads differently from a present-but-empty one — that is the difference
//      between «fleet untouched» and «fleet cleared»
//   4. a refused row blocks the confirm button and carries its sheet + row number

const { apiGet, apiPut, apiUpload, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), apiUpload: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, apiUpload, ApiError }))

const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn() }))
vi.mock('../lib/download', () => ({ downloadBlob }))

import { StationWorkbookView } from './StationWorkbookView'
import { ConfigProvider } from './ConfigContext'
import { IdentitySection } from './ConfigSections'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.workbook
const Cc = appConfig.copy.admin.common2

interface Impact {
  sheet: string
  present: boolean
  rows?: number
  created?: number
  updated?: number
  unchanged?: number
  removed?: string[]
  removed_total?: number
  removal_kind?: 'removed' | 'deactivated' | 'none'
}

function impact(sheet: string, over: Partial<Impact> = {}): Impact {
  return {
    sheet,
    present: true,
    rows: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    removed: [],
    removed_total: 0,
    removal_kind: 'none',
    ...over,
  }
}

function preview(over: Partial<{
  sheets: Impact[]
  errors: string[]
  warnings: string[]
  emptied: string[]
  ok: boolean
}> = {}) {
  return {
    sheets: [impact('Mannschaft'), impact('Fahrzeuge')],
    errors: [],
    warnings: [],
    emptied: [],
    digest: 'sha-of-the-file-that-was-read',
    ok: true,
    ...over,
  }
}

/** Pick a file — the browser's `change` on the hidden <input type=file>. */
async function pick(name = 'stationsdaten.xlsx') {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!
  const file = new File([new Uint8Array([80, 75, 3, 4])], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { fireEvent.change(input) })
}

/** The impact row for one sheet, as the operator reads it. */
function row(sheet: string): HTMLElement {
  return screen.getByText(sheet, { selector: 'td' }).closest('tr')!
}

const confirmButton = () => screen.getByRole('button', { name: C.confirm })

/** The config document as the shell holds it BEFORE an import — the rank list and the vehicle
 *  list a workbook rewrites, plus the version token every write is checked against. */
const BEFORE = {
  version: 'v-before',
  roster: { ranks: [{ key: 'kdt', label: 'Kommandant' }] },
  fleet: { vehicles: [{ id: 'tlf-31', label: 'TLF 31' }] },
}
/** …and as the server holds it AFTER one: new ranks, new vehicles, a new token. */
const AFTER = {
  version: 'v-after',
  roster: { ranks: [{ key: 'kdt', label: 'Kommandant' }, { key: 'of', label: 'Offizier' }] },
  fleet: { vehicles: [{ id: 'tlf-31', label: 'TLF 31' }, { id: 'adl-41', label: 'ADL 41' }] },
}

beforeEach(() => {
  apiUpload.mockReset()
  downloadBlob.mockReset()
  apiGet.mockReset().mockResolvedValue(structuredClone(BEFORE))
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(cleanup)

/** ⚠️ Inside the ConfigProvider, the way AdminShell mounts it — this page is one of the config
 *  document's writers, and what it has to do about that is the subject of the last describe. */
const mount = () => render(<ConfigProvider><StationWorkbookView /></ConfigProvider>)

describe('the confirmation screen', () => {
  it('names what goes away instead of only counting it', async () => {
    // ⚠️ The single thing kp-rueck's page dropped. «2 entfernt» tells the operator nothing they
    // can act on; «mtf-11, vrf-21» tells them whether to press the button.
    apiUpload.mockResolvedValue(preview({
      sheets: [
        impact('Fahrzeuge', {
          rows: 2, unchanged: 2, removed: ['mtf-11', 'vrf-21'], removed_total: 2, removal_kind: 'removed',
        }),
      ],
    }))
    mount()
    await pick()

    const cell = row('Fahrzeuge')
    expect(within(cell).getByText(/mtf-11/)).toBeTruthy()
    expect(within(cell).getByText(/vrf-21/)).toBeTruthy()
  })

  it('says «und N weitere» rather than silently truncating a long list', async () => {
    apiUpload.mockResolvedValue(preview({
      sheets: [
        impact('Mittel', {
          rows: 1,
          removed: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
          removed_total: 14,
          removal_kind: 'removed',
        }),
      ],
    }))
    mount()
    await pick()
    expect(within(row('Mittel')).getByText(/und 6 weitere/)).toBeTruthy()
  })

  it('uses «deaktiviert» for people and «entfernt» for the id-keyed sheets', async () => {
    // ⚠️ Two meanings of «absent» in one workbook. A person is deactivated — never deleted,
    // because every incident they were on resolves their name through that row — while a
    // vehicle id is removed from a list. An operator who reads one and gets the other has been
    // misled by the screen that exists to protect them.
    apiUpload.mockResolvedValue(preview({
      sheets: [
        impact('Mannschaft', {
          rows: 13, unchanged: 13, removed: ['Furrer Andrea'], removed_total: 1, removal_kind: 'deactivated',
        }),
        impact('Fahrzeuge', {
          rows: 3, unchanged: 3, removed: ['adl-41'], removed_total: 1, removal_kind: 'removed',
        }),
      ],
    }))
    mount()
    await pick()

    const crew = within(row('Mannschaft'))
    const fleet = within(row('Fahrzeuge'))
    expect(crew.getByText(/deaktiviert/)).toBeTruthy()
    expect(crew.queryByText(/entfernt/)).toBeNull()
    expect(fleet.getByText(/entfernt/)).toBeTruthy()
    expect(fleet.queryByText(/deaktiviert/)).toBeNull()
  })

  it('reads «nicht in der Datei» for an absent sheet, and not for an empty one', async () => {
    // ⚠️ The distinction the whole safety design turns on: no Fahrzeuge tab = the fleet is not
    // touched; a Fahrzeuge tab holding only its header = the fleet is cleared. Both are zero
    // rows, so a screen that renders them the same is a screen that hides a wipe.
    apiUpload.mockResolvedValue(preview({
      sheets: [
        impact('Fahrzeuge', { present: false }),
        impact('Mittel', {
          rows: 0, removed: ['schlauch-75', 'oelbinder'], removed_total: 2, removal_kind: 'removed',
        }),
      ],
      emptied: ['mittel.catalogue'],
    }))
    mount()
    await pick()

    expect(within(row('Fahrzeuge')).getByText(C.sheetAbsent)).toBeTruthy()
    const cleared = within(row('Mittel'))
    expect(cleared.queryByText(C.sheetAbsent)).toBeNull()
    expect(cleared.getByText(/schlauch-75/)).toBeTruthy()
    // …and the emptied section is spelled out under the table, before the fact
    expect(screen.getByText(C.emptiedTitle)).toBeTruthy()
    expect(screen.getByText('mittel.catalogue')).toBeTruthy()
  })

  it('blocks the confirmation while a row is refused, and shows sheet + row for each', async () => {
    const errors = [
      'Fahrzeuge Zeile 2 – Kennung «01.02.2026» ist ein Datum. Excel hat die Kennung umgewandelt …',
      'Mittel-Bestände Zeile 7 – Quellen-Kennung «hlf-99» gibt es nicht …',
    ]
    apiUpload.mockResolvedValue(preview({ ok: false, errors }))
    mount()
    await pick()

    expect(confirmButton()).toHaveProperty('disabled', true)
    for (const line of errors) expect(screen.getByText(line)).toBeTruthy()
    expect(screen.getByText(C.blockedHint)).toBeTruthy()
    // nothing was sent beyond the preview itself
    expect(apiUpload).toHaveBeenCalledTimes(1)
    expect(apiUpload.mock.calls[0][0]).toBe('/api/station-workbook/preview')
  })

  it('surfaces what a rename costs, because nothing else in the app would', async () => {
    const warn = '«Roth Livia» wird zu «Roth-Meier Livia» umbenannt. Die Aufteilung in Vor- und '
      + 'Nachname geht dabei verloren – diese Person folgt danach nicht mehr der Namensreihenfolge '
      + 'der Station, sondern steht genau so da wie in der Zelle.'
    apiUpload.mockResolvedValue(preview({ warnings: [warn] }))
    mount()
    await pick()

    expect(screen.getByText(C.warningsTitle)).toBeTruthy()
    expect(screen.getByText(warn)).toBeTruthy()
    // a warning is not a refusal — it explains, it does not block
    expect(confirmButton()).toHaveProperty('disabled', false)
  })
})

describe('nothing is written until the operator says so', () => {
  it('only previews on pick, and sends the confirmed file with the digest it read', async () => {
    apiUpload.mockResolvedValueOnce(preview()).mockResolvedValueOnce({ sheets: [], warnings: [], emptied: [] })
    mount()
    await pick()
    expect(apiUpload).toHaveBeenCalledTimes(1)

    await act(async () => { fireEvent.click(confirmButton()) })
    expect(apiUpload).toHaveBeenCalledTimes(2)
    const [path, form] = apiUpload.mock.calls[1] as [string, FormData]
    expect(path).toBe('/api/station-workbook/import')
    // ⚠️ The digest is what makes «confirm» mean THIS file: an edit saved in Excel between the
    // preview and the button gets a 409 rather than a silent apply of something nobody saw.
    expect(form.get('digest')).toBe('sha-of-the-file-that-was-read')
    expect((form.get('file') as File).name).toBe('stationsdaten.xlsx')
  })

  it('cancelling sends nothing at all and takes the preview off the screen', async () => {
    apiUpload.mockResolvedValue(preview({
      sheets: [impact('Fahrzeuge', { removed: ['tlf-31'], removed_total: 1, removal_kind: 'removed' })],
    }))
    mount()
    await pick()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: Cc.cancel })) })
    expect(apiUpload).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: C.confirm })).toBeNull()
    expect(screen.queryByText(/tlf-31/)).toBeNull()
  })

  it('reports a refused import in the server’s own German instead of a generic failure', async () => {
    apiUpload
      .mockResolvedValueOnce(preview())
      .mockRejectedValueOnce(new ApiError(409, 'Die Datei hat sich seit der Vorschau geändert. Bitte die Vorschau neu erstellen.'))
    mount()
    await pick()
    await act(async () => { fireEvent.click(confirmButton()) })

    expect(screen.getByText(/Die Datei hat sich seit der Vorschau geändert/)).toBeTruthy()
  })
})

describe('the page says what the workbook is not', () => {
  it('names the backup that this file is not, before anything else', () => {
    // ⚠️ A file that looks like the whole station is the file somebody reaches for after a bad
    // day. It carries six of a dozen config sections; the restore path is elsewhere.
    mount()
    expect(screen.getByText(C.notBackup)).toBeTruthy()
    expect(screen.getByText(new RegExp(C.carriesNot.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy()
  })

  it('downloads the station’s own file as the template and the undo', async () => {
    const blob = new Blob([new Uint8Array([80, 75])])
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob })
    vi.stubGlobal('fetch', fetchMock)
    mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: C.download })) })

    expect(downloadBlob).toHaveBeenCalledTimes(1)
    expect(downloadBlob.mock.calls[0][1]).toMatch(/^stationsdaten-\d{4}-\d{2}-\d{2}\.xlsx$/)
    // A binary GET goes around the api client, so it has to carry the session-mode header by
    // hand (api · rawFetch): /admin is the ordinary app, never some link cookie's viewer.
    expect(fetchMock.mock.calls[0][1].headers['X-Incident-Link']).toBe('off')
    vi.unstubAllGlobals()
  })
})

// ⚠️ THE OTHER HALF OF THE SAFETY DESIGN, and the one that was missing.
//
// The import rewrites six sections of the config document server-side. The shared editor
// (ConfigContext) read `/api/config` once when the shell mounted and this page never told it
// anything, so afterwards the provider still held the PRE-import `draft`, `saved` AND version
// token. Any later edit anywhere in Verwaltung was then a 409, and the «Übernehmen» chip it
// offers re-sends this tab's document — putting `roster.ranks`, `fleet.vehicles`, `mittel.*`,
// `report.partnerOrgs`, `fleet.partner` and `fleet.attributeLists` back as they were. The
// imported PEOPLE survive that (their own table), so the station is left with personnel pointing
// at rank keys that no longer exist: precisely the split the import's single transaction exists
// to prevent, reintroduced by the browser afterwards.
describe('after an import, the editor holds the document the server now has', () => {
  /** Import a workbook, with the server answering `AFTER` on the re-read. */
  async function importWorkbook() {
    apiUpload.mockResolvedValueOnce(preview()).mockResolvedValueOnce({ sheets: [], warnings: [], emptied: [] })
    render(<ConfigProvider><StationWorkbookView /><IdentitySection /></ConfigProvider>)
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await pick()
    apiGet.mockResolvedValue(structuredClone(AFTER))
    await act(async () => { fireEvent.click(confirmButton()) })
  }

  /** The one field on the Identität page — an ordinary later edit, on another Station page. */
  const editSomethingElse = async () => {
    const box = screen.getByPlaceholderText(appConfig.copy.help.introFallback)
    await act(async () => { fireEvent.change(box, { target: { value: 'Die Wehr.' } }) })
    await waitFor(() => expect(apiPut).toHaveBeenCalled(), { timeout: 3000 })
  }

  it('re-reads the config once the import has landed', async () => {
    await importWorkbook()
    // mount + re-read, and the second one only AFTER the write
    await waitFor(() => expect(apiGet.mock.calls.filter((c) => c[0] === '/api/config')).toHaveLength(2))
    expect(apiUpload.mock.calls[1][0]).toBe('/api/station-workbook/import')
  })

  it('the next edit writes the IMPORTED document, not the one from before it', async () => {
    await importWorkbook()
    await editSomethingElse()
    const [, body, headers] = apiPut.mock.calls[0] as [string, typeof AFTER, Record<string, string>]
    // the ranks the file brought — writing BEFORE's single rank here is the clobber
    expect(body.roster.ranks).toHaveLength(2)
    expect(body.fleet.vehicles.map((v) => v.id)).toEqual(['tlf-31', 'adl-41'])
    // …and against the token the import produced, so this write is not a 409 in the first place
    expect(headers).toEqual({ 'If-Match': 'v-after' })
  })

  it('does not re-read after a REFUSED import — there is nothing new to hold', async () => {
    apiUpload
      .mockResolvedValueOnce(preview())
      .mockRejectedValueOnce(new ApiError(409, 'Die Datei hat sich seit der Vorschau geändert.'))
    mount()
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1))
    await pick()
    await act(async () => { fireEvent.click(confirmButton()) })
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('says the page is stale when the re-read itself fails, instead of staying quiet', async () => {
    apiUpload.mockResolvedValueOnce(preview()).mockResolvedValueOnce({ sheets: [], warnings: [], emptied: [] })
    mount()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await pick()
    apiGet.mockRejectedValue(new ApiError(503, 'offline'))
    await act(async () => { fireEvent.click(confirmButton()) })
    // the import itself still counts as done — it is; only this tab's copy of the result is not
    expect(screen.getByText(C.done)).toBeTruthy()
    expect(screen.getByText(C.reloadHint)).toBeTruthy()
  })
})
