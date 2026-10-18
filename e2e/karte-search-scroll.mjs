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
// It cannot show what only the real iPhone does (where iOS decides to pan); rounds 5–11 had a live
// readout on the phone for that (`?debug=scroll`, removed in round 12 — this check stays).
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
// THE COLLAPSE (review round 9, the owner's readout in the installed app): once a finger touches
// the page with the keyboard up, iOS shrinks `innerHeight` to the visual viewport (793 → 424) and
// scrolls the window by the rest (`scrollY` and `visualViewport.offsetTop` 369), while the
// document and the frame `position: fixed` is laid out in stay 793 tall (`doc 793/793`). The
// stand-in does the same (`collapse`: innerHeight and scrollY report it, the layout stays 793) and
// the app frame checks that the sheet stays on the keys with its field in sight — with iOS keeping
// the scroll, and after a `scrollTo(0, 0)` it does honour.
//
// IN STEPS (review round 10, owner: «still doesn't work reliably. sometimes it does»): while the
// finger is down iOS collapses innerHeight step by step (793 → 711 → 785 …) and scrolls the window
// by each step (`__collapseTo`, `collapsingDrag`); one frame after every step the bar, the sheet,
// its field and the map must stand where they stood at touchstart — with iOS's scroll bounded by
// the root's box and by the full 793-px frame, as only the phone knows which.
//
// THE OWNER'S PICK (review round 11, after the installed app panned the VISUAL viewport under a drag
// with the keys up and the list never scrolled): a drag on the list CLOSES THE KEYBOARD — iOS Mail's
// search. With the keys up a push up / a pull down on a row blurs the field (the stand-in then lowers
// the keys, as iOS does), the sheet leaves the keys, no move on the list is ever cancelled, the top
// bar and the map stay where they were, and the list scrolls: in the same touch as modelled here (the
// touch is never cancelled, so the native pan may go on) and, what holds either way, in the next
// drag. A tap's wobble on a row keeps the caret; a pull on the grab bar keeps moving the sheet.
// With nothing typed the search lists the ~30 objects nearest the map centre, so «Suche leer» has
// room to scroll too.
//
// Exit code 1 and «RED» lines when a check fails.
import { createRequire } from 'node:module'
import path from 'node:path'
import { FRAMES, phoneContext } from './ios-standalone.mjs'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { webkit } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
// the two frames, the keyboard stand-in (`__kb`, `__collapseTo`) and the installed app: shared with
// einsatz-keyboard.mjs (head of ios-standalone.mjs)
let KEYBOARD = 336

/** The owner's round-10 capture as a drag: a finger on a row (the list at its top) wobbles a few px
 *  while iOS collapses the window in steps (`inners`, each through `__collapseTo`). After each step
 *  one frame runs — the handlers' own frames included — and the screen tops of the top bar, the
 *  sheet, its field and the map are read: what the phone paints while the finger is down. */
async function collapsingDrag({ inners, extent }) {
  const raf = () => new Promise((ok) => requestAnimationFrame(() => ok()))
  const vv = window.visualViewport
  const sheet = document.querySelector('[data-karte-keysheet]')
  const body = sheet.querySelector('.lc-body')
  const boxes = { bar: document.querySelector('.topbar'), sheet, field: sheet.querySelector('input'), map: document.querySelector('.maplibregl-map') }
  const tops = () => Object.fromEntries(Object.entries(boxes).map(([k, el]) => [k, Math.round(el.getBoundingClientRect().top - vv.offsetTop)]))
  const r = body.getBoundingClientRect()
  const row = [...body.querySelectorAll('[role="option"]')].map((o) => o.getBoundingClientRect()).find((o) => o.top >= r.top && o.bottom <= Math.min(r.bottom, vv.height))
  const x = r.left + r.width / 2
  let y = row ? row.top + row.height / 2 : r.top + 40
  const target = document.elementFromPoint(x, y)
  const ev = (type) => {
    const t = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y }
    const e = new Event(type, { bubbles: true, cancelable: true, composed: true })
    const list = type === 'touchend' ? [] : [t]
    for (const [k, v] of Object.entries({ touches: list, targetTouches: list, changedTouches: [t] })) Object.defineProperty(e, k, { value: v })
    return e
  }
  const before = tops()
  target.dispatchEvent(ev('touchstart'))
  const worst = { bar: 0, sheet: 0, field: 0, map: 0 }
  const steps = []
  for (const [i, inner] of inners.entries()) {
    y += i % 2 ? -4 : 4
    target.dispatchEvent(ev('touchmove'))
    window.__collapseTo(inner, extent)
    await raf()
    const now = tops()
    for (const k of Object.keys(worst)) if (Math.abs(now[k] - before[k]) > Math.abs(worst[k])) worst[k] = now[k] - before[k]
    steps.push(`${inner}:${window.scrollY}:${now.sheet - before.sheet}`)
  }
  target.dispatchEvent(ev('touchend'))
  return { before, worst, steps: steps.join(' ') }
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
  const caretBefore = document.activeElement === field
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
  // `blurred`: the field had the caret at touchstart and lost it during the touch (round 11)
  return { target: target.className || target.tagName, cancelled: cancelled.map((c) => (c ? 'X' : '.')).join(''), handedOn, before, during: { sheetLowest: lowest }, after: { ...tops(), list: body.scrollTop },
    blurred: caretBefore && document.activeElement !== field, caret: document.activeElement === field }
}

