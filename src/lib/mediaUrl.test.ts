import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetLocalThumb, mintLocalThumb, safeHref, thumbUrl } from './mediaUrl'
import { localThumb } from './imagePrep'

// the decode itself is imagePrep's business (and jsdom has no canvas); here it either hands back
// a small blob or refuses, and the map on this side is what is under test
vi.mock('./imagePrep', () => ({ localThumb: vi.fn() }))

// what may become an href at all — the render-side half of the media-URL validation
describe('safeHref', () => {
  it('passes the app\'s own paths and written-out http(s) addresses', () => {
    expect(safeHref('/api/media/abc')).toBe('/api/media/abc')
    expect(safeHref('/api/media/abc?name=Plan.pdf')).toBe('/api/media/abc?name=Plan.pdf')
    expect(safeHref('https://example.org/merkblatt.pdf')).toBe('https://example.org/merkblatt.pdf')
    expect(safeHref('HTTP://example.org/a')).toBe('HTTP://example.org/a')
  })

  it('rejects every non-http scheme', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,<script>1</script>')).toBeUndefined()
    expect(safeHref('blob:https://front.example/9a8b7c')).toBeUndefined()
    expect(safeHref('vbscript:msgbox(1)')).toBeUndefined()
  })

  it('rejects a scheme smuggled behind whitespace or control characters', () => {
    // the URL parser strips these exactly like the browser resolving the href would —
    // which is why the judgement is a parse, not a startsWith
    expect(safeHref(' javascript:alert(1)')).toBeUndefined()
    expect(safeHref('\u0001javascript:alert(1)')).toBeUndefined()
    expect(safeHref('java\tscript:alert(1)')).toBeUndefined()
    expect(safeHref('java\nscript:alert(1)')).toBeUndefined()
  })

  it('rejects a «relative» URL that names its own host', () => {
    expect(safeHref('//evil.example/x')).toBeUndefined()
    expect(safeHref('/\\evil.example/x')).toBeUndefined() // «\» acts as «/» in an href
  })

  it('rejects what is not a path, and the absent URL', () => {
    expect(safeHref('foto.jpg')).toBeUndefined() // resolves against the page — unpredictable
    expect(safeHref('#top')).toBeUndefined()
    expect(safeHref(undefined)).toBeUndefined()
    expect(safeHref('')).toBeUndefined()
  })
})

describe('thumbUrl', () => {
  it('asks for the small copy of a stored photo', () => {
    expect(thumbUrl('/api/media/6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'))
      .toBe('/api/media/6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f/thumb')
  })

  it('lets other media-store shapes and https images pass', () => {
    expect(thumbUrl('https://example.org/foto.jpg')).toBe('https://example.org/foto.jpg')
    expect(thumbUrl('/api/media/abc/peaks')).toBe('/api/media/abc/peaks')
  })

  it('resolves a row-supplied URL outside the media store to NOTHING — not to a fetch', () => {
    // every open device paints this URL into an <img>; passed through, a poisoned row makes the
    // whole crew's devices call an attacker's address (IP beacon) or renders a data: payload
    expect(thumbUrl('javascript:alert(1)')).toBeUndefined()
    expect(thumbUrl('data:image/png;base64,AAA')).toBeUndefined()
    expect(thumbUrl('http://evil.example/beacon.gif')).toBeUndefined()
    expect(thumbUrl('//evil.example/beacon.gif')).toBeUndefined()
    expect(thumbUrl('/logo.png')).toBeUndefined()
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
