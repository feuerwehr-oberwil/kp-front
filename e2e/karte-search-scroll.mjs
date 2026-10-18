// The Karte's phone search: only the result list scrolls (owner, review round 5, 18.10.2026,
// iPhone: «Scrolling in the search input still messes up things and doesnt work (gefahrgut scroll
// works though)» — «the whole sheet/page moves instead of the list, and it is worse while the
// keyboard is open»; round 6: «when i typed it works, without typing it fails (empty state)» — a
// list with nothing to scroll must move nothing; round 7, the owner's video: with the list at its
// top a finger on a row pulls DOWN and the whole sheet slides down with it — a drag on the list
// never moves the sheet, only the grab bar (or the ✕) does, the same in Gefahrgut). A device-class
// check, not a Playwright spec: WebKit at iPhone 13 size, run by hand against a running stack
// (docs/karte-objekte.md · «Search: only the list scrolls»).
//
//   LD_LIBRARY_PATH=… node e2e/karte-search-scroll.mjs http://127.0.0.1:5130   (PIN 000000 stack)
//
// What WebKit on Linux cannot do, and how this stands in for it:
//   · no native touch scrolling (Playwright has no touch drag, mobile WebKit no wheel): the drag is
//     dispatched as touchstart/touchmove/touchend EVENTS, so every JS guard sees it as on the
//     phone, and the list's native scroll is modelled — it follows the finger unless the FIRST
//     touchmove was cancelled (iOS: a cancelled first touchmove cancels the native pan for the
//     whole touch, see lib/overlays/useMobileScrollLock) — and a first move that passes over a
//     list with nothing to scroll counts as the page moving (`handedOn`: iOS ignores
//     overscroll-behavior on a box that does not overflow and pans what is behind it);
//   · no software keyboard: `visualViewport` is replaced by a stand-in whose height shrinks by the
//     keyboard and whose `offsetTop` is iOS's pan of the page («the whole page moves»); positions
//     are read on the SCREEN (layout px − pan). `scrollTo(0, 0)` undoes the pan as on iOS — except
//     in the «iOS ignores it» step, as iOS does during a running touch or momentum scroll.
//   · the sheet's own pull-down (overlays/swipeDismiss) is a POINTER gesture: every drag also
//     dispatches pointerdown/move/up (pointercancel once the modelled native pan has the touch),
//     and the sheet's top is read after every move, not only at the end.
// It cannot show what only the real iPhone does (where iOS decides to pan); for that the Karte has
// `?debug=scroll` (components/karte/KarteScrollDebug), and — the installed app has no address bar —
// five quick taps on the build line in the app menu (lib/scrollDebug).
//
// TWO FRAMES (review round 8, owner: «in the browser the search scroll works now but in the pwa it
// still fails»): every check runs in the browser tab (`tab`, 390×844) and in the installed
// home-screen app (`app`), emulated as closely as WebKit on Linux allows — `display-mode:
// standalone` and `navigator.standalone` true (the app's own test, lib/installPrompt · isStandalone),
// the web view BELOW the opaque status bar (index.html sets no status-bar style: 393×793 of an
// iPhone 15's 852, safe area top 0 / bottom 34 written into the CSS in place of `env()`, which
// desktop WebKit reads as 0) and the keyboard the owner's recording shows (362 px of that view).
// In that frame the sheet stands where the owner's round-7 video has it before the drag (top ~92,
// foot on the keys at 431). `KARTE_FRAMES=app` runs one frame only.
//
// Exit code 1 and «RED» lines when a check fails.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { webkit, devices } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
// the two frames (head of this file); `kb` = the German keyboard with its bar, px of the view
const FRAMES = {
  tab: { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, kb: 336, standalone: false },
  app: { viewport: { width: 393, height: 793 }, screen: { width: 393, height: 852 }, kb: 362, standalone: true, safe: { top: 0, bottom: 34 } },
}
let KEYBOARD = 336