// n frames, then the sheet's glide between its two places done (review round 12, lib/iosKeyboard ·
// useKeySheet · data-ks-move): every check reads the sheet where it comes to rest
const frames = async (page, n = 4) => {
  await page.evaluate((n) => new Promise((ok) => { const f = (i) => (i ? requestAnimationFrame(() => f(i - 1)) : ok()); f(n) }), n)
  await page.waitForFunction(() => !document.querySelector('[data-ks-move]'), null, { timeout: 2000 })
}

/** The sheet's move between its two places while `act` ('blur' | 'focus': the keys going or
 *  coming) switches it (review round 12, owner: from typing to scrolling «isn't that abrupt»).
 *  Frames here are too slow to sample, so the sheet's own transitions are held halfway: `mid` is
 *  its screen top there, `props` what they animate, and the transitions are then finished. */
async function glide(act) {
  const raf = () => new Promise((ok) => requestAnimationFrame(() => ok()))
  const sheet = document.querySelector('[data-karte-keysheet]')
  const top = () => Math.round(sheet.getBoundingClientRect().top - window.visualViewport.offsetTop)
  const from = top()
  if (act === 'blur') sheet.querySelector('input').blur()
  else { sheet.querySelector('input').focus(); window.__kb({ kb: window.__glideKb, pan: 0 }) }
  let moves = []
  for (let i = 0; i < 4 && !moves.length; i++) {
    await raf()
    moves = sheet.getAnimations().filter((a) => a instanceof CSSTransition)
  }
  for (const a of moves) { a.pause(); a.currentTime = 110 }
  const mid = top()
  for (const a of moves) a.finish()
  return { from, mid, to: top(), props: moves.map((a) => a.transitionProperty).join(','), ms: moves.map((a) => a.effect.getTiming().duration)[0] }
}

let red = 0
const check = (label, ok, detail) => { console.log(`${ok ? 'green' : 'RED  '} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`); if (!ok) red++ }

const browser = await webkit.launch()
let page

