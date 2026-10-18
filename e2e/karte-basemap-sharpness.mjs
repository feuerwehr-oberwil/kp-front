// Regression check for «the map is so blurry» (owner, review round 4, 17.10.2026, iPhone, CARTO dark
// at street zoom). Goes RED on the owner's symptom on the device class it lives on: WebKit with the
// iPhone 13 descriptor (deviceScaleFactor 3).
//
//   LD_LIBRARY_PATH=… PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
//     node e2e/karte-basemap-sharpness.mjs --base http://127.0.0.1:5188 [--runs 3] [--zoom 18.2] \
//       [--center 7.5575,47.5143] [--pin 000000] [--force2x] [--live]
//
// The app must be served with a backend that has an account (the first roster tile + `--pin`).
// It measures, per run:
//   · canvas   — the map canvas's device pixels per CSS pixel (MapLibre's pixelRatio);
//   · tiles    — the base tiles the map asked for: zoom level, resolution (@2x or not) and the
//                pixel width actually decoded, hence **device px per source px** = canvas ratio ×
//                256 CSS px ÷ tile width (3.0 = every tile pixel blown up three times);
//   · overzoom — how far past the source's last zoom level the view stretches (2^(want − got));
//   · sharpness — mean squared luminance gradient of a 200 × 200 CSS-px crop at 100 % (higher =
//                crisper; compare runs of the same build and view, not across views).
// RED when a base tile is painted at more than 1.5 device px per source px (an iPhone gets 3.0 from
// 256 px tiles, 1.5 from CARTO's 512 px @2x ones) or when the view overzooms.
//
// CARTO needs the station's key, which a dev box does not hold: by default its tile URLs are answered
// with Stadia's look-alike raster styles under the SAME scheme (`…/{y}.png` 256 px, `…/{y}@2x.png`
// 512 px), so what is measured is the app's choice of tile, not CARTO's drawing. `--live` lets the
// requests through to CARTO (a deployment with its key). `--force2x` answers every 1× CARTO request
// with the 2× picture — the one-variable probe that isolates «no @2x» on an unfixed build.
import { webkit, devices } from '@playwright/test'

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? def : process.argv[i + 1] }
const flag = (name) => process.argv.includes(`--${name}`)
const BASE = arg('base', 'http://127.0.0.1:5188')
const RUNS = Number(arg('runs', '1'))
const ZOOM = Number(arg('zoom', '18.2'))
const CENTER = arg('center', '7.5575,47.5143').split(',').map(Number)
const PIN = arg('pin', '000000')
const FORCE2X = flag('force2x')
const LIVE = flag('live')
const CARTO_MAXZOOM = 20 // the app's `base-carto` maxzoom (data/demoIncident)

