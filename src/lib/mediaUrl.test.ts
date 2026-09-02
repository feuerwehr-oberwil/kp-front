import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetLocalThumb, mintLocalThumb, thumbUrl } from './mediaUrl'
import { localThumb } from './imagePrep'

// the decode itself is imagePrep's business (and jsdom has no canvas); here it either hands back
// a small blob or refuses, and the map on this side is what is under test
vi.mock('./imagePrep', () => ({ localThumb: vi.fn() }))

describe('thumbUrl', () => {
  it('asks for the small copy of a stored photo', () => {
    expect(thumbUrl('/api/media/6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'))
      .toBe('/api/media/6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f/thumb')
  })

  it('leaves anything that is not a stored media URL alone', () => {
    expect(thumbUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
    expect(thumbUrl('https://example.org/foto.jpg')).toBe('https://example.org/foto.jpg')
    expect(thumbUrl('/api/media/abc/peaks')).toBe('/api/media/abc/peaks')
  })

  it('does not ask for a thumbnail of a thumbnail', () => {
    const t = thumbUrl('/api/media/6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f')
    expect(thumbUrl(t)).toBe(t)
  })

  it('keeps a query string on the far side of the suffix', () => {
    expect(thumbUrl('/api/media/6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f?name=Ausweis.jpg'))
      .toBe('/api/media/6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f/thumb?name=Ausweis.jpg')
  })

  it('passes an absent URL straight through', () => {
    expect(thumbUrl(undefined)).toBeUndefined()
  })
})

// a picture taken offline is a blob: URL until its upload lands — the chip shows the session
// thumbnail, and NEVER the full camera file (the decode that killed the tab)
describe('session thumbnails for blob: URLs', () => {
  const full = 'blob:https://front.example/9a8b7c'
  let minted = 0
  let revoked: string[] = []

  beforeEach(() => {
    minted = 0
    revoked = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:https://front.example/thumb-${++minted}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => { revoked.push(u) })
    vi.mocked(localThumb).mockResolvedValue(new Blob(['tiny'], { type: 'image/jpeg' }))
  })
  afterEach(() => { forgetLocalThumb(full); vi.restoreAllMocks() })

  it('shows nothing for a blob URL until its thumbnail exists', () => {
    expect(thumbUrl(full)).toBeUndefined()
  })

  it('resolves to the minted thumbnail, and to nothing again once forgotten', async () => {
    await mintLocalThumb(full, new Blob(['photo']))
    expect(thumbUrl(full)).toBe('blob:https://front.example/thumb-1')
    forgetLocalThumb(full)
    expect(thumbUrl(full)).toBeUndefined()
    expect(revoked).toEqual(['blob:https://front.example/thumb-1'])
  })

  it('a second mint for the same picture revokes the first thumbnail', async () => {
    await mintLocalThumb(full, new Blob(['photo']))
    await mintLocalThumb(full, new Blob(['photo']))
    expect(thumbUrl(full)).toBe('blob:https://front.example/thumb-2')
    expect(revoked).toEqual(['blob:https://front.example/thumb-1'])
  })

  it('a picture the browser cannot decode gets no thumbnail and no error', async () => {
    vi.mocked(localThumb).mockRejectedValue(new Error('decode failed'))
    await expect(mintLocalThumb(full, new Blob(['heic?']))).resolves.toBeUndefined()
    expect(thumbUrl(full)).toBeUndefined()
  })

  it('forgetting a URL that never had a thumbnail is a no-op', () => {
    forgetLocalThumb('blob:https://front.example/never')
    expect(revoked).toEqual([])
  })
})
