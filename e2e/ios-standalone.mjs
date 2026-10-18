// The iPhone stand-ins the by-hand WebKit checks share (karte-search-scroll.mjs, einsatz-keyboard.mjs):
// a software keyboard, the installed home-screen app and its safe area — what WebKit on Linux cannot
// run itself. Each check's head says what it models with them; docs/karte-objekte.md has the
// readouts (review rounds 8–10) the numbers come from.
//
//   import { FRAMES, phoneContext } from './ios-standalone.mjs'
//   const ctx = await phoneContext(browser, FRAMES.app, BASE)   // then window.__kb / __collapseTo
//
// TWO FRAMES (review round 8): the browser tab (`tab`, 390×844) and the installed app (`app`) —
// `display-mode: standalone` and `navigator.standalone` true (lib/installPrompt · isStandalone), the
// web view BELOW the opaque status bar (393×793 of an iPhone 15's 852), safe area 0/34 written into
// the CSS in place of `env()` (desktop WebKit reads it as 0), and the owner's recorded keyboard
// (`kb`, px of the view). `collapse`: the round-9 readout after a touch with the keys up —
// innerHeight 793 → 424, the window scrolled by the rest (369), the layout still 793.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { devices } = require('@playwright/test')

export const FRAMES = {
  tab: { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, kb: 336, standalone: false },
  app: { viewport: { width: 393, height: 793 }, screen: { width: 393, height: 852 }, kb: 362, standalone: true, safe: { top: 0, bottom: 34 }, collapse: { kb: 369, pan: 369 } },
}

/** The keyboard stand-in, installed before the app reads `visualViewport` (an init script).
 *  `window.__kb(patch)`: `kb` the keyboard's px, `pan` iOS's pan (`offsetTop`; with `collapse` also
 *  `scrollY`), `ignoreScrollTo` iOS ignoring `scrollTo(0, 0)` during a touch, `collapse` the
 *  installed app's innerHeight shrunk by `shrink` (null = the whole keyboard).
 *  `window.__collapseTo(inner, extent)`: one step of the gradual collapse (review round 10). */
export function fakeKeyboard() {
  // `collapse` (review round 9): the installed app's innerHeight shrinks to the visual viewport and
  // the window reports iOS's scroll — the layout (and with it `position: fixed`) stays full height
  // `shrink`: how far the collapse has gone (review round 10: iOS collapses in steps during the
  // touch, 793 → 711 → 785 …); null = by the whole keyboard (round 9's single step)
  const st = { kb: 0, pan: 0, ignoreScrollTo: false, collapse: false, shrink: null }
  const own = (k) => Object.getOwnPropertyDescriptor(window, k) ?? Object.getOwnPropertyDescriptor(Window.prototype, k)
  const realInner = own('innerHeight').get.bind(window)
  const realScrollY = own('scrollY').get.bind(window)
  const vv = new EventTarget()
  for (const [k, get] of Object.entries({
    height: () => realInner() - st.kb, width: () => window.innerWidth, offsetTop: () => st.pan, offsetLeft: () => 0,
    pageTop: () => st.pan, pageLeft: () => 0, scale: () => 1,
  })) Object.defineProperty(vv, k, { get })
  Object.defineProperty(window, 'visualViewport', { get: () => vv })
  Object.defineProperty(window, 'innerHeight', { get: () => (st.collapse ? realInner() - (st.shrink ?? st.kb) : realInner()), configurable: true })
  for (const k of ['scrollY', 'pageYOffset']) Object.defineProperty(window, k, { get: () => (st.collapse ? st.pan : realScrollY()), configurable: true })
  const scrollTo = window.scrollTo.bind(window)
  window.scrollTo = (...a) => {
    if (!st.ignoreScrollTo && st.pan) { st.pan = 0; vv.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')) }
    return scrollTo(...a)
  }
  window.__kb = (patch) => {
    const resized = 'collapse' in patch && patch.collapse !== st.collapse
    Object.assign(st, patch)
    vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll'))
    if (resized) window.dispatchEvent(new Event('resize'))
    if (st.collapse) window.dispatchEvent(new Event('scroll'))
  }
  // one step of the gradual collapse (review round 10, the owner's readout): innerHeight goes to
  // `inner`, and iOS scrolls the document by the collapse, `scrollY = 793 − inner` — as far as the
  // document lets it. `extent` is what bounds that on the phone, which WebKit on Linux cannot say:
  // 'html' — the root's own box (bound to the live height, nothing to scroll); 'icb' — the initial
  // containing block, which stays 793 whatever the CSS says (only an undo can help then)
  window.__collapseTo = (inner, extent) => {
    const full = realInner()
    st.collapse = true
    st.shrink = full - inner
    window.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('resize'))
    const docH = extent === 'html' ? document.documentElement.getBoundingClientRect().height : full
    const pan = Math.max(0, Math.min(full - inner, Math.round(docH - inner)))
    if (pan !== st.pan) { st.pan = pan; vv.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')) }
  }
}

/** The installed app's own test (lib/installPrompt · isStandalone) answers «yes», as on the home screen. */
export function standalone() {
  const mm = window.matchMedia.bind(window)
  const yes = (q) => ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })
  window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? yes(q) : mm(q))
  Object.defineProperty(navigator, 'standalone', { get: () => true })
}

/** A WebKit iPhone context in `frame`, the stand-ins installed: standalone (app frame), the safe
 *  area written into the app's CSS and modules, the keyboard stand-in. */
export async function phoneContext(browser, frame, base) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: frame.viewport, screen: frame.screen, baseURL: base, serviceWorkers: 'block' })
  if (frame.standalone) await ctx.addInitScript(standalone)
  if (frame.safe) {
    const origin = new URL(base).origin
    await ctx.route((u) => u.origin === origin, async (route) => {
      const res = await route.fetch().catch(() => null)
      // a 304 cannot be fulfilled: the browser answers it from its cache, which holds the body
      // this route already rewrote
      if (!res || res.status() === 304) return route.continue()
      if (!/javascript|css|html/.test(res.headers()['content-type'] ?? '')) return route.fulfill({ response: res })
      const body = (await res.text()).replaceAll('env(safe-area-inset-top)', `${frame.safe.top}px`).replaceAll('env(safe-area-inset-bottom)', `${frame.safe.bottom}px`)
      return route.fulfill({ response: res, body })
    })
  }
  await ctx.addInitScript(fakeKeyboard)
  return ctx
}
