import { beforeEach, describe, expect, it, vi } from 'vitest'
const { apiGet, idbGet, idbSet } = vi.hoisted(() => ({ apiGet: vi.fn(), idbGet: vi.fn(), idbSet: vi.fn() }))
vi.mock('../api', () => ({ apiGet, apiPut: vi.fn(), apiUpload: vi.fn(), ApiError: class extends Error {} }))
vi.mock('../idb', () => ({ idbGet, idbSet }))
import { getApprovedPlanAlignments } from './reference'

const metadata = { dataset_id: 'pdf:house', plan_version: 3, revision_url: '/api/reference/pdf%3Ahouse?v=3', alignments: [] }
beforeEach(() => { vi.resetAllMocks(); idbSet.mockResolvedValue(true) })

describe('approved alignment offline metadata', () => {
  it('fetches and caches the exact PDF revision', async () => {
    apiGet.mockResolvedValue(metadata)
    expect(await getApprovedPlanAlignments('pdf:house', 3)).toEqual(metadata)
    expect(apiGet).toHaveBeenCalledWith('/api/reference/pdf%3Ahouse/alignments?v=3')
    expect(idbSet).toHaveBeenCalledWith('plan-alignments:pdf:house:3', metadata)
  })
  it('uses that revision cache offline and does not fabricate no-approval when it is absent', async () => {
    apiGet.mockRejectedValue(new Error('offline'))
    idbGet.mockResolvedValue(metadata)
    expect(await getApprovedPlanAlignments('pdf:house', 3)).toEqual(metadata)
    idbGet.mockResolvedValue(null)
    await expect(getApprovedPlanAlignments('pdf:house', 4)).rejects.toThrow('offline')
    expect(idbGet).toHaveBeenLastCalledWith('plan-alignments:pdf:house:4')
  })

  it.each(['rejected', 'false'])('keeps the fresh response when cache persistence returns %s', async (failure) => {
    apiGet.mockResolvedValue(metadata) // no approved alignments after the server withdrew one
    idbGet.mockResolvedValue({ ...metadata, alignments: [{ id: 1, approval_id: 2 }] })
    if (failure === 'rejected') idbSet.mockRejectedValue(new Error('storage unavailable'))
    else idbSet.mockResolvedValue(false)
    expect(await getApprovedPlanAlignments('pdf:house', 3)).toEqual(metadata)
    expect(idbGet).not.toHaveBeenCalled()
  })
})