// the keyboard stand-in, installed before the app reads `visualViewport`
function fakeKeyboard() {
  const real = window.visualViewport
  const st = { kb: 0, pan: 0, ignoreScrollTo: false }
  const vv = new EventTarget()
  for (const [k, get] of Object.entries({
    height: () => window.innerHeight - st.kb, width: () => window.innerWidth, offsetTop: () => st.pan, offsetLeft: () => 0,
    pageTop: () => st.pan, pageLeft: () => 0, scale: () => 1,
  })) Object.defineProperty(vv, k, { get })
  Object.defineProperty(window, 'visualViewport', { get: () => vv })
  const scrollTo = window.scrollTo.bind(window)
  window.scrollTo = (...a) => {
    if (!st.ignoreScrollTo && st.pan) { st.pan = 0; vv.dispatchEvent(new Event('scroll')) }
    return scrollTo(...a)
  }
  window.__kb = (patch) => { Object.assign(st, patch); vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll')) }
  void real
}

/** A one-finger drag over the sheet's body (or, `at: 'grab'`, its grab bar): `moves` are [dx, dy]
 *  steps of the finger. Dispatched as on iOS: pointerdown/touchstart, then per step pointermove +
 *  touchmove, then pointerup/touchend — so the sheet's own pull-down (overlays/swipeDismiss, a
 *  POINTER gesture) sees the finger exactly as the touch guards do; once the native pan has the
 *  touch, iOS sends pointercancel and no more pointer moves. Returns which moves a guard
 *  cancelled, the screen tops before/after and the sheet's lowest screen top DURING the drag
 *  (review round 7, owner's video: the whole sheet slid down with the finger and sprang back). */
function drag(arg) {
  // `moves`, or `[moves, 'grab']` (page.evaluate passes one argument)
  const [moves, at] = typeof arg[1] === 'string' ? arg : [arg, 'list']
  const pan = window.visualViewport.offsetTop
  const sheet = document.querySelector('[data-karte-keysheet]')
  const body = sheet.querySelector('.lc-body')
  const field = sheet.querySelector('input')
  let x, y
  if (at === 'grab') {
    const g = sheet.querySelector('.ui-sheet-grab').getBoundingClientRect()
    x = g.left + g.width / 2; y = g.top + g.height / 2
  } else {
    // on a row when there is one (the owner's finger in the video), else the body's middle
    const r = body.getBoundingClientRect()
    const row = [...body.querySelectorAll('[role="option"]')].map((o) => o.getBoundingClientRect()).find((o) => o.top >= r.top && o.bottom <= Math.min(r.bottom, window.visualViewport.height))
    x = r.left + r.width / 2; y = row ? row.top + row.height / 2 : r.top + Math.min(r.height * 0.5, 160)
  }
  const target = document.elementFromPoint(x, y)
  const tops = () => ({ sheet: Math.round(sheet.getBoundingClientRect().top - window.visualViewport.offsetTop), field: Math.round(field.getBoundingClientRect().top - window.visualViewport.offsetTop) })
  const before = { ...tops(), list: body.scrollTop }
  const ev = (type) => {
    const t = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y + pan, screenX: x, screenY: y }
    const e = new Event(type, { bubbles: true, cancelable: true, composed: true })
    const list = type === 'touchend' ? [] : [t]
    for (const [k, v] of Object.entries({ touches: list, targetTouches: list, changedTouches: [t] })) Object.defineProperty(e, k, { value: v })
    return e
  }
  const pe = (type) => new PointerEvent(type, { bubbles: true, cancelable: type !== 'pointercancel', composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, screenX: x, screenY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1 })
  target.dispatchEvent(pe('pointerdown'))
  target.dispatchEvent(ev('touchstart'))
  let dead = false
  // iOS hands the pan ON (the page pans or rubber-bands, «the whole sheet moves») when the first
  // move passes over a list that cannot scroll at all: `overscroll-behavior` only holds on a box
  // that overflows (review round 6: the empty search, 6 featured rows shorter than the sheet)
  let handedOn = false
  let native = false // the native pan has the touch: iOS sent pointercancel, no pointer moves follow
  let lowest = before.sheet
  const cancelled = []
  for (const [dx, dy] of moves) {
    x += dx; y += dy
    if (!native) target.dispatchEvent(pe('pointermove'))
    const e = ev('touchmove')
    target.dispatchEvent(e)
    cancelled.push(e.defaultPrevented)
    if (cancelled.length === 1 && e.defaultPrevented) dead = true
    if (cancelled.length === 1 && !e.defaultPrevented && body.scrollHeight - body.clientHeight <= 0) handedOn = true
    if (cancelled.length === 1 && !e.defaultPrevented && at !== 'grab') { native = true; target.dispatchEvent(pe('pointercancel')) }
    // the native pan (modelled): the list follows the finger unless the touch is dead
    if (!dead && !e.defaultPrevented) body.scrollTop -= dy
    lowest = Math.max(lowest, tops().sheet)
  }
  if (!native) target.dispatchEvent(pe('pointerup'))
  target.dispatchEvent(ev('touchend'))
  return { target: target.className || target.tagName, cancelled: cancelled.map((c) => (c ? 'X' : '.')).join(''), handedOn, before, during: { sheetLowest: lowest }, after: { ...tops(), list: body.scrollTop } }
}

