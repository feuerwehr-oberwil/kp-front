// Back on the Karte from a plan, the selected object stands in the middle of the free map (owner,
// Karte Haus review round 6, 20.10.2026, desktop Chrome: «When having opened a plan (a module)
// and then going back to the map, sometimes the object isn't neatly in focus like it should be»
// — Konsumstrasse 1-3, selected with a tap on one of its houses, off at the bottom right).
// The free map = right of the object panel, left of the tool rail, under the bar. A device-class
// check, not a Playwright spec: Chromium (the map draws), run by hand against a running stack
// with the golden data (Konsumstrasse 1-3, Im Wasen 1-8):
//
//   LD_LIBRARY_PATH=… node e2e/karte-plan-back-camera.mjs http://127.0.0.1:5120   (PIN 000000 stack)
//
// Each case selects an object, opens its first plan, goes back with the rail's Karte button and
// reads where the object's selected name tag (its point) stands. Exit code 1 and «RED» lines when one is more than 12 px off the free map's middle.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
const KONSUM = '4afdeff5-4914-51c0-94ba-78bf51073fab'
const WASEN = '91d42b96-3787-52a3-b425-d7b7bd6ae0bc'
const TOLERANCE = 12

const browser = await chromium.launch()
let red = 0
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'RED ', what); if (!ok) red++ }

async function signedIn(viewport) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport, deviceScaleFactor: 1, serviceWorkers: 'block' })
  await ctx.route(/basemaps\.cartocdn\.com\//, (r) => r.abort())
  const page = await ctx.newPage()
  await page.goto('/')
  await page.locator('.roster-tile, [data-karte], .topbar').first().waitFor({ timeout: 30000 })
  if (await page.locator('.roster-tile').first().isVisible().catch(() => false)) {
    await page.locator('.roster-tile').first().click()
    await page.locator('.pinpad').waitFor({ timeout: 10000 })
    for (const d of PIN) await page.keyboard.press(d)
    await page.keyboard.press('Enter')
    await page.locator('[data-karte], .topbar').first().waitFor({ timeout: 30000 })
  }
  return { ctx, page }
}

/** a fresh Karte with `at` in view, a bit up-left of it — so a tap selection is NOT centred */
async function karte(page, at, zoom = 17.6) {
  await page.evaluate((v) => sessionStorage.setItem('kp.karte.view', JSON.stringify(v)), { center: [at[0] - 0.0012, at[1] + 0.0004], zoom, bearing: 0, objectId: null, surface: 'karte' })
  await page.goto('/karte')
  await page.locator('.maplibregl-canvas').waitFor({ timeout: 30000 })
  await page.locator('[data-karte] .maplibregl-marker button').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(2500)
}

// Web Mercator at MapLibre's 512 px tiles: screen px between two points at `zoom`
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const pxBetween = (a, b, zoom) => {
  const k = (512 * 2 ** zoom) / (2 * Math.PI)
  return { x: ((b[0] - a[0]) * Math.PI / 180) * k, y: -(mercY(b[1]) - mercY(a[1])) * k }
}
const zoomOf = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('kp.karte.view') ?? '{}').zoom)

/** the screen point of a dot or the selected tag of the object at `at` (the marker's middle = the point) */
async function markerAt(page, name) {
  return page.evaluate((n) => {
    const flat = (t) => (t ?? '').replace(/[^\p{L}\p{N}]/gu, '')
    const b = [...document.querySelectorAll('[data-karte] .maplibregl-marker button')].find((x) => flat(x.getAttribute('aria-label')) === flat(n) || flat(x.textContent) === flat(n))
    const r = b?.parentElement?.getBoundingClientRect()
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
  }, name)
}

/** the middle of the free map: right of the panel, left of the tool rail, under the bar */
const freeMiddle = (page) => page.evaluate(() => {
  const root = document.querySelector('[data-karte]').getBoundingClientRect()
  const panel = document.querySelector('[data-karte-panel]')?.getBoundingClientRect()
  const tools = document.querySelector('[data-karte] .tool-rail')?.getBoundingClientRect()
  if (!panel) return null
  return { x: (panel.right + (tools?.left ?? root.right)) / 2, y: (80 + root.bottom) / 2 }
})

