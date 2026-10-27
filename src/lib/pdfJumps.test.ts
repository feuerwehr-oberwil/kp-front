import { describe, expect, it } from 'vitest'
import { activeJump, pdfJumps, type OutlineSource } from './pdfJumps'

// A stub of the pdf.js proxy: refs are `{num}` objects, named destinations a lookup table.
const ref = (num: number) => ({ num, gen: 0 })
const doc = (numPages: number, outline: Awaited<ReturnType<OutlineSource['getOutline']>>, named: Record<string, unknown[]> = {}): OutlineSource => ({
  numPages,
  getOutline: async () => outline,
  getDestination: async (id) => named[id] ?? null,
  getPageIndex: async (r: never) => (r as { num: number }).num - 100,
})

describe('pdfJumps · the reader strip', () => {
  it('lists the top-level bookmarks with their pages – explicit and named destinations alike', async () => {
    const jumps = await pdfJumps(doc(4, [
      { title: 'Erdgeschoss', dest: [ref(100), { name: 'Fit' }] },
      { title: ' 1. OG ', dest: 'og1' },
      { title: 'Untergeschoss', dest: [3] },
    ], { og1: [ref(102), { name: 'XYZ' }] }))
    expect(jumps).toEqual([{ title: 'Erdgeschoss', page: 0 }, { title: '1. OG', page: 2 }, { title: 'Untergeschoss', page: 3 }])
  })

  it('drops bookmarks that lead nowhere, and falls back to pages when none is left', async () => {
    const broken = doc(3, [{ title: 'Web', dest: null }, { title: 'Weg', dest: 'missing' }, { title: 'Aus', dest: [ref(900)] }])
    expect(await pdfJumps(broken)).toEqual([{ page: 0 }, { page: 1 }, { page: 2 }])
  })

  it('has nothing to offer on a single page without bookmarks', async () => {
    expect(await pdfJumps(doc(1, null))).toEqual([])
  })

  it('marks the last stop at or above the page being read, none above the first', () => {
    const jumps = [{ page: 1, title: 'EG' }, { page: 3, title: 'OG' }]
    expect(activeJump(jumps, 0)).toBe(-1)
    expect(activeJump(jumps, 2)).toBe(0)
    expect(activeJump(jumps, 4)).toBe(1)
  })
})
