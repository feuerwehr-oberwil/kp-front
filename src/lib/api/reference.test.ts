import { describe, expect, it } from 'vitest'
import { referenceUrl } from './reference'

// A Modul-PDF is REPLACED in place: `store_plan` writes new bytes and bumps `current_version`,
// but the dataset id — and so the URL — stays the same. Three caches key on that URL (the
// service worker's `reference-data` entry, pdf.js' document cache, the bitmap cache), so a
// re-uploaded plan kept rendering the sheet it replaced. The version is the cache key.
describe('referenceUrl', () => {
  it('carries the version when one is given', () => {
    expect(referenceUrl('plan:abc:modul1', 3)).toBe('/api/reference/plan%3Aabc%3Amodul1?v=3')
    // a fresh upload is a DIFFERENT url — which is the whole mechanism
    expect(referenceUrl('plan:abc:modul1', 4)).not.toBe(referenceUrl('plan:abc:modul1', 3))
  })

  it('stays bare without one — geojson/symbols are fetched by id and revalidate normally', () => {
    expect(referenceUrl('geo:hydrant')).toBe('/api/reference/geo%3Ahydrant')
    expect(referenceUrl('symbols:tactical')).toBe('/api/reference/symbols%3Atactical')
  })

  it('version 0 is a version, not «no version»', () => {
    expect(referenceUrl('plan:abc:modul1', 0)).toBe('/api/reference/plan%3Aabc%3Amodul1?v=0')
  })
})