async function planAndBack(page) {
  await page.locator('[data-section="plans"] button').first().click()
  await page.waitForTimeout(1500)
  await page.locator('nav.navrail .nav-item').first().click()
  await page.waitForTimeout(1200)
}

/** select `obj` with a tap on a house of it other than the one its point stands in */
async function tapOtherHouse(page, obj) {
  const at = [obj.lng, obj.lat]
  const dot = await markerAt(page, obj.name)
  const zoom = await zoomOf(page)
  const polys = obj.footprint.coordinates.map((p) => p[0])
  const inside = (ring, [x, y]) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c } return c }
  const ring = polys.find((r) => !inside(r, at)) ?? polys[0]
  const mid = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length]
  const d = pxBetween(at, mid, zoom)
  await page.mouse.click(dot.x + d.x, dot.y + d.y)
  await page.waitForTimeout(1200)
}

async function verdict(page, obj, what) {
  const free = await freeMiddle(page)
  const p = await markerAt(page, obj.name)
  if (!free || !p) { check(false, `${what}: no panel or no tag on the map`); return }
  const dx = Math.round(p.x - free.x), dy = Math.round(p.y - free.y)
  check(Math.hypot(dx, dy) <= TOLERANCE, `${what}: ${dx} px / ${dy} px off the free map's middle`)
}

const DESK = { width: 1440, height: 900 }
const TABLET = { width: 1180, height: 820 }
for (const [dn, vp] of [['desktop', DESK], ['tablet', TABLET]]) {
  const { ctx, page } = await signedIn(vp)
  const all = await page.evaluate(async () => (await (await fetch('/api/reference/objects')).json()).objects)
  const konsum = all.find((o) => o.id === KONSUM), wasen = all.find((o) => o.id === WASEN)

  // the owner's case: a tap on one of the object's houses (the switch shows), plan, back
  for (const [obj, label] of [[konsum, 'Konsumstrasse 1-3'], [wasen, 'Im Wasen 1-8']]) {
    await karte(page, [obj.lng, obj.lat])
    await tapOtherHouse(page, obj)
    await planAndBack(page)
    await verdict(page, obj, `${dn} · ${label} · house tap, object level`)
  }

  // a tap on the name tag: no switch
  await karte(page, [konsum.lng, konsum.lat])
  const tag = await markerAt(page, konsum.name)
  await page.mouse.click(tag.x, tag.y)
  await page.waitForTimeout(1200)
  await planAndBack(page)
  await verdict(page, konsum, `${dn} · Konsumstrasse 1-3 · tag tap`)

  // a search pick, rail collapsed and expanded
  for (const expanded of [false, true]) {
    await karte(page, [konsum.lng, konsum.lat])
    if (expanded) { await page.getByRole('button', { name: 'Ausklappen' }).first().click(); await page.waitForTimeout(500) }
    await page.locator('.topbar input').first().click()
    await page.keyboard.type('Konsumstrasse 1')
    await page.waitForTimeout(800)
    await page.getByRole('option').filter({ hasText: 'Altersheim APH Dreilinden' }).first().click()
    await page.waitForTimeout(1200)
    await verdict(page, konsum, `${dn} · Konsumstrasse 1-3 · search pick, rail ${expanded ? 'expanded' : 'collapsed'}`)
    await planAndBack(page)
    await verdict(page, konsum, `${dn} · Konsumstrasse 1-3 · search pick → plan → back, rail ${expanded ? 'expanded' : 'collapsed'}`)
    if (expanded) { await page.getByRole('button', { name: 'Einklappen' }).first().click(); await page.waitForTimeout(300) }
  }
  await ctx.close()
}

await browser.close()
console.log(red ? `${red} RED` : 'all green')
process.exit(red ? 1 : 0)
