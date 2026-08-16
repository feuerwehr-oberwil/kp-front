// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sicherung → Import, the documented browser route to the parts of the config the UI cannot
// edit (the Mittel-Katalog). Two failures a fresh-station setup ran into:
//
//   · the server answered 422 saying exactly which field, which entry and what it found —
//     `loc: ["body","mittel","sources",0]`, `input: "TLF 31"` — and the UI showed
//     «Konfiguration ungültig (422) – Datei passt nicht zum Schema.» and nothing else. Three
//     blind attempts to discover that `units` are strings and `sources` are objects.
//   · the most destructive action in /admin (a FULL-DOCUMENT replace) confirmed with
//     `window.confirm()`, which an installed iOS PWA may suppress without a trace.

const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    fields?: { path: string; msg: string; kind?: string; input?: unknown }[]
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))

const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn() }))
vi.mock('../lib/download', () => ({ downloadBlob }))

import { ConfigBackup } from './ConfigBackup'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.backup

/** A config with content in the sections a bad import would silently empty. */
const CURRENT = {
  identity: { appName: 'Feuerwehr Steintal', accentColor: '#1d6f5c' },
  fleet: { vehicles: [{ id: 'tlf-31', label: 'TLF 31' }] },
  roster: { ranks: [{ key: 'kdt', label: 'Kommandant' }] },
  version: 'v1',
}

/** Pick a file — the browser's `change` on the hidden <input type=file>. */
async function pick(content: unknown, name = 'mittel.json') {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!
  const file = new File([JSON.stringify(content)], name, { type: 'application/json' })
  // jsdom's File has no usable .text() under this Node build — give it one
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify(content) })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { fireEvent.change(input) })
}

const confirmButton = () => screen.getByRole('button', { name: C.replaceGo })

beforeEach(() => {
  apiGet.mockReset().mockResolvedValue({ ...CURRENT, version: 'v2' })
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
  downloadBlob.mockReset()
})
afterEach(cleanup)

function setup() {
  const onImported = vi.fn()
  render(<ConfigBackup config={CURRENT} onImported={onImported} />)
  return onImported
}

describe('Konfiguration importieren', () => {
  it('asks in the app, not in a browser dialog — and says it is a REPLACE', async () => {
    const nativeConfirm = vi.fn(() => true)
    vi.stubGlobal('confirm', nativeConfirm)
    setup()
    await pick({ mittel: { units: ['Stk'] } })
    await waitFor(() => expect(confirmButton()).toBeTruthy())
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(screen.getByText(C.replaceTitle)).toBeTruthy()
    // the file it is about to apply, by name, and «nothing is merged» in the same sentence
    expect(screen.getByText(/mittel\.json/)).toBeTruthy()
    expect(screen.getByText(/zusammengeführt/)).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('names the sections the file would empty, before the write, not after', async () => {
    setup()
    await pick({ mittel: { units: ['Stk'] } })
    await waitFor(() => expect(screen.getByText(C.replaceEmpties)).toBeTruthy())
    // named the way the Verwaltung names them, never «fleet» / «roster»
    const listed = Array.from(document.querySelectorAll('.adm-import-errs li')).map((li) => li.textContent)
    expect(listed).toContain(appConfig.copy.admin.nav.fahrzeuge.title)
    expect(listed).toContain(appConfig.copy.admin.nav.mannschaft.title)
    expect(listed.join(' ')).not.toContain('fleet')
  })

  it('cancelling writes nothing at all', async () => {
    const onImported = setup()
    await pick({ mittel: { units: ['Stk'] } })
    await waitFor(() => expect(confirmButton()).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common2.cancel })) })
    expect(apiPut).not.toHaveBeenCalled()
    expect(onImported).not.toHaveBeenCalled()
    // …and not even the rollback file was downloaded: nothing happened
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(screen.queryByText(C.replaceTitle)).toBeNull()
  })

  it('confirming downloads the rollback file first, then replaces', async () => {
    const onImported = setup()
    await pick({ mittel: { units: ['Stk'] } })
    await waitFor(() => expect(confirmButton()).toBeTruthy())
    await act(async () => { fireEvent.click(confirmButton()) })
    await waitFor(() => expect(apiPut).toHaveBeenCalled())
    expect(downloadBlob.mock.calls[0][1]).toBe('kp-front-config-vorher.json')
    expect(onImported).toHaveBeenCalled()
  })

  // ⚠️ The most destructive write in /admin, and the guard that keeps it from being an accident.
  // `put_config` answers 428 to ANY browser request without an `If-Match` — `fetch` always sends
  // `Sec-Fetch-Site`, so this page counts as one — which means dropping the header does not
  // weaken the import, it breaks it outright. The five tests above all pass with the header gone;
  // this one does not.
  it('sends the version it re-read a moment ago as If-Match, not the one this page was given', async () => {
    setup()
    await pick({ mittel: { units: ['Stk'] } })
    await waitFor(() => expect(confirmButton()).toBeTruthy())
    await act(async () => { fireEvent.click(confirmButton()) })
    await waitFor(() => expect(apiPut).toHaveBeenCalled())

    const [path, , headers] = apiPut.mock.calls[0] as [string, unknown, Record<string, string> | undefined]
    expect(path).toBe('/api/config')
    // `CURRENT.version` is 'v1' — the FRESH read answers 'v2', and that is the one that must go
    // out, or an import started on a page opened this morning is refused for being old.
    expect(headers).toEqual({ 'If-Match': 'v2' })
    // …and it is read immediately BEFORE the write, not taken from the page's own draft
    expect(apiGet).toHaveBeenCalledWith('/api/config')
  })

  it('a refused file says WHICH field, WHICH entry and what was found', async () => {
    setup()
    const err = new ApiError(422, 'mittel.sources.0: Input should be a valid dictionary')
    err.fields = [
      { path: 'mittel.sources.0', msg: 'Input should be a valid dictionary or object to extract fields from',
        kind: 'model_attributes_type', input: 'TLF 31' },
      { path: 'mittel.units.0', msg: 'Input should be a valid string', kind: 'string_type', input: { id: 'x' } },
    ]
    apiPut.mockRejectedValue(err)
    await pick({ mittel: { sources: ['TLF 31'], units: [{ id: 'x' }] } })
    await waitFor(() => expect(confirmButton()).toBeTruthy())
    await act(async () => { fireEvent.click(confirmButton()) })

    await waitFor(() => expect(screen.getByText(C.invalidFields)).toBeTruthy())
    const sources = screen.getByText(new RegExp(C.fieldMittelSources))
    expect(sources.textContent).toContain('Eintrag 1')       // 1-based — the file is read by a person
    expect(sources.textContent).toContain(C.expectObject)    // what the shape has to be
    expect(sources.textContent).toContain('TLF 31')          // …and what was actually there
    const units = screen.getByText(new RegExp(C.fieldMittelUnits))
    expect(units.textContent).toContain(C.expectText)
    // never the English Pydantic sentence
    expect(document.body.textContent).not.toContain('Input should be a valid')
  })

  it('falls back to the plain 422 line when the server named no field', async () => {
    setup()
    apiPut.mockRejectedValue(new ApiError(422, 'nope'))
    await pick({ mittel: {} })
    await waitFor(() => expect(confirmButton()).toBeTruthy())
    await act(async () => { fireEvent.click(confirmButton()) })
    await waitFor(() => expect(screen.getByText(C.invalidSchema)).toBeTruthy())
  })
})
