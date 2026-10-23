import { afterEach, describe, expect, it, vi } from 'vitest'
import { heldPicture, holdPicture, resetHeldPictures } from './heldPictures'

describe('heldPictures', () => {
  afterEach(() => { resetHeldPictures(); vi.unstubAllGlobals() })

  it('answers the asset URL until its bytes are held, then the blob URL – fetched once', async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(['x'], { type: 'image/jpeg' })))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:held')
    const url = '/api/reference/checklists:a:p1?v=2'
    expect(heldPicture(url)).toBe(url)
    holdPicture(url)
    holdPicture(url)
    await vi.waitFor(() => expect(heldPicture(url)).toBe('blob:held'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the asset URL when the fetch fails, and tries again', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const url = '/api/reference/checklists:a:p1'
    holdPicture(url)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(heldPicture(url)).toBe(url)
    holdPicture(url)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