/** A signed-in Karte in one frame (head of this file). */
async function openKarte(frame) {
  const ctx = await phoneContext(browser, frame, BASE)
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
const WOBBLE = [[1, 2], [-1, 2], [0, -1]] // a tap's wobble on a row: 4 px at most, under the drag slop

async function sheetChecks(name, open, frame) {
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
  // review round 12, owner: «fix the bottom margin» — the list stopped a safe-area band above the
  // sheet's foot, cut by a hard line. It runs to the sheet's bottom edge, and scrolled to its end
  // its last line stands clear of the home indicator (the inset is padding INSIDE the scroll)
  const foot = await page.evaluate((safe) => {
    const sheet = document.querySelector('[data-karte-keysheet]')
    const body = sheet.querySelector('.lc-body')
    body.scrollTop = body.scrollHeight
    const last = body.lastElementChild.getBoundingClientRect().bottom
    const r = { sheet: Math.round(sheet.getBoundingClientRect().bottom), body: Math.round(body.getBoundingClientRect().bottom), last: Math.round(last), clear: window.innerHeight - safe }
    body.scrollTop = 0
    return r
  }, frame.safe?.bottom ?? 0)
  check(`${name} · no keyboard · the list runs to the sheet's foot, its end clear of the home indicator`, foot.body >= foot.sheet - 1 && foot.last <= foot.clear, foot)
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
  const keysUp = async () => {
    await page.locator('[data-karte-keysheet] input').focus()
    await page.evaluate((kb) => window.__kb({ kb, pan: 0 }), KEYBOARD)
    await frames(page, 6)
  }
  // iOS lowers the keys once the field has lost the caret — the stand-in cannot know: told here
  const keysGone = async () => { await page.evaluate(() => window.__kb({ kb: 0, pan: 0, ignoreScrollTo: false, collapse: false, shrink: null })); await frames(page, 6) }
  // the background: the top bar and the map on the screen
  const bg = () => page.evaluate(() => [document.querySelector('.topbar'), document.querySelector('.maplibregl-map')].map((el) => Math.round(el.getBoundingClientRect().top - window.visualViewport.offsetTop)).join(','))
  const offKeys = () => page.evaluate(() => !document.querySelector('[data-karte-keysheet]').hasAttribute('data-kb'))
  await keysUp()
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
  // a tap's wobble on a row (a tap opens the row with the keys up): the caret stays, nothing cancelled
  r = await page.evaluate(drag, WOBBLE)
  check(`${name} · keyboard · a tap's wobble on a row keeps the caret, no move cancelled, the sheet stays`, r.caret && !r.cancelled.includes('X') && still(r), r)
  // round 11, the owner's pick: a drag on the list closes the keyboard and the list scrolls
  const dismisses = async (label, moves, { list } = {}) => {
    await keysUp()
    await atTop()
    const bg0 = await bg()
    const room0 = await roomNow()
    const d = await page.evaluate(drag, moves)
    await keysGone()
    const after = { off: await offKeys(), bg: await bg(), bg0 }
    check(`${name} · keyboard · ${label}: closes the keyboard (field blurred, sheet off the keys), no move cancelled, the sheet not pulled, bar + map unmoved`,
      d.blurred && after.off && !d.cancelled.includes('X') && d.during.sheetLowest === d.before.sheet && !d.handedOn && after.bg === bg0, { d, after })
    if (list) check(`${name} · keyboard · ${label}: ${list.label(room0)}`, list.ok(d, room0), d)
  }
  await dismisses('a push up on a row', UP, { list: { label: (rm) => `the list ${rm > 0 ? 'scrolls in the same touch (modelled: the touch is never cancelled)' : 'has nothing to scroll and moves nothing'} (${rm}px)`, ok: scrolled } })
  await atTop()
  room = await roomNow()
  r = await page.evaluate(drag, UP)
  check(`${name} · keyboard gone · the next push up ${room > 0 ? 'scrolls the list' : 'moves nothing'} (${room}px to scroll), sheet + field stay`, scrolled(r, room) && still(r), r)
  await dismisses('a first move a pixel sideways, then up', JITTER)
  // the owner's video (round 7): the list at its top, a pull down on a row
  await dismisses("a pull down on a row at the list's top (owner's video)", OWNER, { list: { label: () => 'the list stays at its top', ok: (d) => d.after.list === 0 } })
  await dismisses('the same pull, first move a pixel sideways', JITTER_DOWN)
  // round 12: the keys going and coming move the sheet in one glide — frames between its two places
  await keysUp()
  await page.evaluate((kb) => { window.__glideKb = kb }, KEYBOARD)
  const glided = (g) => g.props.includes('bottom') && (g.mid - g.from) * (g.to - g.mid) > 0
  let g = await page.evaluate(glide, 'blur')
  await keysGone()
  check(`${name} · the keys going: the sheet glides down to its place (halfway ${g.mid} between ${g.from} and ${g.to})`, g.to > g.from && glided(g), g)
  g = await page.evaluate(glide, 'focus')
  await frames(page, 6)
  check(`${name} · the keys coming: the sheet glides up onto them (halfway ${g.mid} between ${g.from} and ${g.to})`, g.to < g.from && glided(g), g)
  // the grab bar is the sheet's handle, with the keys up too — and it keeps the caret
  await keysUp()
  ;[r, back] = await pullGrab(HANDLE)
  check(`${name} · keyboard · a pull on the grab bar moves the sheet, it springs back, the caret stays`, followed(r, back) && r.caret && back.caret, { r, back: back.before })
  await keysUp()
  // iOS pans the page anyway (a drag it did not hand to the list, a momentum end) and ignores the
  // scrollTo(0, 0) that would undo it while the touch runs: the sheet and its field stay on the screen
  const t0 = await page.evaluate(drag, [])
  await page.evaluate(() => window.__kb({ pan: 90, ignoreScrollTo: true }))
  await frames(page, 6)
  const t1 = await page.evaluate(drag, [])
  check(`${name} · keyboard · iOS pans the page by 90px: field + sheet top stay on the screen`, t0.before.field === t1.before.field && t0.before.sheet === t1.before.sheet, { before: t0.before, panned: t1.before })
  if (frame.collapse) await collapseChecks(name, frame.collapse)
  await page.evaluate(() => window.__kb({ kb: 0, pan: 0, ignoreScrollTo: false, collapse: false }))
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

/** The installed app's collapse with the keyboard up (review round 9, the owner's readout — head
 *  of this file): the sheet keeps its keyboard placement, its foot on the keys and its top and field
 *  under the bar ON THE SCREEN, both while iOS keeps the window scrolled and after a scrollTo(0, 0)
 *  it honours; a pull on a row in that state moves nothing. On the base the placement went off and
 *  the search sheet stood for a 793-px screen in a window scrolled by 369 — its field above the screen. */
async function collapseChecks(name, { kb, pan }) {
  const at = () => page.evaluate(() => {
    const vv = window.visualViewport
    const sheet = document.querySelector('[data-karte-keysheet]')
    const sh = sheet.getBoundingClientRect()
    const screen = (y) => Math.round(y - vv.offsetTop)
    return { kb: sheet.hasAttribute('data-kb'), inner: window.innerHeight, scrollY: window.scrollY, vvh: Math.round(vv.height), pan: Math.round(vv.offsetTop),
      top: screen(sh.top), foot: screen(sh.bottom), field: screen(sheet.querySelector('input').getBoundingClientRect().top),
      bar: screen(document.querySelector('.topbar').getBoundingClientRect().bottom) }
  })
  const placed = (b) => b.kb && Math.abs(b.foot - b.vvh) <= 1 && b.top >= b.bar && b.field >= b.bar && b.field < b.vvh
  await page.evaluate(({ kb, pan }) => window.__kb({ kb, pan, collapse: true, ignoreScrollTo: true }), { kb, pan })
  await frames(page, 6)
  let b = await at()
  console.log(`[DEBUG-pwa] ${name} · collapse · ${JSON.stringify(b)}`)
  check(`${name} · collapse (innerHeight ${b.inner}, scrollY ${b.scrollY}): the sheet stays on the keys, its top and field under the bar on the screen`, placed(b), b)
  await page.evaluate(() => { document.querySelector('[data-karte-keysheet] .lc-body').scrollTop = 0 })
  const r = await page.evaluate(drag, OWNER)
  // round 11: the pull closes the keyboard; the sheet is not pulled during it, no move is cancelled
  check(`${name} · collapse · a pull down on a row (owner's capture): closes the keyboard, no move cancelled, the sheet not pulled`, r.blurred && !r.cancelled.includes('X') && r.during.sheetLowest === r.before.sheet && !r.handedOn, r)
  await page.locator('[data-karte-keysheet] input').focus()
  // iOS honours a scrollTo(0, 0) again: the window back at the top, innerHeight still collapsed
  await page.evaluate(() => { window.__kb({ ignoreScrollTo: false }); window.scrollTo(0, 0) })
  await frames(page, 6)
  b = await at()
  check(`${name} · collapse, window back at 0: the sheet stays on the keys, top and field under the bar`, placed(b) && b.scrollY === 0, b)
  // review round 10: the collapse in STEPS while the finger is down (the owner's readout, inner
  // 793 → 756 → 711 → 690 → 666 … and back) — at every step nothing moves on the screen, whatever
  // bounds iOS's scroll on the phone (`__collapseTo`). On the base iOS scrolled by each step, the
  // undo came a frame late and ran out after six (`mayCorrect`), the app rode up to ~127 px.
  await page.evaluate(() => { window.__kb({ collapse: false, shrink: null, pan: 0 }); document.querySelector('[data-karte-keysheet] .lc-body').scrollTop = 0 })
  await frames(page, 6)
  for (const extent of ['icb', 'html']) {
    const g = await page.evaluate(collapsingDrag, { inners: STEPS, extent })
    await page.evaluate(() => window.__kb({ collapse: false, shrink: null, pan: 0 }))
    await frames(page, 6)
    console.log(`[DEBUG-pwa] ${name} · stepped collapse (${extent}) · ${g.steps}`)
    check(`${name} · collapse in steps during the touch (${extent} bounds the scroll): bar, sheet, field and map hold within 2px at every step`, Object.values(g.worst).every((d) => Math.abs(d) <= 2), { worst: g.worst, steps: g.steps })
  }
}
// the owner's readout, round 10: innerHeight while the finger was down (2 fps, filled in between)
const STEPS = [756, 711, 690, 666, 690, 740, 782, 792, 785, 740, 711, 666, 711, 785, 793]

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
  }, frame)
  await sheetChecks(`${tag}Suche «strasse»`, async () => {
    await page.locator('[data-karte-search-open]').click()
    await page.locator('[data-karte-keysheet] input').fill('strasse')
    await page.locator('[data-karte-keysheet] [role="option"]').nth(6).waitFor()
  }, frame)
  // the green reference: Gefahrgut with a long readout (1203, Benzin)
  await sheetChecks(`${tag}Gefahrgut 1203`, async () => {
    await page.locator('.nav-btn, button').filter({ hasText: /^Gefahrgut$/ }).last().click()
    await page.locator('#karte-un').fill('1203')
    await page.locator('[data-karte-keysheet] .lc-body').getByText(/Benzin|Gasoline|Essence|Benzina/i).first().waitFor()
  }, frame)
  await ctx.close()
}

await browser.close()
console.log(red ? `${red} RED` : 'all green')
process.exit(red ? 1 : 0)
