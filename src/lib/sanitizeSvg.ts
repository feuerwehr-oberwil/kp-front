/**
 * Sanitise editor-supplied inline SVG before it reaches the DOM.
 *
 * WHY this exists: `Entity.symbolSvg` (and a plan twin's) is FREE-FORM workspace data — any
 * editor can set it through the workspace-sync PUT — and it is rendered verbatim through
 * `dangerouslySetInnerHTML` (lib/symbolRender · TacticalSymbol). A crafted value such as
 * `<svg><image href=x onerror=…></svg>` therefore ran script in another operator's origin
 * (SEC-01, the class the audit's shape-colour fix left open). This is the AUTHORITATIVE XSS gate.
 *
 * ⚠️ WHY WE PARSE IN HTML CONTEXT (this is the whole fix — do not regress it to an XML parse):
 * the sink is `innerHTML`, i.e. the browser's HTML parser. Two earlier fixes parsed the markup as
 * XML (`image/svg+xml`), filtered, and re-serialised to a STRING — but that string was then
 * re-parsed by the HTML sink, and the two parsers do NOT agree. Content that is inert under XML
 * becomes live under HTML: a `<![CDATA[ … ]]>` section survives XML serialisation untouched, and
 * inside an SVG HTML-integration element (`<title>`, `<desc>`, `<foreignObject>`) the HTML parser
 * turns that CDATA text back into real markup — so
 *   `<title><text><![CDATA[><img/src=""/onerror="…">]]></text></title>`
 * passed straight through an XML-based sanitiser and then FIRED in the sink. The only way to close
 * a parser-differential is to sanitise in the SAME parser the sink uses. So we parse with
 * `DOMParser.parseFromString(markup, 'text/html')` (browsers parse inline `<svg>` as foreign
 * content in an HTML document — exactly what the sink does), walk that tree, and serialise the
 * cleaned `<svg>` back with `outerHTML`. There is no second parse to disagree with.
 *
 * ON TOP of the HTML-context parse we also, belt-and-suspenders:
 *  • DROP every non-element node that can carry a parser-context trap — CDATA sections (nodeType 4),
 *    comments (8) and processing instructions (7). None belong in a static glyph and all three are
 *    places the two parsers diverge.
 *  • ELEMENT ALLOWLIST: keep only the structural/presentational shapes a static tactical glyph is
 *    built from. Everything else is dropped whole — including every HTML/MathML integration point
 *    (`<foreignObject>`, `<title>`, `<desc>`, `<metadata>`, `<annotation*>`) and every behaviour
 *    carrier (`<script>`, `<style>`, `<animate*>`, `<set>`), none of which a glyph needs.
 *  • ATTRIBUTE ALLOWLIST (not a denylist): keep only known-safe SVG presentation/geometry/text
 *    attributes. This is what makes `onerror`, `/onerror`, `onload`, namespaced event handlers and
 *    any unknown/`data-*` attribute fall away no matter how they are spelled — a `startsWith('on')`
 *    denylist misses slash- and namespace-separated evasions, an allowlist cannot. `href`/`xlink:href`
 *    are allowed ONLY when they point at a `#fragment` or a `data:image/…` raster; `style` is dropped
 *    entirely (a glyph gets its colour from `fill`/`stroke`, and `style` can smuggle `url()`).
 *
 * Never throws: unparseable markup (or a document with no `<svg>`) yields '' so the caller renders
 * nothing — losing one glyph must never take down a live incident.
 */

/** Structural + presentational SVG elements a static glyph is built from (compared lowercased, so
 *  the camelCase originals `linearGradient`/`clipPath`/… match). Everything else — behaviour
 *  carriers and every HTML/MathML integration point — is removed. NB `<title>`/`<desc>` are NOT
 *  here: they are text integration points where the HTML parser re-enters HTML mode, the exact
 *  trap this gate exists to shut, and a static glyph never needs them. */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath',
  'mask', 'pattern', 'use', 'symbol', 'marker', 'image',
])

/** Known-safe SVG presentation / geometry / text / gradient attributes (compared lowercased; the
 *  HTML parser restores the camelCase of foreign attributes like `viewBox`, so we lower them to
 *  match). `href`/`xlink:href` are handled separately (value-checked); `style`, every `on*` handler
 *  and everything not named here is dropped. */
