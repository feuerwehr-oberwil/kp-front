// @vitest-environment jsdom
// Read values (the Rapport's, the Alarmmeldung's) stand at the read-out step, --fs-2 (14px): owner
// 16.11.2026 found the «Aus den Einsatzdaten» values «just a bit too big» at 16. 16 is a FIELD's
// size (iOS zooms into anything smaller), so a read-out that copies the fields drifts back up –
// this pins it.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

/** jsdom does not expand a `font` shorthand that holds a var(): each one also names its size as
 *  `font-size`, so the cascade decides the size across shorthands and longhands alike. A whole-font
 *  token (`font: var(--sheet-title)`) is looked up in `tokens`, the first definition of each. */
const withFontSizes = (css: string, tokens: Map<string, string>) =>
  css.replace(/(\bfont:\s*([^;{}]*))/g, (decl, _all, value: string) => {
    const size = sizeIn(value, tokens)
    return size ? `${decl}; font-size: ${size}` : decl
  })
function sizeIn(value: string, tokens: Map<string, string>, depth = 0): string | undefined {
  const size = /var\(--fs-[\w-]+\)|\b\d+(?:\.\d+)?(?:px|rem|em)\b/.exec(value)?.[0]
  if (size || depth > 3) return size
  const token = /^\s*var\((--[\w-]+)\)\s*$/.exec(value)?.[1]
  const defined = token && tokens.get(token)
  return defined ? sizeIn(defined, tokens, depth + 1) : undefined
}

/** jsdom ranks a rule by its whole selector list, a browser by the selector that matched: one rule
 *  per selector, so a later `.rz-clock` rule beats `.rz-clock, .rz-count > b` as it does there. */
function splitSelectorLists(parent: CSSStyleSheet | CSSGroupingRule) {
  for (let i = parent.cssRules.length - 1; i >= 0; i--) {
    const rule = parent.cssRules[i]
    if (rule instanceof CSSStyleRule) {
      const selectors = rule.selectorText.split(/,(?![^(]*\))/).map((x) => x.trim())
      if (selectors.length < 2) continue
      const body = rule.style.cssText
      // in order, behind the list; a selector jsdom cannot parse keeps the list as it was
      let added = 0
      try {
        for (const selector of selectors) { parent.insertRule(`${selector} { ${body} }`, i + 1 + added); added++ }
        parent.deleteRule(i)
      } catch {
        for (; added > 0; added--) parent.deleteRule(i + 1)
      }
    } else if ('cssRules' in rule) splitSelectorLists(rule as CSSGroupingRule)
  }
}

// what the app's global stylesheets (app.css, in its cascade order) give each read-out – jsdom
// applies no @media
beforeAll(() => {
  const read = (f: string) => readFileSync(`${process.cwd()}/src/${f}`, 'utf8')
  const sheets = [...read('app.css').matchAll(/@import '\.\/(styles\/[^']+)'/g)].map(([, f]) => read(f))
  const tokens = new Map<string, string>()
  for (const [, name, value] of sheets.join('\n').matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) if (!tokens.has(name)) tokens.set(name, value)
  for (const text of sheets) {
    const style = document.head.appendChild(Object.assign(document.createElement('style'), { textContent: withFontSizes(text, tokens) }))
    splitSelectorLists(style.sheet!)
  }
  // the read-outs in the shapes ReportPreflight, ReportSignatures and the Meldeleiste draw them
  document.body.innerHTML = `<div class="report-preflight-body">
    <dl class="report-meta-readout ui-selectable"><div><dt>Stichwort</dt><dd>Brand</dd></div></dl>
    <div class="ip-field"><span>Einsatzleiter</span><div class="rp-readout">Muster Hans</div></div>
    <div class="ip-field"><span>Gruppen</span><div class="rz-grid"><label class="rz-row"><span class="rz-name">Gruppe 1</span><b class="rz-clock">21:12</b></label></div></div>
    <div class="rz-counts"><div class="rz-count"><span>Personen</span><b>2</b></div></div>
    <label class="ip-field"><span>Ausgerückt</span><div class="report-meta-end rz-derived"><b>21:15</b><span class="rz-sub">abgeleitet</span></div></label>
    <div class="rp-check-extra rp-sign"><div class="rp-sign-row"><span class="rp-sign-who"><span class="rp-sign-role">EL</span><span class="rp-sign-name">Muster Hans</span></span></div></div>
  </div>
  <div class="ml"><div class="ml-row t-info quote"><span class="ml-txt"><span class="ml-quote">
    <span class="ml-quote-head">Brand Gebäude</span><span class="ml-quote-text ui-selectable">Hauptstrasse 1</span>
  </span></span></div></div>`
})

describe('read-outs', () => {
  it.each([
    '.report-meta-readout dd', '.rp-readout', '.rz-clock', '.rz-count > b', '.rz-derived b', '.rp-sign-name',
    // the Alarmmeldung in «Einsatzdaten prüfen» (owner, sign-off 25.11.2026: it was 19 and 16)
    '.ml-quote-head', '.ml-quote-text',
  ])('%s reads at --fs-2', (selector) => {
    expect(getComputedStyle(document.querySelector(selector)!).fontSize).toBe('var(--fs-2)')
  })
})
