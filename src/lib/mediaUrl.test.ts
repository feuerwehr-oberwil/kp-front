import { describe, expect, it } from 'vitest'
import { thumbUrl } from './mediaUrl'

describe('thumbUrl', () => {
  it('asks for the small copy of a stored photo', () => {
    expect(thumbUrl('/api/media/6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'))
      .toBe('/api/media/6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f/thumb')
  })

  // a picture taken offline is a blob: URL until its upload lands — the row must show it now
  it('leaves a local blob URL alone', () => {
    expect(thumbUrl('blob:https://front.example/9a8b7c')).toBe('blob:https://front.example/9a8b7c')
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
