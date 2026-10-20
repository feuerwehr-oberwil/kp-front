// The «Anderes Objekt» chooser's preview map must never be a silent empty pane (owner, Karte
// Haus round 7, point 17: «When opening Andres Objekt the map stayed empty and looks rather
// sad»). Its pins are DOM markers, so they keep drawing over a base map that never arrived —
// the half-drawn pane he screenshotted, which reads as a crash rather than as «no tiles».
//
// Two runs against the same stack:
//   · tiles SERVED   → the base map paints (the pane is not one flat colour) and no banner
//   · tiles REFUSED  → the pane says what it is (`.pp-map-blank`), with the pins still on it
//
// A browser check, not a unit test: the thing under test is whether MapLibre's tile events reach
// our state, which jsdom has no canvas for. Chromium — the map needs it (shots.mjs · PHONE).
// Run by hand against a running stack:
//
//   LD_LIBRARY_PATH=… node e2e/planpicker-preview.mjs http://127.0.0.1:5120
//
// Exit code 1 and «RED» lines when a blank preview stays silent, or a served one is blank.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
const SITE = { lat: 47.5136, lng: 7.5496 }

const browser = await chromium.launch()

/** how many distinct colours a PNG holds — a painted map is many, an empty pane a handful */
const decoder = await (await browser.newContext()).newPage()
await decoder.goto('data:text/html,<body>')
const distinctColours = (buf) => decoder.evaluate(async (b64) => {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, img.width, img.height).data
  const seen = new Set()
  for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`)
  return seen.size
}, buf.toString('base64'))

/** open an Einsatz, go to a Modul and open the object chooser; `tiles: false` refuses base tiles */
async function chooser({ tiles }) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' })
  // Every base-map host this deployment can be configured with. Refusing them is what an
  // offline stairwell, a withheld CARTO key and a blocked host all look like to MapLibre.
  if (!tiles) await ctx.route(/basemaps\.cartocdn\.com\/|tile\.openstreetmap\.org\/|wmts\.geo\.admin\.ch\//, (r) => r.abort())
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
  // a running Einsatz for the chooser to be reachable from (the chip lives on a Modul surface)
  const made = await page.request.post('/api/incidents', { data: { title: 'Preview check', type: 'Brand', lat: SITE.lat, lng: SITE.lng, is_exercise: true } })
  if (made.status() !== 201) throw new Error(`create incident: ${made.status()} ${await made.text()}`)
  await page.goto('/')
  await page.getByRole('button', { name: 'Modul 1', exact: true }).click({ timeout: 30000 })
  await page.locator('.wb-object').first().click({ timeout: 30000 })
  await page.locator('.pp-map').waitFor({ timeout: 30000 })
  await page.waitForTimeout(6000)
  return { ctx, page }
}

let red = 0
const say = (ok, line) => { if (!ok) red++; console.log(`${ok ? 'ok  ' : 'RED '}${line}`) }

{
  const { ctx, page } = await chooser({ tiles: false })
  const blank = await page.locator('.pp-map-blank').count()
  const pins = await page.locator('.pp-map .pp-pin').count()
  say(blank === 1, `no base tiles: the pane says what it is (.pp-map-blank ×${blank}, expected 1)`)
  say(pins > 0, `no base tiles: the object pins still draw (×${pins})`)
  await page.screenshot({ path: '.x-planpicker-no-tiles.png', clip: await page.locator('.pp-map').boundingBox() })
  await ctx.close()
}

{
  const { ctx, page } = await chooser({ tiles: true })
  const blank = await page.locator('.pp-map-blank').count()
  say(blank === 0, `base tiles served: no banner over a map that painted (.pp-map-blank ×${blank}, expected 0)`)
  // A painted raster map is many colours; an empty pane is a handful. Measured off a
  // SCREENSHOT, not `readPixels`: MapLibre runs without `preserveDrawingBuffer`, so its drawing
  // buffer is already cleared by the time a reader gets to it and every sample comes back flat.
  // ⚠️ Without a CARTO key this box is served CARTO's «API KEY REQUIRED» watermark tiles — a
  // 200, so they paint, and the check passes on what it actually asserts: the pane is not blank.
  const png = await page.screenshot({ path: '.x-planpicker-tiles.png', clip: await page.locator('.pp-map').boundingBox() })
  const colours = await distinctColours(png)
  say(colours > 8, `base tiles served: the preview painted something (${colours} distinct colours)`)
  await ctx.close()
}

await browser.close()
console.log(red ? `\n${red} RED` : '\nall green')
process.exit(red ? 1 : 0)