// the installed app's own test (lib/installPrompt · isStandalone) answers «yes», as on the home screen
function standalone() {
  const mm = window.matchMedia.bind(window)
  const yes = (q) => ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })
  window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? yes(q) : mm(q))
  Object.defineProperty(navigator, 'standalone', { get: () => true })
}

const frames = (page, n = 4) => page.evaluate((n) => new Promise((ok) => { const f = (i) => (i ? requestAnimationFrame(() => f(i - 1)) : ok()); f(n) }), n)

let red = 0
const check = (label, ok, detail) => { console.log(`${ok ? 'green' : 'RED  '} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`); if (!ok) red++ }

const browser = await webkit.launch()
let page

/** A signed-in Karte in one frame (head of this file). */
async function openKarte(frame) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: frame.viewport, screen: frame.screen, baseURL: BASE, serviceWorkers: 'block' })
  if (frame.standalone) await ctx.addInitScript(standalone)
  // the safe area: desktop WebKit reads every env(safe-area-inset-*) as 0 — the app's CSS and
  // modules get the installed app's numbers written in their place
  if (frame.safe) {
    const origin = new URL(BASE).origin
    await ctx.route((u) => u.origin === origin, async (route) => {
      const res = await route.fetch().catch(() => null)
      if (!res) return route.continue()
      if (!/javascript|css|html/.test(res.headers()['content-type'] ?? '')) return route.fulfill({ response: res })
      const body = (await res.text()).replaceAll('env(safe-area-inset-top)', `${frame.safe.top}px`).replaceAll('env(safe-area-inset-bottom)', `${frame.safe.bottom}px`)
      return route.fulfill({ response: res, body })
    })
  }
  await ctx.addInitScript(fakeKeyboard)
  await ctx.addInitScript(() => { try { sessionStorage.setItem('kp.karte.view', JSON.stringify({ center: [7.555, 47.515], zoom: 16, bearing: 0, objectId: null, surface: 'karte' })) } catch { /* private mode */ } })
  page = await ctx.newPage()
  await page.goto('/')
  await page.locator('.roster-tile, [data-karte], .topbar').first().waitFor({ timeout: 30000 })
  if (await page.locator('.roster-tile').first().isVisible().catch(() => false)) {
    await page.locator('.roster-tile').first().click()
    await page.locator('.pinpad').waitFor()
    for (const d of PIN) await page.keyboard.press(d)
    await page.keyboard.press('Enter')
    await page.locator('[data-karte], .topbar').first().waitFor({ timeout: 30000 })
  }
  await page.goto('/karte')
  await page.locator('[data-karte-search-open]').waitFor({ timeout: 30000 })
  return ctx
}

const UP = [[0, -3], [0, -8], [0, -12], [0, -12], [0, -12], [0, -12]] // a clean push up: the list scrolls on
const JITTER = [[1, 0], [1, -2], [0, -8], [0, -12], [0, -12], [0, -12]] // the same, its first move a pixel sideways
const BACK = [[0, 3], [0, 8], [0, 12]] // and back down
// the owner's video (review round 7): the list at its top, a finger on a row pulls DOWN, wobbles
// back up and down again in the same touch — the sheet slid down with it and sprang back
const OWNER = [[0, 4], [0, 10], [0, 16], [0, 20], [0, 20], [0, 10], [0, -20], [0, -20], [0, 20], [0, 20]]
const JITTER_DOWN = [[1, 0], [1, 2], [0, 8], [0, 16], [0, 20], [0, 20]] // the same pull, its first move a pixel sideways
const HANDLE = [[0, 6], [0, 12], [0, 16], [0, 16]] // a short pull on the grab bar: the sheet follows, then springs back
const HANDLE_CLOSE = [[0, 10], [0, 30], [0, 40], [0, 40], [0, 40]] // a long one closes it

