/**
 * Sanitise editor-supplied inline SVG before it reaches the DOM.
 *
 * WHY this exists: `Entity.symbolSvg` (and a plan twin's) is FREE-FORM workspace data — any
 * editor can set it through the workspace-sync PUT — and it is rendered verbatim through
 * `dangerouslySetInnerHTML` (lib/symbolRender · TacticalSymbol). A crafted value such as
 * `<svg><image href=x onerror=…></svg>` therefore ran script in another operator's origin
 * (SEC-01, the class the audit's shape-colour fix left open). This is the AUTHORITATIVE XSS gate:
 * it parses the markup with the browser's `DOMParser` — deliberately not a hand-rolled regex,
 * which is exactly the sink the audit warned against — walks the tree, and keeps only the
 * structural/presentational SVG a static tactical glyph is made of.
 *
 * The ELEMENT list is a strict allowlist: the shapes, text, gradients, patterns, uses and raster
 * <image>s the bundled symbol pack, the vehicle/person glyph builders and the shape renderers
 * actually emit — and NONE of the elements that carry behaviour (`<script>`, `<foreignObject>`,
 * `<animate*>`, `<set>`), which are dropped whole. ATTRIBUTES are filtered rather than
 * allowlisted, so a legitimate glyph survives byte-for-byte: only the real vectors are stripped —
 * any `on*` event handler, and any `href`/`xlink:href`/CSS `url(…)` that points anywhere but a
 * `#fragment` or a `data:image/…` raster (so `javascript:` and external/local loads cannot fire).
 * A DOCTYPE/ENTITY prologue is dropped for free: only the `<svg>` element is re-serialised.
 *
 * Never throws: unparseable markup (or a root that is not `<svg>`) yields '' so the caller renders
 * nothing — losing one glyph must never take down a live incident.
 */

/** Structural + presentational SVG elements a static glyph is built from (compared lowercased, so
 *  the camelCase originals `linearGradient`/`clipPath`/… match). Everything else is removed. */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath',
  'mask', 'pattern', 'use', 'title', 'symbol', 'marker', 'image',
])

/** A resource reference (`href`, CSS `url(…)`) a glyph may legitimately carry: an in-document
 *  fragment, or an inline raster. NOT a `javascript:` URI, and NOT an external or local file the
 *  renderer would fetch from the victim's origin. */
const isSafeRef = (value: string): boolean => {
  const v = value.trim().toLowerCase()
  return v.startsWith('#') || v.startsWith('data:image/')
}

/** Every `url(…)` in a presentation attribute must target a `#fragment`; anything else (an
 *  external stylesheet/image, a `javascript:` URI) makes the whole attribute unsafe. */
const hasUnsafeUrl = (value: string): boolean => {
  for (const m of value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!m[2].trim().startsWith('#')) return true
  }
  return false
}

const keepAttribute = (name: string, value: string): boolean => {
  const n = name.toLowerCase()
  if (n.startsWith('on')) return false // event handler — the direct script sink
  if (n === 'href' || n.endsWith(':href')) return isSafeRef(value)
  if (/javascript:/i.test(value)) return false
  if (/url\(/i.test(value) && hasUnsafeUrl(value)) return false
  return true
}

interface SanitizeResult {
  /** the safe, re-serialised markup ('' when nothing could be salvaged) */
  svg: string
  /** true when the input was rejected outright or had anything stripped — the load gate uses this
   *  to leave a clean glyph's stored bytes untouched and to count only real neutralisations. */
  modified: boolean
}

// Bounded memo: many markers share the same pack-glyph string, and the render sink calls this on
// every paint. Keyed by the raw markup, which is stable per entity; oldest entry evicted first.
const CACHE_MAX = 512
const cache = new Map<string, SanitizeResult>()

function sanitize(markup: string): SanitizeResult {
  if (!markup) return { svg: '', modified: false }
  const cached = cache.get(markup)
  if (cached) return cached
  const result = clean(markup)
  cache.set(markup, result)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return result
}

function clean(markup: string): SanitizeResult {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
  } catch {
    return { svg: '', modified: true } // no DOM to parse with (never in a browser) → render nothing
  }
  const root = doc.documentElement
  // A malformed document parses to a <parsererror> tree (or none at all); a root that is not an
  // <svg> is not a glyph. Either way there is nothing safe to render.
  if (!root || root.nodeName === 'parsererror' || doc.querySelector('parsererror')) {
    return { svg: '', modified: true }
  }
  if (root.localName.toLowerCase() !== 'svg') return { svg: '', modified: true }

  let modified = false
  // Snapshot the elements first — removing one mutates the live tree underneath querySelectorAll.
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (!el.isConnected) continue // an ancestor was already dropped, taking this with it
    if (!ALLOWED_ELEMENTS.has(el.localName.toLowerCase())) {
      el.remove()
      modified = true
      continue
    }
    for (const attr of [...el.attributes]) {
      if (!keepAttribute(attr.name, attr.value)) {
        el.removeAttribute(attr.name)
        modified = true
      }
    }
  }

  try {
    return { svg: new XMLSerializer().serializeToString(root), modified }
  } catch {
    return { svg: '', modified: true }
  }
}

/** The safe markup for a `dangerouslySetInnerHTML` sink — '' when nothing could be salvaged. */
export const sanitizeSvg = (markup: string): string => sanitize(markup).svg

/** For the workspace load gate: the safe markup PLUS whether the input was hostile, so a clean
 *  glyph's stored bytes are left exactly as they were and only real neutralisations are counted. */
export const sanitizeSvgResult = (markup: string): SanitizeResult => sanitize(markup)
