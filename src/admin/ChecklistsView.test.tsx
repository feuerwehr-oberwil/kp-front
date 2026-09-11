// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

// The whole chain is under test — the view, the thin client and the payload it builds — so only
// the HTTP layer is mocked. What the page sends to `/api/reference/checklists/prune` IS the
// behaviour: a keep-list, never a delete-list.
const apiGet = vi.fn()
const apiPost = vi.fn()
const apiUpload = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    apiGet: (p: string) => apiGet(p),
    apiPost: (p: string, b: unknown) => apiPost(p, b),
    apiUpload: (p: string, f: FormData, m?: string) => apiUpload(p, f, m),
  }
})

const downloadBlob = vi.fn()
vi.mock('../lib/download', () => ({ downloadBlob: (b: Blob, n: string) => downloadBlob(b, n) }))

import { ChecklistsView } from './ChecklistsView'
import { parseChecklistTemplate } from './stationDataApi'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

const C = appConfig.copy.admin.checklists

const ds = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  object_id: null,
  module: null,
  kind: 'checklists',
  title: id.startsWith('checklists:fu') ? 'Aufgaben FU' : id,
  source_type: 'uploaded',
  source_note: null,
  content_type: 'application/json',
  size_bytes: 100,
  feature_count: null,
  current_version: 1,
  updated_at: '2026-08-16T10:00:00Z',
  ...over,
})

const REGISTRY = [
  ds('checklists:fu-aktion'),
  ds('checklists:el-playbook', { title: 'EL-Checklisten' }),
  ds('checklists:el-playbook:p12', { content_type: 'image/jpeg' }),
  ds('geo:hydrant', { kind: 'geojson' }),
]

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  apiGet.mockResolvedValue(REGISTRY)
})

const template = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'fu-aktion',
    kind: 'action',
    title: 'Aufgaben FU',
    version: 2,
    source: 'Checklisten FU.pdf',
    phases: [{ id: 'p1', title: 'Erkundung', items: [{ id: 'i1', text: 'Lage erkunden' }] }],
    ...over,
  })

const jsonInput = () => document.querySelector<HTMLInputElement>('input[accept*="json"]') as HTMLInputElement

describe('Checklisten — the list', () => {
  it('shows one row per template with its diagram count, and ignores non-checklist datasets', async () => {
    render(<ChecklistsView />)
    await screen.findByText('Aufgaben FU')
    expect(screen.getByText('EL-Checklisten')).toBeTruthy()
    expect(screen.queryByText('geo:hydrant')).toBeNull()
    // el-playbook carries one diagram; fu-aktion none
    expect(screen.getByText('el-playbook')).toBeTruthy()
  })
})

describe('Checklisten — what a row says about itself', () => {
  // Bastian's complaint: «some pdfs, some other random things and nothing clearly labelled
  // where it's from». Both facts come off the registry the table already holds.
  it('names the file type and the door each template came through', async () => {
    render(<ChecklistsView />)
    await screen.findByText('Aufgaben FU')
    // `kind` is the constant 'checklists' for every row here — the content type is the fact
    expect(screen.getAllByText('JSON').length).toBe(2)
    // the same provenance badge the Objektpläne page wears
    expect(screen.getAllByText('Hand-Upload').length).toBe(2)
  })

  it('gives a diagram without a template a labelled row, not a bare id', async () => {
    apiGet.mockResolvedValue([...REGISTRY, ds('checklists:geloescht:p3', { content_type: 'image/png' })])
    render(<ChecklistsView />)
    await screen.findByText(/1 Diagramme ohne Vorlage/)
    // the template it was filed under, which page it is, and what kind of file
    expect(screen.getByText('geloescht')).toBeTruthy()
    expect(screen.getByText('Seite 3')).toBeTruthy()
    expect(screen.getByText('PNG')).toBeTruthy()
  })
})

describe('Checklisten — deleting, because uploading alone leaves ghosts', () => {
  it('prunes to a keep-list built from a fresh read, sparing every other checklist', async () => {
    apiPost.mockResolvedValue({ pruned: ['checklists:el-playbook', 'checklists:el-playbook:p12'] })
    render(<ChecklistsView />)
    await screen.findByText('EL-Checklisten')

    fireEvent.click(screen.getByRole('button', { name: 'EL-Checklisten löschen' }))

    // the confirm names every dataset that goes — the template AND its diagrams
    await screen.findByText('checklists:el-playbook')
    expect(screen.getByText('checklists:el-playbook:p12')).toBeTruthy()

    apiGet.mockClear()
    // the sheet's own confirm button, not the row's — both read «Löschen»
    fireEvent.click(document.querySelector('.ip-actions .ip-btn-danger') as HTMLButtonElement)

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    // re-read at delete time, so a template uploaded from another tab meanwhile is not collateral
    expect(apiGet).toHaveBeenCalledWith('/api/reference')
    expect(apiPost).toHaveBeenCalledWith('/api/reference/checklists/prune', ['checklists:fu-aktion'])
  })
})

