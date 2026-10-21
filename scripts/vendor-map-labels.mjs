#!/usr/bin/env node
// Vendors the street/place labels the CARTO base draws as VECTOR text (21.10.2026, owner pick
// «C»: CARTO's raster tiles drop most street names at phone zoom, the vector labels do not).
//
// Writes two things, both committed:
//   src/data/cartoLabelLayers.json  the symbol layers of CARTO's Voyager GL style – the style
//       CARTO's own raster tiles are rendered from, so the names sit where the raster expects
//       them. Icons are dropped (no sprite), fonts are mapped onto the two glyph sets below.
//       Night reuses the same layers with its own paint (lib/basemapLabels).
//   public/fonts/<font>/<range>.pbf  Noto Sans Regular + Bold as MapLibre glyph ranges (OFL),
//       served from our own origin: the labels work offline, and CARTO's glyph server drew
//       them inverted under MapLibre.
//
// Re-run to refresh: `node scripts/vendor-map-labels.mjs`, then look at the diff.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
const GLYPHS = 'https://tiles.openfreemap.org/fonts'
const OFL = 'https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/main/OFL.txt'
// Latin, Latin-1, Extended-A/B, combining marks, Latin Extended Additional, punctuation (– ’ „):
// every character a Swiss street or place name uses. A range MapLibre asks for that is not here
// is answered with index.html by the SPA fallback, so the list must stay complete for the region.
const RANGES = ['0-255', '256-511', '512-767', '768-1023', '7680-7935', '8192-8447']
// our glyph folder ← the upstream font name
const FONTS = { 'NotoSans-Regular': 'Noto Sans Regular', 'NotoSans-Bold': 'Noto Sans Bold' }

async function get(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  return r
}

const style = await (await get(STYLE)).json()
const layers = style.layers
  .filter((l) => l.type === 'symbol')
  .map(({ source: _source, layout = {}, ...rest }) => {
    const kept = Object.fromEntries(Object.entries(layout).filter(([k]) => !k.startsWith('icon-')))
    // CARTO stacks Montserrat Medium / Open Sans Bold for the heavier names, Regular for the rest
    const heavy = /Medium|Bold/.test(String(layout['text-font']))
    kept['text-font'] = [heavy ? 'NotoSans-Bold' : 'NotoSans-Regular']
    // zoom stops without a `type` are exponential to MapLibre; said out loud, they match its types
    const size = kept['text-size']
    if (size && typeof size === 'object' && !Array.isArray(size) && !size.type) kept['text-size'] = { type: 'exponential', ...size }
    return { ...rest, layout: kept }
  })
writeFileSync(join(ROOT, 'src/data/cartoLabelLayers.json'), `${JSON.stringify(layers, null, 1)}\n`)
console.log(`cartoLabelLayers.json: ${layers.length} symbol layers`)

for (const [dir, upstream] of Object.entries(FONTS)) {
  mkdirSync(join(ROOT, 'public/fonts', dir), { recursive: true })
  for (const range of RANGES) {
    const body = Buffer.from(await (await get(`${GLYPHS}/${encodeURIComponent(upstream)}/${range}.pbf`)).arrayBuffer())
    writeFileSync(join(ROOT, 'public/fonts', dir, `${range}.pbf`), body)
  }
  console.log(`public/fonts/${dir}: ${RANGES.length} ranges`)
}
writeFileSync(join(ROOT, 'public/fonts/OFL.txt'), await (await get(OFL)).text())