const ALLOWED_ATTRS = new Set([
  // geometry / layout
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy',
  'points', 'width', 'height', 'viewbox', 'preserveaspectratio', 'transform', 'dx', 'dy',
  // paint / presentation
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'stroke-opacity', 'opacity', 'color', 'visibility', 'display',
  // text
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'word-spacing',
  // gradient / pattern
  'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod',
  'patternunits', 'patterncontentunits', 'patterntransform',
  // clip / mask
  'clip-path', 'clip-rule', 'mask', 'maskunits', 'maskcontentunits', 'clippathunits',
  // marker
  'markerwidth', 'markerheight', 'refx', 'refy', 'orient', 'markerunits',
  // identity / namespaces
  'id', 'class', 'xmlns', 'xmlns:xlink',
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
  // `href`/`xlink:href` (however namespaced) may only point at a fragment or an inline raster.
  if (n === 'href' || n.endsWith(':href')) return isSafeRef(value)
  // ALLOWLIST: anything not explicitly named is dropped — this is what stops `onerror`, `/onerror`,
  // `onload`, `xlink:actuate`, unknown/`data-*` attributes and `style` regardless of spelling.
  if (!ALLOWED_ATTRS.has(n)) return false
  if (/javascript:/i.test(value)) return false
  if (/url\(/i.test(value) && hasUnsafeUrl(value)) return false
  return true
}

interface SanitizeResult {
  /** the safe, re-serialised markup ('' when nothing could be salvaged) */
  svg: string
  /** true when the input was rejected outright, had anything stripped INSIDE the svg, OR carried
   *  anything OUTSIDE the first svg subtree (a wrapper, a trailing sibling, a prologue) that
   *  serialising only that subtree discards — the load gate uses this to leave a clean glyph's
   *  stored bytes untouched and to count only real neutralisations. */
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

// Node types that carry a parser-context trap and are dropped wherever they appear (querySelectorAll
// never returns them, so they are handled in the childNode walk): CDATA section, processing
// instruction, comment. See the file header — CDATA in particular is the round-2 bypass.
const TRAP_NODE_TYPES = new Set<number>([4 /* CDATA_SECTION */, 7 /* PROCESSING_INSTRUCTION */, 8 /* COMMENT */])

function clean(markup: string): SanitizeResult {
  let doc: Document
  try {
    // ⚠️ 'text/html', NOT 'image/svg+xml': the sink is `innerHTML`, so we MUST parse in the same
    // parser to avoid the XML→HTML differential that the CDATA-in-<title> bypass exploited. The HTML
    // parser handles inline `<svg>` as foreign content exactly as the sink will.
    doc = new DOMParser().parseFromString(markup, 'text/html')
  } catch {
    return { svg: '', modified: true } // no DOM to parse with (never in a browser) → render nothing
  }
  // The glyph is the first <svg> in document order; anything wrapping it (a stray <div>, a dropped
  // integration element) is discarded by taking only the svg subtree. No <svg> → nothing to render.
  const root = doc.querySelector('svg')
  if (!root) return { svg: '', modified: true }

  // ⚠️ SEC-01 round 4 — the load-gate optimisation bug. We serialise the FIRST <svg> subtree ONLY,
  // so anything ELSE the HTML parser produced is silently discarded by that very choice:
  //   • a TRAILING SIBLING after `</svg>` — the `<iframe srcdoc>` / `<script>` / `<img onerror>` that
  //     `querySelector('svg')` walks straight past (the exact payload that reopened this),
  //   • a WRAPPER around the svg (`<div><svg/></div>`), whose <svg> is not a child of <body>,
  //   • a DOCTYPE/ENTITY prologue, which the parser leaves as extra <body> content.
  // Each of those is a genuine neutralisation the load gate MUST see: it keeps the ORIGINAL stored
  // bytes whenever `modified` is false, so if dropping the trailing <iframe> did not flip the flag
  // the gate would store the poisoned original. We CANNOT settle this by comparing `root.outerHTML`
  // to the input string — the HTML serialiser rewrites a legitimate self-closing `<circle/>` to
  // `<circle></circle>`, so every honest glyph would read as "changed" and lose its byte-identity.
  // Structural detection is exact instead: the svg is the whole safe payload IFF it is the SOLE
  // child of <body>; otherwise content outside its subtree was dropped → modified. A bare
  // `<svg>…</svg>` glyph is the sole body child and unchanged inside → modified stays false.
  let modified = root.parentNode !== doc.body || doc.body.childNodes.length !== 1

  const scrub = (el: Element): void => {
    for (const attr of [...el.attributes]) {
      if (!keepAttribute(attr.name, attr.value)) {
        el.removeAttribute(attr.name)
        modified = true
      }
    }
    for (const child of [...el.childNodes]) {
      if (child.nodeType === 1 /* ELEMENT_NODE */) {
        const c = child as Element
        if (!ALLOWED_ELEMENTS.has(c.localName.toLowerCase())) {
          el.removeChild(c)
          modified = true
          continue
        }
        scrub(c)
      } else if (TRAP_NODE_TYPES.has(child.nodeType)) {
        el.removeChild(child) // CDATA / comment / PI — the parser-context traps
        modified = true
      }
      // plain text nodes (nodeType 3) are kept: they are a glyph's visible label
    }
  }

  scrub(root)

  try {
    return { svg: root.outerHTML, modified }
  } catch {
    return { svg: '', modified: true }
  }
}

/** The safe markup for a `dangerouslySetInnerHTML` sink — '' when nothing could be salvaged. */
export const sanitizeSvg = (markup: string): string => sanitize(markup).svg

/** For the workspace load gate: the safe markup PLUS whether the input was hostile, so a clean
 *  glyph's stored bytes are left exactly as they were and only real neutralisations are counted. */
export const sanitizeSvgResult = (markup: string): SanitizeResult => sanitize(markup)
