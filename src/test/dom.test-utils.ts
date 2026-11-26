// What a jsdom test needs from the browser that jsdom does not give: the app's stylesheets on the
// document, and an answer from `matchMedia`. Import it in the test that needs it – it is no
// global setup. (The one global piece, the default «no query matches», is ./jsdom.setup.ts.)
import { readFileSync } from 'node:fs'
import { vi } from 'vitest'
import { staticMediaList } from './mediaList'

const readSrc = (file: string) => readFileSync(`${process.cwd()}/src/${file}`, 'utf8')

/** The app's global stylesheets as text: each file `src/app.css` imports, in its cascade order. */
export function appStylesheets(): string[] {
  return [...readSrc('app.css').matchAll(/@import '\.\/(styles\/[^']+)'/g)].map(([, file]) => readSrc(file))
}

/** A CSS module's text (`file` under src/) with its classes renamed to this run's names – `names`
 *  is the module's default import – so its rules reach the elements a component renders. */
export function cssModuleText(file: string, names: Readonly<Record<string, string>>): string {
  return readSrc(file).replace(/\.([A-Za-z_][\w-]*)/g, (match, name: string) => (names[name] ? `.${names[name]}` : match))
}

/** Put stylesheets on this document, so getComputedStyle answers what their cascade gives an
 *  element. Returns the parsed sheets. jsdom applies no @media, draws no pseudo-element and lays
 *  nothing out. The sheets stay for the rest of the file: RTL's cleanup empties only the body. */
export function addStyles(...texts: string[]): CSSStyleSheet[] {
  return texts.map((textContent) => {
    const { sheet } = document.head.appendChild(Object.assign(document.createElement('style'), { textContent }))
    if (!sheet) throw new Error('addStyles: jsdom parsed no stylesheet')
    return sheet
  })
}

/** Make `window.matchMedia` answer `matches(query)` for every query, asked at each call. Through
 *  `vi.stubGlobal`, so `vi.unstubAllGlobals()` goes back to the default (no query matches). */
export function stubMatchMedia(matches: (query: string) => boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => staticMediaList(query, matches(query)))
}
