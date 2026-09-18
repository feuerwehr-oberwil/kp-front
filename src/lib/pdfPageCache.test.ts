// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { cachedPdfPage, dropPdfPages, keepPdfPage, pdfPageKey, pdfPageKeyOf, pdfPagesResident } from './pdfPageCache'

const bitmap = (w: number, h: number) => ({ width: w, height: h, close: () => {} }) as unknown as ImageBitmap

describe('pdfPageKey', () => {
  it('names document, page and the width the page was laid out at', () => {
    expect(pdfPageKey('/api/reference/plan%3Ax?v=2#page=3', 2, 640)).toBe('/api/reference/plan%3Ax?v=2@640#2')
  })

  it('rounds the width — a sub-pixel measurement must not mint a second copy', () => {
    expect(pdfPageKey('/p.pdf', 1, 640.4)).toBe(pdfPageKey('/p.pdf', 1, 640))
  })

  it('separates zoom levels and revisions', () => {
    expect(pdfPageKey('/p.pdf?v=1', 1, 640)).not.toBe(pdfPageKey('/p.pdf?v=1', 1, 1280))
    expect(pdfPageKey('/p.pdf?v=1', 1, 640)).not.toBe(pdfPageKey('/p.pdf?v=2', 1, 640))
  })

  it('recognises every key of one document, whatever page or width', () => {
    expect(pdfPageKeyOf(pdfPageKey('/p.pdf?v=1', 4, 900), '/p.pdf?v=1#page=2')).toBe(true)
    expect(pdfPageKeyOf(pdfPageKey('/p.pdf?v=1', 4, 900), '/p.pdf?v=2')).toBe(false)
  })
})

describe('the kept rasters', () => {
  it('serves a page back and forgets a whole document on demand', async () => {
    const key = pdfPageKey('/keep.pdf?v=1', 1, 500)
    keepPdfPage(key, Promise.resolve(bitmap(10, 10)))
    await cachedPdfPage(key)
    expect(pdfPagesResident()).toBe(10 * 10 * 4)
    expect(await cachedPdfPage(key)).toMatchObject({ width: 10 })
    dropPdfPages('/keep.pdf?v=1#page=1')
    expect(cachedPdfPage(key)).toBeUndefined()
    expect(pdfPagesResident()).toBe(0)
  })

  it('drops a failed snapshot instead of replaying it', async () => {
    const key = pdfPageKey('/fail.pdf?v=1', 1, 500)
    keepPdfPage(key, Promise.reject(new Error('no bitmap')))
    await cachedPdfPage(key)?.catch(() => null)
    expect(cachedPdfPage(key)).toBeUndefined()
  })
})