/** PNG width from its IHDR chunk */
const pngWidth = (buf) => (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG' ? buf.readUInt32BE(16) : null)

async function standIn(route, seen) {
  const u = new URL(route.request().url())
  const m = u.pathname.match(/^\/(.+)\/(\d+)\/(\d+)\/(\d+)(@2x)?\.png$/)
  if (!m) return route.abort()
  const [, style, z, x, y, r2] = m
  const serve2x = r2 || FORCE2X
  const body = LIVE
    ? Buffer.from(await (await route.fetch({ url: FORCE2X && !r2 ? u.href.replace(/\.png/, '@2x.png') : u.href })).body())
    : Buffer.from(await (await fetch(`https://tiles.stadiamaps.com/tiles/${style.includes('dark') ? 'alidade_smooth_dark' : 'alidade_smooth'}/${z}/${x}/${y}${serve2x ? '@2x' : ''}.png`, { headers: { Referer: 'http://localhost/' } })).arrayBuffer())
  seen.push({ z: Number(z), retinaUrl: !!r2, width: pngWidth(body) })
  return route.fulfill({ status: 200, body, headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' } })
}

async function run(browser) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], baseURL: BASE, serviceWorkers: 'block' })
  const seen = []
  await ctx.route(/basemaps\.cartocdn\.com\//, (r) => standIn(r, seen))
  await ctx.addCookies([{ name: 'kp-front-prefs', url: BASE, value: encodeURIComponent(JSON.stringify({ theme: 'night' })) }])
  const view = JSON.stringify({ center: CENTER, zoom: ZOOM, bearing: 0, objectId: null, surface: 'karte' })
  await ctx.addInitScript((v) => { try { sessionStorage.setItem('kp.karte.view', v); localStorage.removeItem('kp.layers.karte') } catch { /* private mode */ } }, view)
  const page = await ctx.newPage()
  await page.goto('/')
  await page.locator('.roster-tile, [data-karte]').first().waitFor({ timeout: 90_000 })
  if (await page.locator('.roster-tile').first().isVisible()) {
    await page.locator('.roster-tile').first().click()
    await page.locator('.pinpad').waitFor()
    for (const d of PIN) await page.keyboard.press(d)
    await page.keyboard.press('Enter')
  }
  await page.locator('[data-karte]').first().waitFor({ timeout: 90_000 })
  await page.goto('/karte')
  await page.locator('canvas.maplibregl-canvas').first().waitFor({ state: 'attached', timeout: 90_000 })
  seen.length = 0
  await page.waitForTimeout(7000)
  // the zoom the map actually stands at (the viewer keeps its view in the session — a request past
  // the base's last sharp level is clamped there, lib/mapView · baseMaxMapZoom)
  const zoom = await page.evaluate(() => { try { return JSON.parse(sessionStorage.getItem('kp.karte.view') ?? '{}').zoom } catch { return undefined } }) ?? ZOOM
  const canvas = await page.locator('canvas.maplibregl-canvas').first().evaluate((c) => c.width / c.getBoundingClientRect().width)
  // settled = no new tile for 1.5 s, then two crops 1 s apart that agree (a tile still fading in
  // or the arrival snail over the map reads as «blurry» once and never again)
  for (let last = -1; last !== seen.length;) { last = seen.length; await page.waitForTimeout(1500) }
  const blank = await ctx.newPage()
  const measure = async () => blank.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height)
    const L = (x, y) => { const i = (y * width + x) * 4; return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] }
    let sum = 0, n = 0
    for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) { const gx = L(x + 1, y) - L(x, y), gy = L(x, y + 1) - L(x, y); sum += gx * gx + gy * gy; n++ }
    return sum / n
  }, (await page.screenshot({ clip: { x: 95, y: 260, width: 200, height: 200 } })).toString('base64'))
  let sharpness = await measure()
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(1000)
    const again = await measure()
    if (Math.abs(again - sharpness) <= 0.02 * Math.max(again, 1)) break
    sharpness = again
  }
  await ctx.close()
  const widths = [...new Set(seen.map((t) => t.width))]
  const zs = [...new Set(seen.map((t) => t.z))]
  // MapLibre's raster level for 256 px tiles on its 512 px grid, against the finest level it got
  const want = Math.round(zoom + 1)
  const overzoom = 2 ** Math.max(0, want - Math.min(CARTO_MAXZOOM, Math.max(...zs)))
  const devPerSrc = Math.max(...seen.map((t) => (canvas * 256) / (t.width || 256)))
  return { zoom, canvas, tiles: seen.length, retinaUrls: seen.filter((t) => t.retinaUrl).length, widths, zs, overzoom, devPerSrc, sharpness }
}

const browser = await webkit.launch()
let red = false
for (let i = 0; i < RUNS; i++) {
  const r = await run(browser)
  const bad = !(r.tiles > 0) || r.devPerSrc > 1.5 || r.overzoom > 1
  red ||= bad
  console.log(`${bad ? 'RED  ' : 'GREEN'} run ${i + 1}: zoom ${Number(r.zoom).toFixed(2)} · canvas ${r.canvas.toFixed(2)}× · ${r.tiles} tiles z${r.zs.join('/')} (${r.retinaUrls} @2x URLs, decoded ${r.widths.join('/')} px) · ${r.devPerSrc.toFixed(2)} device px per tile px · overzoom ${r.overzoom}× · sharpness ${r.sharpness.toFixed(1)}`)
}
await browser.close()
process.exit(red ? 1 : 0)
