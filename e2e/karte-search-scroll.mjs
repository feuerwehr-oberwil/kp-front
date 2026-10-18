// The Karte's phone search: only the result list scrolls (owner, review round 5, 18.10.2026,
// iPhone: «Scrolling in the search input still messes up things and doesnt work (gefahrgut scroll
// works though)» — «the whole sheet/page moves instead of the list, and it is worse while the
// keyboard is open»). A device-class check, not a Playwright spec: WebKit at iPhone 13 size,
// run by hand against a running stack (docs/karte-objekte.md · «Search: only the list scrolls»).
//
//   LD_LIBRARY_PATH=… node e2e/karte-search-scroll.mjs http://127.0.0.1:5130   (PIN 000000 stack)
//
// What WebKit on Linux cannot do, and how this stands in for it:
//   · no native touch scrolling (Playwright has no touch drag, mobile WebKit no wheel): the drag is
//     dispatched as touchstart/touchmove/touchend EVENTS, so every JS guard sees it as on the
//     phone, and the list's native scroll is modelled — it follows the finger unless the FIRST
//     touchmove was cancelled (iOS: a cancelled first touchmove cancels the native pan for the
//     whole touch, see lib/overlays/useMobileScrollLock);
//   · no software keyboard: `visualViewport` is replaced by a stand-in whose height shrinks by the
//     keyboard and whose `offsetTop` is iOS's pan of the page («the whole page moves»); positions
//     are read on the SCREEN (layout px − pan). `scrollTo(0, 0)` undoes the pan as on iOS — except
//     in the «iOS ignores it» step, as iOS does during a running touch or momentum scroll.
// It cannot show what only the real iPhone does (where iOS decides to pan); for that the Karte has
// `?debug=scroll` (components/karte/KarteScrollDebug).
//
// Exit code 1 and «RED» lines when a check fails.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { webkit, devices } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
const KEYBOARD = 336 // an iPhone 13's German keyboard with the suggestion bar, px

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

/** A one-finger drag over the sheet's body: `moves` are [dx, dy] steps of the finger. Returns
 *  which moves a guard cancelled and the screen tops before/after. */
function drag(moves) {
  const pan = window.visualViewport.offsetTop
  const sheet = document.querySelector('[data-karte-keysheet]')
  const body = sheet.querySelector('.lc-body')
  const field = sheet.querySelector('input')
  const r = body.getBoundingClientRect()
  let x = r.left + r.width / 2, y = r.top + Math.min(r.height * 0.5, 160)
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
  target.dispatchEvent(ev('touchstart'))
  let dead = false
  const cancelled = []
  for (const [dx, dy] of moves) {
    x += dx; y += dy
    const e = ev('touchmove')
    target.dispatchEvent(e)
    cancelled.push(e.defaultPrevented)
    if (cancelled.length === 1 && e.defaultPrevented) dead = true
    // the native pan (modelled): the list follows the finger unless the touch is dead
    if (!dead && !e.defaultPrevented) body.scrollTop -= dy
  }
  target.dispatchEvent(ev('touchend'))
  return { target: target.className || target.tagName, cancelled: cancelled.map((c) => (c ? 'X' : '.')).join(''), before, after: { ...tops(), list: body.scrollTop } }
}

const frames = (page, n = 4) => page.evaluate((n) => new Promise((ok) => { const f = (i) => (i ? requestAnimationFrame(() => f(i - 1)) : ok()); f(n) }), n)

let red = 0
const check = (label, ok, detail) => { console.log(`${ok ? 'green' : 'RED  '} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`); if (!ok) red++ }

const browser = await webkit.launch()
const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, baseURL: BASE, serviceWorkers: 'block' })
await ctx.addInitScript(fakeKeyboard)
await ctx.addInitScript(() => { try { sessionStorage.setItem('kp.karte.view', JSON.stringify({ center: [7.555, 47.515], zoom: 16, bearing: 0, objectId: null, surface: 'karte' })) } catch { /* private mode */ } })
const page = await ctx.newPage()
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

const UP = [[0, -3], [0, -8], [0, -12], [0, -12], [0, -12], [0, -12]] // a clean push up: the list scrolls on
const JITTER = [[1, 0], [1, -2], [0, -8], [0, -12], [0, -12], [0, -12]] // the same, its first move a pixel sideways
const BACK = [[0, 3], [0, 8], [0, 12]] // and back down

async function sheetChecks(name, open) {
  await open()
  await frames(page, 6)
  const still = (r) => r.before.sheet === r.after.sheet && r.before.field === r.after.field
  // without the keyboard
  await page.locator('[data-karte-keysheet] input').evaluate((el) => el.blur())
  await frames(page)
  let r = await page.evaluate(drag, UP)
  const room = await page.locator('[data-karte-keysheet] .lc-body').evaluate((b) => b.scrollHeight - b.clientHeight)
  check(`${name} · no keyboard · a push up scrolls the list (${room}px to scroll), sheet + field stay`, (room <= 0 || r.after.list > r.before.list) && still(r), r)
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
  r = await page.evaluate(drag, UP)
  check(`${name} · keyboard · a push up scrolls the list, sheet + field stay`, r.after.list > r.before.list && still(r), r)
  r = await page.evaluate(drag, BACK)
  check(`${name} · keyboard · and back down in a new touch`, r.after.list < r.before.list && still(r), r)
  await page.evaluate(() => { document.querySelector('[data-karte-keysheet] .lc-body').scrollTop = 0 })
  r = await page.evaluate(drag, JITTER)
  check(`${name} · keyboard · a first move a pixel sideways still scrolls the list`, r.after.list > r.before.list && still(r), r)
  // iOS pans the page anyway (a drag it did not hand to the list, a momentum end) and ignores the
  // scrollTo(0, 0) that would undo it while the touch runs: the sheet and its field stay on the screen
  const t0 = await page.evaluate(drag, [])
  await page.evaluate(() => window.__kb({ pan: 90, ignoreScrollTo: true }))
  await frames(page, 6)
  const t1 = await page.evaluate(drag, [])
  check(`${name} · keyboard · iOS pans the page by 90px: field + sheet top stay on the screen`, t0.before.field === t1.before.field && t0.before.sheet === t1.before.sheet, { before: t0.before, panned: t1.before })
  await page.evaluate(() => window.__kb({ kb: 0, pan: 0, ignoreScrollTo: false }))
  await page.locator('[data-karte-keysheet] .lc-x').click()
  await page.locator('[data-karte-keysheet]').waitFor({ state: 'detached' })
}

await sheetChecks('Suche «strasse»', async () => {
  await page.locator('[data-karte-search-open]').click()
  await page.locator('[data-karte-keysheet] input').fill('strasse')
  await page.locator('[data-karte-keysheet] [role="option"]').nth(6).waitFor()
})
// the green reference: Gefahrgut with a long readout (1203, Benzin)
await sheetChecks('Gefahrgut 1203', async () => {
  await page.locator('.nav-btn, button').filter({ hasText: /^Gefahrgut$/ }).last().click()
  await page.locator('#karte-un').fill('1203')
  await page.locator('[data-karte-keysheet] .lc-body').getByText(/Benzin|Gasoline|Essence|Benzina/i).first().waitFor()
})

await browser.close()
console.log(red ? `${red} RED` : 'all green')
process.exit(red ? 1 : 0)
