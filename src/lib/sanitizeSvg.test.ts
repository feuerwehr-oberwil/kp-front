// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeSvg, sanitizeSvgResult } from './sanitizeSvg'
import symbols from '../../dist/tactical-symbols.json'

// SEC-01 · `Entity.symbolSvg` is editor-supplied free text rendered through
// `dangerouslySetInnerHTML` (lib/symbolRender). This is the authoritative XSS gate: it parses the
// markup in the SAME parser the sink uses (HTML) and keeps only static tactical-glyph SVG. These
// tests pin the vectors the reviewers called out — including the round-3 parser-differential
// bypass — and confirm a legitimate glyph survives untouched.

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
  it('returns "" when there is no <svg> to render, and for empty input', () => {
    // The HTML parser is deliberately lenient (it is the sink's parser): `<svg><g></svg>` is a
    // valid, inert glyph and comes back non-empty — but anything WITHOUT an <svg> yields ''.
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

// SEC-01 (round 3) · the PARSER-DIFFERENTIAL bypass the independent auditor reopened. The round-2
// gate parsed as XML and re-serialised to a string; the HTML sink then re-parsed that string, and
// content inert under XML went live under HTML. These pin the exact payloads the auditor confirmed
// executed, plus the variants, and prove they are inert BOTH as returned markup AND when fed into a
// real HTML sink (`div.innerHTML`) — the same operation `dangerouslySetInnerHTML` performs.
describe('sanitizeSvg · closes the XML→HTML parser-differential', () => {
  // The result string is injected exactly as the render sink injects it, into a real element, and
  // the resulting DOM is inspected. Any surviving <img>/<script>/<iframe> or on* attribute — or a
  // set `window.__probe` — would mean the differential is still open.
  const injectAndInspect = (payload: string) => {
    const probeKey = '__probe' as const
    ;(window as unknown as Record<string, unknown>)[probeKey] = undefined
    const safe = sanitizeSvg(payload)
    const host = document.createElement('div')
    host.innerHTML = safe // the sink: dangerouslySetInnerHTML does exactly this
    const badEls = host.querySelectorAll('img, script, iframe, foreignobject')
    const onAttrs = [...host.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].map((a) => a.name.toLowerCase()).filter((n) => n.startsWith('on')),
    )
    return {
      safe,
      probe: (window as unknown as Record<string, unknown>)[probeKey],
      badCount: badEls.length,
      onAttrs,
    }
  }

  it('neutralises the auditor payload: CDATA inside <title>', () => {
    const payload =
      '<svg xmlns="http://www.w3.org/2000/svg">'
      + '<title><text><![CDATA[><img/src=""/onerror="window.__probe=1">]]></text></title>'
      + '<rect width="10" height="10"/></svg>'
    const r = injectAndInspect(payload)
    expect(r.safe).not.toContain('CDATA')
    expect(r.safe).not.toContain('onerror')
    expect(r.safe).not.toContain('<img')
    expect(r.badCount).toBe(0)
    expect(r.onAttrs).toEqual([])
    expect(r.probe).toBeUndefined()
    expect(tagNames(r.safe)).toEqual(['rect']) // only the legitimate shape remains
  })

  it('neutralises CDATA inside <desc> and directly inside <svg>', () => {
    // <desc> is dropped whole, so its CDATA goes with it. CDATA directly under <svg> is a
    // CDATASection node (nodeType 4) in real browsers — removed by the walk — while jsdom lowers it
    // to a text node that outerHTML then ESCAPES (`&lt;img…&gt;`): inert either way. The security
    // property is that no live <img>/handler survives and the raw `<img` tag never appears, NOT that
    // the escaped characters are absent from a text node.
    for (const payload of [
      '<svg xmlns="http://www.w3.org/2000/svg"><desc><![CDATA[<img src=x onerror="window.__probe=1">]]></desc><circle r="1"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[<img src=x onerror="window.__probe=1">]]><circle r="1"/></svg>',
    ]) {
      const r = injectAndInspect(payload)
      expect(r.safe).not.toContain('<img') // no unescaped element — text is escaped or CDATA removed
      expect(r.badCount).toBe(0)
      expect(r.onAttrs).toEqual([])
      expect(r.probe).toBeUndefined()
    }
  })

  it('drops a slash-separated event handler (<img/onerror=…>) an on*-denylist keyed on whitespace misses', () => {
    const r = injectAndInspect('<svg xmlns="http://www.w3.org/2000/svg"><image href="#a"/onerror="window.__probe=1" width="1" height="1"/></svg>')
    expect(r.onAttrs).toEqual([])
    expect(r.safe).not.toContain('onerror')
    expect(r.probe).toBeUndefined()
  })

  it('drops a comment-wrapped payload and a namespaced event attribute', () => {
    const comment = injectAndInspect('<svg xmlns="http://www.w3.org/2000/svg"><!--<img src=x onerror="window.__probe=1">--><rect width="1" height="1"/></svg>')
    expect(comment.safe).not.toContain('onerror')
    expect(comment.badCount).toBe(0)
    // a namespaced/unusually-spelled handler an `on*` prefix check might let slip — the allowlist drops it
    const namespaced = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" xmlns:ev="http://www.w3.org/2001/xml-events"><rect ev:event="load" onload="window.__probe=1" width="1"/></svg>')
    expect(namespaced).not.toContain('onload')
    expect(namespaced).not.toContain('ev:event')
  })

  it('drops an xlink:href pointing at a local file and a fake href hidden in a data-* attribute', () => {
    const xlink = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="/etc/passwd"/></svg>')
    expect(xlink).not.toContain('/etc/passwd')
    // a data-* attribute is not on the allowlist at all — it cannot carry a smuggled reference
    const dataAttr = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect data-href="#a" data-onload="x" width="1"/></svg>')
    expect(dataAttr).not.toContain('data-href')
    expect(dataAttr).not.toContain('data-onload')
  })

  it('drops <style> (a CSS injection surface) whole', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>* { background: url(javascript:1) }</style><rect width="1" height="1"/></svg>')
    expect(out).not.toContain('style')
    expect(out).not.toContain('javascript:')
    expect(tagNames(out)).toEqual(['rect'])
  })
})

