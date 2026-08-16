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

import { ChecklistsView } from './ChecklistsView'

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
