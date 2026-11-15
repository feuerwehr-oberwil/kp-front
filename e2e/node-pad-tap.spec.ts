import type { Locator, Page } from '@playwright/test'
import { EINSATZ_RAIL, expect, login, openApp, test } from './helpers'

// A tap on a node pad on the Karte is the pad's, never the map's (round 15.11.2026). Until then
// the pad's click bubbled from its Marker to maplibre's listener on the canvas container, the map
// click found the path's hit band under it, and a node was INSERTED right on the tapped one: a
// selected Linie grew a point per tap (the owner's iPhone: «11 Punkte», the pads stacked on top of
// each other), and the same on a Messung and on a Linie still being drawn. jsdom has no maplibre,
// so only a browser can see the click reach the map (MapView · keepClickOnPad).
//
// Each tap is checked against the control that the map's own route still works: a tap on the line
// BETWEEN two nodes adds one.
//
// …and a DRAG of a node is the node's, never the «+» beside it (same round, «i still got this while
// moving»: node pairs). The «+» and the pads stood on one z level, so mount order decided, and
// MapLibre appends a Marker when it is created: the «+» an insert adds sat on top of the older
// pads, and a finger on a node took the «+» – it inserts on pointer-down and drags the new node, so
// every move left the old node behind as a twin (MapView · insertGripZ). Red on 5e42e896 in
// Chromium and in WebKit's hit test alike.
//
// It opens an Einsatz of its own on a phone (touch) and archives it again afterwards. Red on
// 42e535b8 in Chromium and WebKit alike, finger and mouse alike; it runs on chromium.
//
// ⚠️ OPT-IN (E2E_WORKFLOWS=1), chromium only: it writes an Einsatz – never against a station in use.

test.skip(!process.env.E2E_WORKFLOWS, 'workflow e2e is opt-in (E2E_WORKFLOWS=1): it opens an Einsatz — run it on a private stack')
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', serviceWorkers: 'block' })

type Point = readonly [x: number, y: number]

/** where the four nodes go: the open map below the Einsatz head, above the Gebäude card. The first
 *  segment is long (~200 px), so a quarter along it is clear of both the pad's 44 px hit area and
 *  the «+» at its middle. */
const NODES: Point[] = [[60, 180], [220, 290], [280, 190], [340, 260]]

let incidentId = ''

test.beforeEach(async ({ page, context, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'runs on chromium only')
  const config = await page.request.get('/api/config')
  test.skip(config.ok() && (await config.json()).identity?.demoMode === true, 'opens Einsätze — never against a shared demo')
  await login(page)
  // an Einsatz of its own, remembered as the one picked by hand (lib/prefs) so the open lands in it
  const created = await page.request.post('/api/incidents', { data: { title: `E2E ${testInfo.title.slice(0, 40)}`, lat: 47.523718, lng: 7.570345 } })
  expect(created.status(), 'creating the Einsatz').toBe(201)
  incidentId = (await created.json() as { id: string }).id
  await context.addCookies([{
    name: 'kp-front-prefs', url: new URL(page.url()).origin,
    value: encodeURIComponent(JSON.stringify({ incidentId, incidentChosenAt: Date.now() })),
  }])
  await openApp(page, '/')
  await expect(page.locator(EINSATZ_RAIL)).toBeVisible()
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible()
})

test.afterEach(async ({ page }) => {
  if (incidentId) await page.request.patch(`/api/incidents/${incidentId}`, { data: { is_archived: true } })
  incidentId = ''
})

async function tap(page: Page, [x, y]: Point) {
  await page.touchscreen.tap(x, y)
  await page.waitForTimeout(300) // two taps closer together than this read as a double tap
}

/** the centre of one node pad */
async function centreOf(pad: Locator): Promise<Point> {
  const box = await pad.boundingBox()
  if (!box) throw new Error('the node pad is not on screen')
  return [box.x + box.width / 2, box.y + box.height / 2]
}

/** The centre of one node pad, and that a finger there lands on the pad – not on chrome above
 *  it (the selection bar), where the tap would add nothing and the check pass for nothing. */
async function aimAt(pad: Locator): Promise<Point> {
  const at = await centreOf(pad)
  const onPad = await pad.evaluate((el, [x, y]) => !!el.closest('.maplibregl-marker')?.contains(document.elementFromPoint(x, y)), at)
  expect(onPad, 'the node pad is what a finger at its centre touches').toBe(true)
  return at
}

