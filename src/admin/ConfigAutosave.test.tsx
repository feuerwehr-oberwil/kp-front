// @vitest-environment jsdom
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The PUT is what this file is about, so the API layer is the seam. `apiGet` serves the initial
// document (and the post-conflict re-read); `apiPut` is scripted per test.
// hoisted, because vi.mock's factory runs before module-level bindings exist
const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    hint?: string
    /** the structured half of a 422 — what the German message is built from (lib/api) */
    fields?: { path: string; msg: string }[]
    /** the NAMED refusal and its payload — what tells the two 409s apart (lib/api · ApiError) */
    code?: string
    data?: Record<string, unknown>
    constructor(status: number, detail: string, hint?: string, fields?: { path: string; msg: string }[]) {
      super(detail)
      this.status = status
      this.detail = detail
      this.hint = hint
      this.fields = fields
    }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))
vi.mock('../lib/deploymentConfig', () => ({
  loadDeploymentConfig: vi.fn(async () => ({})),
  applyDeploymentBranding: vi.fn(),
}))

import { ConfigProvider, ConfigAutosaveStatus, useConfig } from './ConfigContext'
import { appConfig } from '../config/appConfig'

/** A control that edits one field, so the autosave has something to fire on. Plus the seams the
 *  «one bad field took the whole page down» tests need: an arbitrary path write, the branding
 *  upload's callback, and the draft value on screen. */
function Edit() {
  const { set, applyServerAssets, draft } = useConfig()
  return (
    <>
      <button onClick={() => set(['identity', 'appName'], `x${Math.random()}`)}>edit</button>
      <button onClick={() => set(['identity', 'kommandant'], 'Hptm Muster')}>edit kommandant</button>
      <button onClick={() => set(['fleet', 'vehicles', 0, 'label'], 'TLF 1')}>edit row</button>
      <button onClick={() => applyServerAssets({ identity: { assets: { logo: '/logo.png' } }, version: 'v9' })}>
        upload
      </button>
      <output>{JSON.stringify(draft?.identity ?? {})}</output>
    </>
  )
}

const setup = () =>
  render(
    <ConfigProvider>
      <Edit />
      <ConfigAutosaveStatus />
    </ConfigProvider>,
  )

/** The most recent PUT body. */
const sent = () => apiPut.mock.calls[apiPut.mock.calls.length - 1]?.[1] as Record<string, any>

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue({ identity: { appName: 'Wehr' }, version: 'v1' })
  apiPut.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

/** Press a control, then let the 700 ms debounce elapse. */
async function press(label = 'edit') {
  await act(async () => { screen.getByText(label).click() })
  await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
}
const edit = () => press()

