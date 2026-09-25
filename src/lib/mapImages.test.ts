import { describe, expect, it } from 'vitest'
import { POINT_ICON_PX, pointIconRegistry, pointIconVariants, type ImageDataLike, type MapImageHost } from './mapImages'

/** A map that records what happened to its images — enough of MapLibre for the registry. */
function fakeMap() {
  const images = new Map<string, unknown>()
  const log: string[] = []
  const host: MapImageHost = {
    hasImage: (id) => images.has(id),
    addImage: (id, img) => { images.set(id, img); log.push(`add ${id}`) },
    updateImage: (id, img) => { images.set(id, img); log.push(`update ${id}`) },
    triggerRepaint: () => {},
  }
  return { host, images, log }
}

const decoded = (tag: string): ImageDataLike & { tag: string } =>
  ({ tag, width: POINT_ICON_PX, height: POINT_ICON_PX, data: new Uint8Array(POINT_ICON_PX * POINT_ICON_PX * 4) })

const SVG = '<svg viewBox="0 0 10 10"><circle fill="#000000" r="4"/></svg>'
const LAYERS = [
  { id: 'lk-hydrant', vectorKind: 'point', symbol: 'Hydrant', color: '#0055ff', nightColor: '#66aaff' },
  { id: 'lk-line', vectorKind: 'line', color: '#ff0000' },
  { id: 'lk-plain', vectorKind: 'point' }, // no symbol: drawn as a circle, asks for no image
]

describe('pointIconVariants — the images the Leitungskataster layers will ask for', () => {
  it('one tinted variant per point layer with a known symbol, plus its night twin', () => {
    const v = pointIconVariants(LAYERS, { Hydrant: SVG })
    expect(v.map((x) => x.id)).toEqual(['icon-lk-hydrant', 'icon-lk-hydrant-night'])
    expect(v[0].svg).toContain('#0055ff')
    expect(v[1].svg).toContain('#66aaff')
    expect(v[0].svg).toContain(`width="${POINT_ICON_PX}"`)
  })

  it('nothing for a symbol the pack does not know yet', () => {
    expect(pointIconVariants(LAYERS, {})).toEqual([])
  })
})

describe('pointIconRegistry — no icon is ever asked for in vain', () => {
  it('answers `styleimagemissing` synchronously with a same-size stand-in, then swaps the picture in', async () => {
    const { host, images, log } = fakeMap()
    let resolve!: (img: ImageDataLike) => void
    const reg = pointIconRegistry(host, () => new Promise((r) => { resolve = r }))
    reg.sync(pointIconVariants(LAYERS, { Hydrant: SVG }).slice(0, 1))
    // the tile asks before the decode is done (the race that logged «could not be loaded»)
    expect(reg.answerMissing('icon-lk-hydrant')).toBe(true)
    const stand = images.get('icon-lk-hydrant') as ImageDataLike
    expect([stand.width, stand.height]).toEqual([POINT_ICON_PX, POINT_ICON_PX])
    resolve(decoded('hydrant'))
    await Promise.resolve(); await Promise.resolve()
    expect((images.get('icon-lk-hydrant') as { tag: string }).tag).toBe('hydrant')
    // updateImage (same dimensions), never a second addImage for the same id
    expect(log).toEqual(['add icon-lk-hydrant', 'update icon-lk-hydrant'])
  })

  it('answers an icon it has no picture for yet (the symbol pack still loading) and fills it later', async () => {
    const { host, images } = fakeMap()
    const reg = pointIconRegistry(host, async () => decoded('late'))
    expect(reg.answerMissing('icon-lk-hydrant')).toBe(true)
    expect(images.has('icon-lk-hydrant')).toBe(true)
    reg.sync(pointIconVariants(LAYERS, { Hydrant: SVG }))
    await new Promise((r) => setTimeout(r, 0))
    expect((images.get('icon-lk-hydrant') as { tag: string }).tag).toBe('late')
    expect((images.get('icon-lk-hydrant-night') as { tag: string }).tag).toBe('late')
  })

  it('leaves other image families to their own handlers', () => {
    const { host } = fakeMap()
    const reg = pointIconRegistry(host, async () => decoded('x'))
    expect(reg.answerMissing('draw-arrow')).toBe(false)
    expect(reg.answerMissing('hatch-ff0000')).toBe(false)
  })

  it('a registered picture is not decoded again on every layer change', async () => {
    const { host } = fakeMap()
    let decodes = 0
    const reg = pointIconRegistry(host, async () => { decodes++; return decoded('d') })
    const v = pointIconVariants(LAYERS, { Hydrant: SVG })
    reg.sync(v)
    await new Promise((r) => setTimeout(r, 0))
    reg.sync(v)
    reg.sync([...v])
    await new Promise((r) => setTimeout(r, 0))
    expect(decodes).toBe(2) // day + night, once each
  })

  it('does nothing after dispose — the map may be gone when a decode lands', async () => {
    const { host, log } = fakeMap()
    let resolve!: (img: ImageDataLike) => void
    const reg = pointIconRegistry(host, () => new Promise((r) => { resolve = r }))
    reg.sync(pointIconVariants(LAYERS, { Hydrant: SVG }).slice(0, 1))
    reg.dispose()
    resolve(decoded('late'))
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toEqual([])
  })
})
