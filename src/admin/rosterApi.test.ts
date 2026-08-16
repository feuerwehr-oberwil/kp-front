import { describe, it, expect, vi, beforeEach } from 'vitest'

// The CSV import's REQUEST, not its screen. RosterView.test.tsx mocks this whole module away and
// asserts the component handed an array to a `vi.fn()` – which says nothing about the endpoint,
// the multipart field names, or how the decisions are encoded. A mock that cannot fail is not
// coverage: `upsertReferenceLayer` sent no `If-Match` for weeks under exactly that arrangement.
//
// The field names are load-bearing here, and asymmetrically so:
//
// * `file` → `file: UploadFile = File(...)` (backend/app/api/personnel.py · import_csv). A
//   mismatch is at least loud – FastAPI answers 422 and nothing is imported.
// * `decisions` → `decisions: str | None = Form(default=None)`, and that one is NOT loud. It has
//   a default, so a misnamed field arrives as «no decisions were made», the endpoint finds every
//   unknown rank value undecided and refuses the WHOLE file with 409, writing nothing – not the
//   people, not the ranks (backend/tests/test_roster_rank_mapping.py pins that all-or-nothing
//   refusal on the server side). The operator maps every Dienstgrad, presses «Importieren», and
//   is told the ranks are unmapped. There is no state in which «Mannschaft importieren» works.
//
// So these drive the REAL functions against a mocked transport, which is where the contract is.

const { apiUpload } = vi.hoisted(() => ({ apiUpload: vi.fn() }))
vi.mock('../lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  apiUpload,
}))

import { importRosterCsv, previewRosterCsv, type RosterRankDecision } from './rosterApi'

const csv = () => new File(['name,rank\nBerger Luca,Sdt\n'], 'mannschaft.csv', { type: 'text/csv' })

/** path / form / method of the last upload. */
const lastUpload = () => {
  const call = apiUpload.mock.calls[apiUpload.mock.calls.length - 1]
  return { path: call?.[0] as string, form: call?.[1] as FormData, method: call?.[2] as string | undefined }
}

beforeEach(() => {
  apiUpload.mockReset().mockResolvedValue(undefined)
})

describe('previewRosterCsv – the read-only step that must reach the preview route', () => {
  it('posts the file to /api/personnel/import-csv/preview under the field name `file`', async () => {
    const file = csv()
    await previewRosterCsv(file)
    const { path, form, method } = lastUpload()
    expect(path).toBe('/api/personnel/import-csv/preview')
    expect(form.get('file')).toBe(file)
    // apiUpload defaults to POST, and both import routes are @router.post
    expect(method).toBeUndefined()
  })

  it('sends nothing but the file – the preview writes nothing and decides nothing', async () => {
    await previewRosterCsv(csv())
    expect([...lastUpload().form.keys()]).toEqual(['file'])
  })
})

describe('importRosterCsv – the write, and the decisions that keep it from being refused', () => {
  it('posts to /api/personnel/import-csv', async () => {
    await importRosterCsv(csv())
    expect(lastUpload().path).toBe('/api/personnel/import-csv')
    expect(lastUpload().method).toBeUndefined()
  })

  it('sends the decisions as JSON under the field name `decisions`', async () => {
    // ⚠️ The name is the whole test. `decisions` has a server-side default, so a rename here is
    // answered with 409 «Unbekannte Grade in der Datei» rather than a 422 – the import never
    // works and never says why.
    const decisions: RosterRankDecision[] = [
      { value: 'Sdt', action: 'map', rank: 'fwm' },
      { value: 'Wm', action: 'adopt' },
      { value: 'Zugf', action: 'skip' },
    ]
    await importRosterCsv(csv(), decisions)
    const { form } = lastUpload()
    expect([...form.keys()].sort()).toEqual(['decisions', 'file'])
    const raw = form.get('decisions')
    expect(typeof raw).toBe('string')
    // a JSON array of objects, verbatim – `_decisions()` feeds it straight to a
    // TypeAdapter(list[RosterRankDecision]) and answers 422 on anything else
    expect(JSON.parse(raw as string)).toEqual(decisions)
  })

  it('keeps the value spelled the way the file spells it', async () => {
    // the server normalises («Sdt» and «sdt» are one decision); the browser must not, or a
    // decision would stop matching the group the preview showed
    await importRosterCsv(csv(), [{ value: ' Sdt ', action: 'adopt' }])
    expect(JSON.parse(lastUpload().form.get('decisions') as string)[0].value).toBe(' Sdt ')
  })

  it('omits the field entirely when nothing had to be decided', async () => {
    await importRosterCsv(csv())
    expect([...lastUpload().form.keys()]).toEqual(['file'])
    expect(lastUpload().form.get('decisions')).toBeNull()
  })
})