async function sheetChecks(name, open) {
  await open()
  await frames(page, 6)
  // still DURING the drag too (review round 7: the sheet followed the finger and sprang back)
  const still = (r) => r.before.sheet === r.after.sheet && r.during.sheetLowest === r.before.sheet && r.before.field === r.after.field && !r.handedOn
  const atTop = () => page.evaluate(() => { document.querySelector('[data-karte-keysheet] .lc-body').scrollTop = 0 })
  // the grab bar is the sheet's handle: the same pull there moves the sheet, and lets it go back
  const followed = (r, back) => r.during.sheetLowest - r.before.sheet >= 20 && back.before.sheet === r.before.sheet
  // the snap back is a short transition: read the sheet's place once it has run
  // (up to 1.5 s: on a loaded box the 0.4 s it used to wait was not always enough — the sheet was
  // still on its way back, red on the base without a code change)
  const pullGrab = async (moves) => {
    const r = await page.evaluate(drag, [moves, 'grab'])
    await page.waitForFunction((top) => Math.round(document.querySelector('[data-karte-keysheet]').getBoundingClientRect().top - window.visualViewport.offsetTop) === top, r.before.sheet, { timeout: 1500 }).catch(() => {})
    return [r, await page.evaluate(drag, [])]
  }
  const roomNow = () => page.locator('[data-karte-keysheet] .lc-body').evaluate((b) => b.scrollHeight - b.clientHeight)
  // a list with nothing to scroll: NOTHING moves — the list stays, and no move goes on to the page
  const scrolled = (r, room, dir = 1) => (room <= 0 ? r.after.list === r.before.list : dir * (r.after.list - r.before.list) > 0)
  // without the keyboard
  await page.locator('[data-karte-keysheet] input').evaluate((el) => el.blur())
  await frames(page)
  let room = await roomNow()
  let r = await page.evaluate(drag, UP)
  check(`${name} · no keyboard · a push up ${room > 0 ? 'scrolls the list' : 'moves nothing'} (${room}px to scroll), sheet + field stay`, scrolled(r, room) && still(r), r)
  r = await page.evaluate(drag, BACK)
  check(`${name} · no keyboard · a pull down moves nothing but the list, sheet + field stay`, still(r), r)
  await atTop()
  r = await page.evaluate(drag, OWNER)
  check(`${name} · no keyboard · list at its top, a pull down on a row (owner's video): the sheet stays during and after`, still(r), r)
  let back
  ;[r, back] = await pullGrab(HANDLE)
  check(`${name} · no keyboard · the same pull on the grab bar moves the sheet, and it springs back`, followed(r, back), { r, back: back.before })
  // the keyboard comes back with a tap on the field: focused WITHOUT Safari's scroll-to-field
  // (lib/iosKeyboard · noPanTouchEnd cancels the tap's native focus and focuses with the field
  // lifted out of reach) — Safari's own focus pans the page to the field, «the whole sheet moves»
  const tap = await page.locator('[data-karte-keysheet] input').evaluate((el) => {
    const e = new Event('touchend', { bubbles: true, cancelable: true, composed: true })
    for (const k of ['touches', 'targetTouches']) Object.defineProperty(e, k, { value: [] })
    Object.defineProperty(e, 'changedTouches', { value: [{ identifier: 1, target: el, clientX: 0, clientY: 0 }] })
    el.dispatchEvent(e)
    return { nativeFocusCancelled: e.defaultPrevented, focused: document.activeElement === el }
  })
  check(`${name} · a tap on the field takes the caret without Safari's pan`, tap.nativeFocusCancelled && tap.focused, tap)
  await page.evaluate(() => { document.querySelector('[data-karte-keysheet] .lc-body').scrollTop = 0 })
  // the keyboard up (the field has the caret)
  await page.locator('[data-karte-keysheet] input').focus()
  await page.evaluate((kb) => window.__kb({ kb, pan: 0 }), KEYBOARD)
  await frames(page, 6)
  // the frame with the keys up (review round 8, the installed app): the sheet stands ON the keys,
  // its top under the bar, all of it inside the view — and nothing outside it has room to scroll
  // (hypotheses a and c: a document taller than the view, a sheet box past the visible band)
  const box = await page.evaluate((kb) => {
    const sh = document.querySelector('[data-karte-keysheet]').getBoundingClientRect()
    const bar = document.querySelector('.topbar').getBoundingClientRect()
    const doc = document.scrollingElement, root = document.getElementById('root')
    return { foot: Math.round(sh.bottom), keys: window.innerHeight - kb, top: Math.round(sh.top), bar: Math.round(bar.bottom), inner: window.innerHeight,
      doc: doc.scrollHeight - doc.clientHeight, root: root.scrollHeight - root.clientHeight, body: document.body.scrollHeight - document.body.clientHeight }
  }, KEYBOARD)
  console.log(`[DEBUG-pwa] ${name} · keyboard · ${JSON.stringify(box)}`)
  check(`${name} · keyboard · the sheet stands on the keys, its top under the bar`, Math.abs(box.foot - box.keys) <= 1 && box.top >= box.bar && box.foot <= box.inner, box)
  check(`${name} · keyboard · nothing outside the sheet has room to scroll (document, body, #root)`, box.doc <= 0 && box.root <= 0 && box.body <= 0, box)
  room = await roomNow()
  r = await page.evaluate(drag, UP)
  check(`${name} · keyboard · a push up ${room > 0 ? 'scrolls the list' : 'moves nothing'} (${room}px to scroll), sheet + field stay`, scrolled(r, room) && still(r), r)
  r = await page.evaluate(drag, BACK)
  check(`${name} · keyboard · and back down in a new touch`, scrolled(r, room, -1) && still(r), r)
  await page.evaluate(() => { document.querySelector('[data-karte-keysheet] .lc-body').scrollTop = 0 })
  r = await page.evaluate(drag, JITTER)
  check(`${name} · keyboard · a first move a pixel sideways still ${room > 0 ? 'scrolls the list' : 'moves nothing'}`, scrolled(r, room) && still(r), r)
  await atTop()
  r = await page.evaluate(drag, OWNER)
  check(`${name} · keyboard · list at its top, a pull down on a row (owner's video): the sheet stays during and after`, still(r) && r.after.list === 0, r)
  await atTop()
  r = await page.evaluate(drag, JITTER_DOWN)
  check(`${name} · keyboard · the same pull, first move a pixel sideways: the sheet stays`, still(r) && r.after.list === 0, r)
  ;[r, back] = await pullGrab(HANDLE)
  check(`${name} · keyboard · the same pull on the grab bar moves the sheet, and it springs back`, followed(r, back), { r, back: back.before })
  // iOS pans the page anyway (a drag it did not hand to the list, a momentum end) and ignores the
  // scrollTo(0, 0) that would undo it while the touch runs: the sheet and its field stay on the screen
  const t0 = await page.evaluate(drag, [])
  await page.evaluate(() => window.__kb({ pan: 90, ignoreScrollTo: true }))
  await frames(page, 6)
  const t1 = await page.evaluate(drag, [])
  check(`${name} · keyboard · iOS pans the page by 90px: field + sheet top stay on the screen`, t0.before.field === t1.before.field && t0.before.sheet === t1.before.sheet, { before: t0.before, panned: t1.before })
  await page.evaluate(() => window.__kb({ kb: 0, pan: 0, ignoreScrollTo: false }))
  await page.locator('[data-karte-keysheet] input').evaluate((el) => el.blur())
  await frames(page, 6)
  // a long pull on the grab bar closes the sheet (the only drag that may)
  await page.evaluate(drag, [HANDLE_CLOSE, 'grab'])
  const closed = await page.locator('[data-karte-keysheet]').waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)
  check(`${name} · a long pull on the grab bar closes the sheet`, closed, {})
  if (!closed) {
    await page.locator('[data-karte-keysheet] .lc-x').click()
    await page.locator('[data-karte-keysheet]').waitFor({ state: 'detached' })
  }
}