describe('Verwaltung autosave — it must stop trying', () => {
  it('⚠️ gives up instead of re-sending a refused document forever', async () => {
    // The bug this pins: the autosave effect returned early on `conflict` but not on `error`,
    // and `save.kind` is one of its dependencies — so error → saving → error re-armed it every
    // 700 ms, indefinitely, for as long as the document stayed invalid.
    // A 422 is a verdict on the document, so it does not even spend the second attempt: the
    // identical body cannot get a different answer.
    apiPut.mockRejectedValue(new ApiError(422, 'report.links.0.title: too short'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(apiPut).toHaveBeenCalledTimes(1)
  })

  it('shows what to do, not only what broke', async () => {
    apiPut.mockRejectedValue(new ApiError(413, 'Datei zu gross', 'Bild verkleinern und erneut hochladen.'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText('Bild verkleinern und erneut hochladen.')).toBeTruthy()
  })

  it('offers «Erneut versuchen» only once it has actually stopped', async () => {
    apiPut.mockRejectedValue(new ApiError(500, 'kaputt'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    // …because while it was still retrying by itself the button did nothing a wait would not,
    // which is how it came to read as broken
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy()
  })

  it('does not offer a retry for an expired session — that one cannot be retried into life', async () => {
    apiPut.mockRejectedValue(new ApiError(401, 'nope'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(screen.getByText(/Sitzung abgelaufen/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull()
    expect(apiPut).toHaveBeenCalledTimes(1) // halted at once, not after two
  })

  it('a save that lands clears the counter, so a later blip still gets its two tries', async () => {
    apiPut
      .mockRejectedValueOnce(new ApiError(500, 'blip'))
      .mockResolvedValueOnce({ identity: { appName: 'Wehr' }, version: 'v2' })
      .mockRejectedValue(new ApiError(500, 'blip'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(apiPut.mock.calls.length).toBeGreaterThan(2)
    expect(apiPut.mock.calls.length).toBeLessThanOrEqual(4)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// What one bad field may and may not take with it. The setup session this comes from lost
// App-Name, Markenfarbe and Kommandant to a map centre that was still being typed: the PUT is a
// full-document replace, so the 422 refused everything — and then a logo upload re-seeded the
// editor from the server, wiped the three fields off the screen, and turned the badge GREEN.
describe('Verwaltung autosave — a refused field must not take the page with it', () => {
  it('⚠️ builds an ARRAY where the path says index, not an object keyed by index', async () => {
    // `{"0": "TLF 1"}` is what a missing branch created as `{}` turns into, and the API refuses
    // it («Input should be a valid list») — for the whole document, not just that field.
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await press('edit row')
    expect(Array.isArray(sent().fleet.vehicles)).toBe(true)
    expect(sent().fleet.vehicles).toEqual([{ label: 'TLF 1' }])
  })

  it('a logo upload keeps what is still being typed, and does not claim it is saved', async () => {
    apiPut.mockImplementation(async (_p: string, body: unknown) => body)
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    // typed, not yet saved — the upload happens inside the debounce window
    await act(async () => { screen.getByText('edit kommandant').click() })
    await act(async () => { screen.getByText('upload').click() })
    expect(document.querySelector('output')?.textContent).toContain('Hptm Muster')
    expect(screen.queryByText('Gespeichert')).toBeNull()
    // …and the very next save carries it, together with the logo the server installed
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(sent().identity.kommandant).toBe('Hptm Muster')
    expect(sent().identity.assets).toEqual({ logo: '/logo.png' })
  })

  it('never reads «Gespeichert» while the server is refusing the document', async () => {
    apiPut.mockRejectedValue(new ApiError(
      422, 'map.defaultView.center: Input should be a valid list', undefined,
      [{ path: 'map.defaultView.center', msg: 'Input should be a valid list' }],
    ))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    expect(screen.queryByText('Gespeichert')).toBeNull()
    // the refusal is reported by FIELD, in the operator's language and under the name the page
    // gives it — not as the English Pydantic sentence a volunteer was shown
    expect(screen.getByText(/Vom Server nicht angenommen: Kartenzentrum \(Karte\)/)).toBeTruthy()
    expect(screen.queryByText(/Input should be a valid list/)).toBeNull()
  })

  it('sends the corrected value without waiting to be asked twice', async () => {
    // The half of the report that read as «the second coordinate never reaches the server»: the
    // autosave halted on the first refusal and then stayed halted, so everything typed
    // afterwards — including the value visible on screen — never left the browser again.
    apiPut.mockRejectedValueOnce(new ApiError(422, 'nope'))
    apiPut.mockImplementation(async (_p: string, body: unknown) => body)
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    expect(apiPut).toHaveBeenCalledTimes(1)
    await press('edit kommandant')
    expect(apiPut).toHaveBeenCalledTimes(2)
    expect(sent().identity.kommandant).toBe('Hptm Muster')
    expect(screen.getByText('Gespeichert')).toBeTruthy()
  })
})

// ⚠️ «Übernehmen» is the one button in Verwaltung that deliberately overwrites somebody else's
// work: the tab has a document from before the change, and pressing it re-sends that document on
// top of the newer one. The sentence that says so — «Neu laden zeigt den aktuellen Stand.
// «Übernehmen» schreibt die Änderungen dieser Seite darüber.» — was passed as `title=`, a hover
// tooltip, on a product whose target device is a tablet with no pointer to hover with. The only
// warning attached to the clobber was therefore unreachable exactly where it matters.
describe('Verwaltung autosave — the conflict says what «Übernehmen» costs, on screen', () => {
  const openConflict = async () => {
    apiPut.mockRejectedValue(new ApiError(409, 'Die Konfiguration wurde inzwischen geändert.'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await waitFor(() => expect(screen.getByText('Konfiguration wurde anderswo geändert')).toBeTruthy())
  }

  it('renders the warning as text, not as a tooltip nobody on a tablet can reach', async () => {
    await openConflict()
    const hint = screen.getByText(/schreibt die Änderungen dieser Seite darüber/)
    expect(hint).toBeTruthy()
    // …and it is really rendered, not sitting in an attribute of an ancestor
    expect(document.querySelector('.adm-autosave.warn')?.getAttribute('title')).toBeNull()
    expect(screen.getByRole('button', { name: 'Übernehmen' })).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The OTHER 409 (api/config · would_empty_sections). Both refusals carry the same status, and
// reading this one as «das Dokument hat sich bewegt» sent an operator to reload a page that was
// never stale — over a refusal no reload can clear, after an edit they had deliberately made
// (the last Formular row, the last Partnerorganisation, the cleared Hilfe-Einleitung). It is a
// question, and the answer re-sends the SAME document saying so.
describe('Verwaltung autosave — «würde Abschnitte leeren» asks instead of halting', () => {
  const A = appConfig.copy.admin.autosave

  /** The refusal, with the sections it names. */
  const wouldEmpty = (sections: string[]) => {
    const e = new ApiError(409, 'Diese Konfiguration würde 1 Abschnitt(e) leeren, die aktuell Inhalt haben: report.links.')
    e.code = 'would_empty_sections'
    e.data = { error: 'would_empty_sections', emptiedSections: sections, override: '?force=true' }
    return e
  }

  const ask = async (sections = ['report.links']) => {
    apiPut.mockRejectedValueOnce(wouldEmpty(sections))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await waitFor(() => expect(screen.getByText(A.emptyTitle)).toBeTruthy())
  }

  it('names the sections in the operator’s own words, and does not claim a conflict', async () => {
    await ask(['report.links'])
    // «Formulare (Rapport)», not «report.links» — the page's name for the thing, so it can be
    // found. And emphatically NOT the version-conflict banner: nothing moved on here.
    expect(screen.getByText(/Formulare/)).toBeTruthy()
    expect(screen.queryByText('Konfiguration wurde anderswo geändert')).toBeNull()
  })

  it('re-sends the SAME document with ?force=true on «Trotzdem leeren»', async () => {
    await ask()
    apiPut.mockImplementation(async (_p: string, body: unknown) => body)
    const refused = apiPut.mock.calls[0][1]

    await act(async () => { screen.getByRole('button', { name: A.emptyGo }).click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(apiPut).toHaveBeenCalledTimes(2)
    expect(apiPut.mock.calls[1][0]).toBe('/api/config?force=true')
    // the document that was refused, not a later draft — the answer is about THIS write
    expect(apiPut.mock.calls[1][1]).toEqual(refused)
    expect(screen.getByText('Gespeichert')).toBeTruthy()
  })

  it('⚠️ rolls the draft back on «Abbrechen», so the autosave does not walk into the same refusal', async () => {
    await ask()
    const before = document.querySelector('output')?.textContent

    await act(async () => { screen.getByRole('button', { name: appConfig.copy.admin.common2.cancel }).click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })

    // the edit is taken back — same document as the server holds, so nothing is sent again
    expect(document.querySelector('output')?.textContent).not.toBe(before)
    expect(document.querySelector('output')?.textContent).toContain('Wehr')
    expect(apiPut).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Gespeichert')).toBeTruthy()
  })

  it('asks ONCE — it does not re-send while the question is on screen', async () => {
    await ask()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(apiPut).toHaveBeenCalledTimes(1)
  })

  it('leaves a genuine version conflict exactly as it was', async () => {
    apiPut.mockRejectedValue(new ApiError(409, 'Die Konfiguration wurde inzwischen an anderer Stelle geändert.'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()

    await waitFor(() => expect(screen.getByText('Konfiguration wurde anderswo geändert')).toBeTruthy())
    expect(screen.queryByText(A.emptyTitle)).toBeNull()
  })
})
