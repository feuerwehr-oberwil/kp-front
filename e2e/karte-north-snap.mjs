// The Karte settles on north when a two-finger turn is let go just off it (owner, review round 6,
// 18.10.2026, iPhone: «add a small snap to north too like other places»; picked: ±5° on release,
// a clear turn further stays — lib/mapTwist · NORTH_SNAP_DEG). A device-class check, not a
// Playwright spec: Chromium at iPhone size with REAL touch input (CDP `Input.dispatchTouchEvent`,
// so MapLibre's own touch handlers and the twist gate see the gesture as on a phone), run by hand
// against a running stack:
//
//   LD_LIBRARY_PATH=… node e2e/karte-north-snap.mjs http://127.0.0.1:5120   (PIN 000000 stack)
//
// Chromium, not WebKit: WebKit on this box draws the map only for a few seconds. The bearing is
// read from the Karte's saved view (`kp.karte.view`, written on every settled camera change).
//
// Exit code 1 and «RED» lines when a check fails.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const browser = await chromium.launch()
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS_UA, serviceWorkers: 'block' })
await ctx.route(/basemaps\.cartocdn\.com\//, (r) => r.abort())
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)

await page.goto('/')
await page.locator('.roster-tile, [data-karte], .topbar').first().waitFor({ timeout: 30000 })
if (await page.locator('.roster-tile').first().isVisible().catch(() => false)) {
  await page.locator('.roster-tile').first().click()
  await page.locator('.pinpad').waitFor({ timeout: 10000 })
  for (const d of PIN) await page.keyboard.press(d)
  await page.keyboard.press('Enter')
  await page.locator('[data-karte], .topbar').first().waitFor({ timeout: 30000 })
}

const bearing = () => page.evaluate(() => { try { return JSON.parse(sessionStorage.getItem('kp.karte.view') ?? '{}').bearing ?? 0 } catch { return NaN } })
const toNorth = (b) => { const n = ((b % 360) + 360) % 360; return Math.min(n, 360 - n) }

/** start every case from exactly north: a fresh Karte at bearing 0 */
async function fresh() {
  await page.evaluate(() => sessionStorage.setItem('kp.karte.view', JSON.stringify({ center: [7.555, 47.515], zoom: 16, bearing: 0, objectId: null, surface: 'karte' })))
  await page.goto('/karte')
  await page.locator('.maplibregl-canvas').waitFor({ timeout: 30000 })
  await page.waitForTimeout(1500)
}

/** two fingers 200 px apart on the map's middle, turned by `deg` (clockwise on screen) in small
 *  steps, then both lifted. The twist gate takes the first 12° (TWIST_ENGAGE_DEG) without turning
 *  the map, so the map ends ≈ `deg − 12` off north. */
async function twist(deg) {
  const box = await page.locator('.maplibregl-canvas').boundingBox()
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.45, r = 100
  const pts = (a) => {
    const t = (a * Math.PI) / 180
    return [{ x: cx - r * Math.cos(t), y: cy - r * Math.sin(t), id: 0 }, { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t), id: 1 }]
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(0) })
  const steps = Math.max(8, Math.round(Math.abs(deg)))
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts((deg * i) / steps) })
    await page.waitForTimeout(16)
  }
  // hold still a moment, as a finger does before it lifts — no fling
  for (let i = 0; i < 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(deg) }); await page.waitForTimeout(30) }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  // the settle ease is short (NORTH_SNAP_MS, 200 ms) – so short that the saved view already says
  // north 600 ms after the lift. MapLibre's own built-in snap (`bearingSnap`, eased over a fixed
  // 1 s, live unnoticed until 18.10.2026) fails this read: that slow drift is what nobody saw.
  await page.waitForTimeout(600)
}

let red = 0
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'RED ', what); if (!ok) red++ }

// a turn let go ≈2° off north settles on exactly north
await fresh()
await twist(15)
let b = await bearing()
check(toNorth(b) < 0.01, `release ≈2° off north settles on north (bearing ${b.toFixed(2)}°)`)

// …the other way round too
await fresh()
await twist(-16)
b = await bearing()
check(toNorth(b) < 0.01, `release ≈3° the other way settles on north (bearing ${b.toFixed(2)}°)`)

// a clear turn further stays where it was let go
await fresh()
await twist(24)
b = await bearing()
check(toNorth(b) > 8, `release ≈11° off north stays turned (bearing ${b.toFixed(2)}°)`)

// …and one just outside the 5° (inside MapLibre's own 7° and the removed 6°) stays as well
await fresh()
await twist(19)
b = await bearing()
check(toNorth(b) > 5, `release ≈6° off north stays turned (bearing ${b.toFixed(2)}°)`)

await browser.close()
console.log(red ? `${red} RED` : 'all green')
process.exit(red ? 1 : 0)
