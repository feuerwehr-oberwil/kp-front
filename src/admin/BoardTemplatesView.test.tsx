// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

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

import { BoardTemplatesView } from './BoardTemplatesView'
import { BUNDLED_TEMPLATES } from '../lib/boardTemplates'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.boardTemplates
const ds = (id: string) => ({ id, object_id: null, module: null, kind: 'tafel', title: id, source_type: 'uploaded', source_note: null, content_type: 'application/json', size_bytes: 100, feature_count: null, current_version: 2, updated_at: '2026-10-10T10:00:00Z' })
const FKS = BUNDLED_TEMPLATES[0]

afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks() })

describe('Tafel-Vorlagen in /admin', () => {
  it('lists the station’s templates with their pages, and nothing else from the registry', async () => {
    apiGet.mockImplementation(async (p: string) => (p === '/api/reference' ? [ds('tafel:fks-erste-fuehrung'), ds('checklists:fu')] : FKS))
    render(<BoardTemplatesView />)
    await screen.findByText('FKS – Erste Führung')
    expect(screen.getByText('fks-erste-fuehrung')).toBeTruthy()
    expect(screen.getByText(String(FKS.pages.length))).toBeTruthy()
    expect(screen.queryByText('checklists:fu')).toBeNull()
  })
  it('with none stored it says the bundled FKS set is what the Tafel offers, and hands it out', async () => {
    apiGet.mockResolvedValue([])
    render(<BoardTemplatesView />)
    await screen.findByText(C.none)
    fireEvent.click(screen.getByText(C.example))
    expect(downloadBlob.mock.calls[0][1]).toBe('fks-erste-fuehrung.json')
  })
  it('uploads a valid file to tafel:<its id>, and refuses one that is not a board template', async () => {
    apiGet.mockResolvedValue([])
    apiUpload.mockResolvedValue(ds('tafel:oberwil'))
    render(<BoardTemplatesView />)
    await screen.findByText(C.none)
    fireEvent.click(screen.getByText(C.upload))
    const input = () => document.querySelector<HTMLInputElement>('input[accept*="json"]')!
    fireEvent.change(input(), { target: { files: [new File(['{"id":"x"}'], 'x.json', { type: 'application/json' })] } })
    await screen.findByText(C.notTemplate)
    fireEvent.change(input(), { target: { files: [new File([JSON.stringify({ ...FKS, id: 'oberwil' })], 'o.json', { type: 'application/json' })] } })
    await screen.findByText('tafel:oberwil')
    fireEvent.click(screen.getByText(C.uploadConfirm))
    await waitFor(() => expect(apiUpload).toHaveBeenCalled())
    expect(apiUpload.mock.calls[0][0]).toBe('/api/reference/tafel%3Aoberwil')
  })
  it('deletes through the prune door with a KEEP list', async () => {
    apiGet.mockImplementation(async (p: string) => (p === '/api/reference' ? [ds('tafel:a'), ds('tafel:b'), ds('checklists:fu')] : { ...FKS, id: p.slice(-1) }))
    apiPost.mockResolvedValue({ pruned: ['tafel:a'] })
    render(<BoardTemplatesView />)
    await screen.findByText('a')
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`a – ${C.colActions}`) })[0])
    fireEvent.click(await screen.findByText(C.delete))
    const confirm = await screen.findAllByRole('button', { name: C.delete })
    fireEvent.click(confirm[confirm.length - 1])
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/reference/tafel/prune', ['tafel:b']))
  })
})