/** Tap every pad but the last (on a draft that one is the double-tap guard's, mapClick ·
 *  NODE_REPEAT_PX): the count stays. Then tap a quarter of the way along the first segment –
 *  clear of the «+» at its middle: the map's insert still adds one. */
async function padTapsKeepThePoints(page: Page, pads: Locator, what: string) {
  await expect(pads, `${what}: one pad per node`).toHaveCount(NODES.length)
  for (let i = 0; i < NODES.length - 1; i++) {
    await tap(page, await aimAt(pads.nth(i)))
    await expect(pads, `${what}: a tap on node ${i + 1} adds no node`).toHaveCount(NODES.length)
  }
  const [a, b] = [await centreOf(pads.nth(0)), await centreOf(pads.nth(1))]
  await tap(page, [a[0] + (b[0] - a[0]) / 4, a[1] + (b[1] - a[1]) / 4])
  await expect(pads, `${what}: a tap on the line between two nodes still adds one`).toHaveCount(NODES.length + 1)
}

async function drawLinie(page: Page) {
  await page.getByRole('button', { name: /^Hinzufügen/ }).first().tap()
  await page.getByRole('button', { name: 'Linie', exact: true }).first().tap()
  const nodes = page.getByRole('button', { name: 'Punkte', exact: true }).first()
  if (await nodes.getAttribute('aria-pressed') !== 'true') await nodes.tap()
  for (const p of NODES) await tap(page, p)
}

test('a tap on a node of a selected Linie adds no point', async ({ page }) => {
  await drawLinie(page)
  await page.locator('.wb-dock-go').first().tap() // «Fertig» commits it and leaves it selected
  // the sheet's «{n} Punkte» – literal, so the copy guard (e2eSelectors.test) can read it; NODES has 4
  await expect(page.getByText('4 Punkte')).toBeVisible()
  await padTapsKeepThePoints(page, page.locator('.draw-handle'), 'the selected Linie')
  await expect(page.getByText('5 Punkte'), 'the sheet counts what the map shows').toBeVisible()
})

test('a tap on a node of a Messung adds no point', async ({ page }) => {
  await page.getByRole('button', { name: /^Messen/ }).first().tap()
  for (const p of NODES) await tap(page, p)
  await padTapsKeepThePoints(page, page.locator('.measure-handle'), 'the Messung')
})

test('a tap on a node of a Linie still being drawn adds no point', async ({ page }) => {
  await drawLinie(page)
  await padTapsKeepThePoints(page, page.locator('.measure-handle'), 'the open Linie')
})

/** A finger drag the engine itself turns into touch + pointer events (CDP: Playwright's touchscreen
 *  can only tap). */
async function drag(page: Page, [x, y]: Point, [dx, dy]: Point) {
  const cdp = await page.context().newCDPSession(page)
  const at = (k: number) => [{ x: x + dx * k, y: y + dy * k, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) })
  for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k / 8) })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await page.waitForTimeout(300)
}

test('a drag on a node of a selected Linie moves it and adds no point – also beside a fresh «+»', async ({ page }) => {
  await drawLinie(page)
  await page.locator('.wb-dock-go').first().tap()
  const pads = page.locator('.draw-handle')
  // one «+» tapped: the node it adds and the «+» markers it brings are the ones mounted LAST
  await tap(page, await centreOf(page.locator('.measure-insert').nth(2)))
  await expect(page.getByText('5 Punkte')).toBeVisible()
  await expect(pads).toHaveCount(5)
  for (let i = 0; i < 5; i++) {
    // a finger 6 px off the pad's centre, toward the nearest «+» – still well inside the pad
    const c = await centreOf(pads.nth(i))
    const plus = await page.locator('.measure-insert').evaluateAll((els, [cx, cy]) => els
      .map((e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })
      .sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy))[0], c)
    const d = Math.hypot(plus[0] - c[0], plus[1] - c[1]) || 1
    const at: Point = [c[0] + (6 * (plus[0] - c[0])) / d, c[1] + (6 * (plus[1] - c[1])) / d]
    await drag(page, at, [0, 40])
    await expect(pads, `a drag on node ${i + 1} adds no node`).toHaveCount(5)
    const moved = await centreOf(pads.nth(i))
    expect(moved[1] - c[1], `node ${i + 1} followed the finger`).toBeGreaterThan(30)
  }
  await expect(page.getByText('5 Punkte'), 'the sheet counts what the map shows').toBeVisible()
  // the control: a drag that starts on a «+» still adds exactly one
  await drag(page, await centreOf(page.locator('.measure-insert').first()), [0, 40])
  await expect(pads, 'a drag on a «+» adds one node').toHaveCount(6)
})