for (const name of (process.env.KARTE_FRAMES ?? 'tab,app').split(',')) {
  const frame = FRAMES[name]
  KEYBOARD = frame.kb
  const tag = `[${name}] `
  const ctx = await openKarte(frame)
  check(`${tag}the app sees itself as ${frame.standalone ? 'the installed app (standalone)' : 'a browser tab'}`, await page.evaluate(() => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) === frame.standalone, {})
  // nothing typed (review round 6, owner: «when i typed it works, without typing it fails (empty
  // state)»): the featured Einsatzobjekte and the hint lines — shorter than the sheet without the keys
  await sheetChecks(`${tag}Suche leer`, async () => {
    await page.locator('[data-karte-search-open]').click()
    await page.locator('[data-karte-keysheet] [role="option"]').first().waitFor()
  })
  await sheetChecks(`${tag}Suche «strasse»`, async () => {
    await page.locator('[data-karte-search-open]').click()
    await page.locator('[data-karte-keysheet] input').fill('strasse')
    await page.locator('[data-karte-keysheet] [role="option"]').nth(6).waitFor()
  })
  // the green reference: Gefahrgut with a long readout (1203, Benzin)
  await sheetChecks(`${tag}Gefahrgut 1203`, async () => {
    await page.locator('.nav-btn, button').filter({ hasText: /^Gefahrgut$/ }).last().click()
    await page.locator('#karte-un').fill('1203')
    await page.locator('[data-karte-keysheet] .lc-body').getByText(/Benzin|Gasoline|Essence|Benzina/i).first().waitFor()
  })
  await ctx.close()
}

await browser.close()
console.log(red ? `${red} RED` : 'all green')
process.exit(red ? 1 : 0)
