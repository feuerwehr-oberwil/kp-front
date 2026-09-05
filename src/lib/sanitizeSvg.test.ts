// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeSvg, sanitizeSvgResult } from './sanitizeSvg'

// SEC-01 · `Entity.symbolSvg` is editor-supplied free text rendered through
// `dangerouslySetInnerHTML` (lib/symbolRender). This is the authoritative XSS gate: it parses the
// markup with the browser's DOMParser and keeps only static tactical-glyph SVG. These tests pin
// the vectors the reviewers called out, and confirm a legitimate glyph survives untouched.

// sanitizeSvg returns a complete <svg> document, so parse it directly; querySelectorAll('*') on the
// root returns the descendants (the root svg itself is excluded).
const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
const attrNames = (svg: string) => [...parse(svg).querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name.toLowerCase()))
const tagNames = (svg: string) => [...parse(svg).querySelectorAll('*')].map((el) => el.localName.toLowerCase())

describe('sanitizeSvg · drops behaviour-carrying elements', () => {
  it('removes <script>, <foreignObject>, <animate*> and <set>', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg">'
      + '<script>window.__pwned=1</script>'
      + '<foreignObject><iframe src="x"></iframe></foreignObject>'
      + '<rect width="10" height="10"><animate attributeName="x" onbegin="window.__pwned=1"/><set/></rect>'
      + '</svg>',
    )
    expect(tagNames(out)).toEqual(['rect'])
    expect(out).not.toContain('script')
    expect(out).not.toContain('foreignObject')
    expect(out).not.toContain('animate')
  })
})

describe('sanitizeSvg · strips the injection attributes', () => {
  it('drops any on* event handler but keeps the element and its presentation attributes', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="x" onerror="window.__pwned=1" width="1" height="1"/></svg>')
    expect(attrNames(out)).not.toContain('onerror')
    expect(attrNames(out)).not.toContain('href') // "x" is neither #frag nor data:image
    expect(attrNames(out)).toEqual(expect.arrayContaining(['width', 'height']))
  })

  it('drops an element carrying BOTH href and xlink:href when either is unsafe', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
      + '<use href="https://evil.example/x.svg#a" xlink:href="#local"/></svg>',
    )
    // the external plain href is stripped; the safe fragment xlink:href stays
    expect(out).not.toContain('evil.example')
    expect(out).toContain('#local')
    expect(tagNames(out)).toContain('use')
  })

  it('keeps a #fragment href and a data:image raster', () => {
    const frag = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><use href="#g"/></svg>')
    expect(frag).toContain('#g')
    const raster = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA" width="1" height="1"/></svg>')
    expect(raster).toContain('data:image/png')
  })

  it('keeps url(#id) references but drops external / javascript url()s', () => {
    const safe = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#grad)" width="1" height="1"/></svg>')
    expect(safe).toContain('url(#grad)')
    const evil = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/x#a)" width="1" height="1"/></svg>')
    expect(evil).not.toContain('evil.example')
    const js = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:window.__pwned=1"><rect width="1" height="1"/></a></svg>')
    expect(js).not.toContain('javascript:')
  })
})

describe('sanitizeSvg · malformed input never throws', () => {
  it('returns "" for a parse error, a non-svg root, and empty input', () => {
    expect(sanitizeSvg('<svg><g></svg>')).toBe('') // unbalanced → parsererror
    expect(sanitizeSvg('<html><body>hi</body></html>')).toBe('')
    expect(sanitizeSvg('')).toBe('')
    expect(sanitizeSvg('not markup at all')).toBe('')
  })

  it('drops a DOCTYPE / ENTITY prologue by re-serialising only the <svg>', () => {
    const out = sanitizeSvg(
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    )
    expect(out).not.toContain('DOCTYPE')
    expect(out).not.toContain('ENTITY')
    expect(out.startsWith('<svg')).toBe(true)
  })
})

describe('sanitizeSvg · legitimate glyphs render identically', () => {
  // a vehicle glyph (lib/useVehiclePositions · vehicleSymbolSvg) and a pack-style symbol: the
  // elements and attributes the app actually emits, none of which is a vector.
  const VEHICLE = '<svg viewBox="-1.3 -1.3 2.6 2.6" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">'
    + '<g transform="rotate(90)"><path d="M -1,0.4 L 1,-0.4" stroke="#00a0ff" fill="none" stroke-width="0.1"/></g>'
    + '<text x="0" y="0" dy="0.35em" font-size="0.5" fill="#00a0ff" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold">TLF</text></svg>'
  const GRADIENT = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>'
    + '<circle cx="0" cy="0" r="1" fill="url(#g)"/></svg>'

  it('leaves the vehicle glyph structurally intact and unmodified', () => {
    const res = sanitizeSvgResult(VEHICLE)
    expect(res.modified).toBe(false)
    expect(tagNames(res.svg).sort()).toEqual(['g', 'path', 'text'])
    expect(res.svg).toContain('rotate(90)')
    expect(res.svg).toContain('>TLF<')
    expect(res.svg).toContain('font-family="Arial,sans-serif"')
  })

  it('preserves gradients and their url(#id) fill', () => {
    const res = sanitizeSvgResult(GRADIENT)
    expect(res.modified).toBe(false)
    expect(tagNames(res.svg)).toEqual(expect.arrayContaining(['lineargradient', 'stop', 'circle']))
    expect(res.svg).toContain('url(#g)')
  })

  it('reports modified only when something was actually stripped', () => {
    expect(sanitizeSvgResult('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>').modified).toBe(false)
    expect(sanitizeSvgResult('<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="x" width="1"/></svg>').modified).toBe(true)
  })
})