// SEC-01 (round 4) · content OUTSIDE the first <svg> subtree. `sanitizeSvg` serialises only the
// first svg, so a trailing sibling after `</svg>`, a wrapping element, or a prologue is discarded —
// but the discarding must set `modified`, or the load gate (which optimises on `modified: false`)
// keeps the ORIGINAL poisoned bytes. These pin: the returned svg carries none of the outside
// content, injecting it fires nothing, and `modified` is true so the gate rewrites the store.
describe('sanitizeSvg · discards and flags anything outside the first <svg> subtree', () => {
  const inject = (safe: string) => {
    ;(window as unknown as Record<string, unknown>).__sec01 = undefined
    const host = document.createElement('div')
    host.innerHTML = safe // the sink
    return {
      bad: host.querySelectorAll('img, script, iframe, foreignobject').length,
      probe: (window as unknown as Record<string, unknown>).__sec01,
    }
  }

  it.each([
    // the exact payload the auditor round-tripped through the workspace PUT/GET
    ['trailing <iframe srcdoc>', '<svg xmlns="http://www.w3.org/2000/svg"></svg><iframe srcdoc="&lt;script>parent.__sec01=1&lt;/script>"></iframe>'],
    ['trailing <script>', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg><script>window.__sec01=1</script>'],
    ['trailing <img onerror>', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg><img src=x onerror="window.__sec01=1">'],
    ['<div> wrapper around the svg', '<div><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg></div>'],
  ])('neutralises and flags: %s', (_name, payload) => {
    const res = sanitizeSvgResult(payload)
    expect(res.modified).toBe(true) // ⇒ the load gate stores res.svg, not the poisoned original
    expect(res.svg).not.toContain('iframe')
    expect(res.svg).not.toContain('script')
    expect(res.svg).not.toContain('onerror')
    expect(res.svg.startsWith('<svg')).toBe(true) // only the clean glyph survives
    const r = inject(res.svg)
    expect(r.bad).toBe(0)
    expect(r.probe).toBeUndefined()
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

  // the shipped FireGIS pack is the app's own trusted output — every bundled glyph must report
  // modified:false, which is exactly what makes the load gate keep the stored bytes byte-for-byte
  // (workspace.ts · fixDrawProps rewrites only when modified). Asserted on res.svg would be wrong:
  // the HTML serialiser rewrites the pack's self-closing `<circle/>` to `<circle></circle>` — hence
  // we never re-serialise a clean glyph into the store; the byte-identity guarantee lives at the gate.
  it('reports modified:false for every bundled pack glyph, so the gate keeps its stored bytes', () => {
    for (const { svg } of symbols.symbols) {
      expect(sanitizeSvgResult(svg).modified).toBe(false)
    }
  })
})