describe('Checklisten — the examples to start from', () => {
  // «Vorlage hochladen» on an empty page asks for a file format nobody has ever seen. The
  // examples close that loop — and the loop only closes if what comes down is a file this very
  // page would accept back, so each is round-tripped through the upload's own validator.
  //
  // ⚠️ BOTH shapes, and that is the point of the table: an Aufgabenliste is `phases[].items[]`
  // and a Merkblatt `entries[].content[]`. Whoever edits data/checklists/generic-action.json or
  // generic-reference.json must see this fail rather than ship an example the page refuses.
  const examples = [
    { kind: 'action', label: C.kindAction, file: 'checklisten-vorlage-aufgaben.json' },
    { kind: 'reference', label: C.kindReference, file: 'checklisten-vorlage-nachschlagen.json' },
  ] as const

  for (const ex of examples) {
    it(`hands out a ${ex.kind} template the upload accepts`, async () => {
      render(<ChecklistsView />)
      await screen.findByText('Aufgaben FU')

      fireEvent.click(screen.getByRole('button', {
        name: fillTemplate(C.exampleDownloadKind, { kind: ex.label }),
      }))

      expect(downloadBlob).toHaveBeenCalledTimes(1)
      const [blob, name] = downloadBlob.mock.calls[0] as [Blob, string]
      expect(name).toBe(ex.file)
      const parsed = parseChecklistTemplate(await blob.text(), C)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value.kind).toBe(ex.kind)
    })
  }
})

describe('Checklisten — the card head is the house style', () => {
  // One card, one head, and the order the job is done in: what you START FROM first, what you
  // SEND BACK last. The page used to be two cards, and the upload sat beside the example in the
  // body of the first one.
  it('puts both examples before the upload, and makes only the upload primary', async () => {
    render(<ChecklistsView />)
    await screen.findByText('Aufgaben FU')

    expect(document.querySelectorAll('.adm-card')).toHaveLength(1)
    const acts = [...document.querySelectorAll<HTMLButtonElement>('.adm-card-act button')]
    expect(acts.map((b) => b.textContent)).toEqual([
      fillTemplate(C.exampleDownloadKind, { kind: C.kindAction }),
      fillTemplate(C.exampleDownloadKind, { kind: C.kindReference }),
      C.upload,
    ])
    expect(acts.filter((b) => b.className.includes('adm-save-btn'))).toHaveLength(1)
    expect(acts[2].className).toContain('adm-save-btn')
  })
})

describe('Checklisten — uploading a template', () => {
  it('refuses a malformed template before the round trip and says which field', async () => {
    render(<ChecklistsView />)
    await screen.findByText('Aufgaben FU')
    fireEvent.click(screen.getByRole('button', { name: 'Vorlage hochladen' }))

    const bad = new File([template({ title: '  ' })], 'fu.json', { type: 'application/json' })
    fireEvent.change(jsonInput(), { target: { files: [bad] } })

    expect(await screen.findByText(/Feld «title» fehlt/)).toBeTruthy()
    expect(apiUpload).not.toHaveBeenCalled()
  })

  it('says up front that a known id REPLACES, and writes under checklists:<id>', async () => {
    apiUpload.mockResolvedValue(ds('checklists:fu-aktion', { current_version: 2 }))
    render(<ChecklistsView />)
    await screen.findByText('Aufgaben FU')
    fireEvent.click(screen.getByRole('button', { name: 'Vorlage hochladen' }))

    const good = new File([template({ order: 5 })], 'fu-aktion.json', { type: 'application/json' })
    fireEvent.change(jsonInput(), { target: { files: [good] } })

    expect(await screen.findByText(/Ersetzt «Aufgaben FU»/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hochladen' }))

    await waitFor(() => expect(apiUpload).toHaveBeenCalledTimes(1))
    expect(apiUpload.mock.calls[0][0]).toBe('/api/reference/checklists%3Afu-aktion')
    expect(apiUpload.mock.calls[0][2]).toBe('PUT')
    // the rail order is stamped into the uploaded copy, exactly like admin_checklists does —
    // and the file's own `order` is what the field is prefilled with
    const sent = apiUpload.mock.calls[0][1] as FormData
    const written = JSON.parse(await (sent.get('file') as Blob).text())
    expect(written.order).toBe(5)
    expect(written.id).toBe('fu-aktion')
  })
})
