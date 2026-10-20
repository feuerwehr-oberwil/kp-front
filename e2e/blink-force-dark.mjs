// Day mode must come out LIGHT even when the browser is force-darkening pages (owner, Karte Haus
// round 7, point 2, on a Samsung tablet: «even though I set it to day, the map somehow turns to
// light mode but everything else stayed dark»).
//
// The mechanism: Blink's force-dark — "Dark mode" in Samsung Internet's settings, "Auto Dark
// Theme" in Chrome — repaints any page that declares a colour scheme it does not support. A bare
// `color-scheme: light` IS that declaration, so our whole day chrome was repainted dark while the
// WebGL map canvas, which no filter touches, stayed light. That is the exact split the owner saw.
// `color-scheme: only light` (CSS Color Adjust) opts out of the adjustment without handing the
// native surfaces back to the OS setting, which `light dark` would (01-tokens.css · the long
// note above the declaration).
//
// A device-class check, not a Playwright spec: force-dark is a paint-stage filter, so
// getComputedStyle still reports the authored colour and only real pixels can show it. Chromium
// with CDP `Emulation.setAutoDarkModeOverride` is what DevTools' own "Emulate auto dark mode"
// does; the browser flags (`--enable-features=WebContentsForceDark`) do nothing headless, checked
// 20.10.2026. Run by hand against a running stack:
//
//   LD_LIBRARY_PATH=… node e2e/blink-force-dark.mjs http://127.0.0.1:5120
//
// The screenshots are decoded in a SECOND, plain browser, so the sampling itself can never be
// force-darkened. Exit code 1 and «RED» lines when day comes out dark or night comes out light.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'

/** mean relative luminance (0–255) of a PNG buffer, measured outside the force-dark browser */
const plain = await chromium.launch()
const decoder = await (await plain.newContext()).newPage()
await decoder.goto('data:text/html,<body>')
const meanLuminance = (buf) => decoder.evaluate(async (b64) => {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, img.width, img.height).data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  return Math.round(sum / (d.length / 4))
}, buf.toString('base64'))

/** the app's top bar, which is pure chrome: no map canvas in the sample */
async function topbarLuminance({ autoDark, theme }) {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    baseURL: BASE, viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2,
    hasTouch: true, serviceWorkers: 'block',
    // the OS preference force-dark keys off — the owner's tablet is in dark mode
    colorScheme: 'dark',
  })
  await ctx.route(/basemaps\.cartocdn\.com\//, (r) => r.abort())
  await ctx.addCookies([{ name: 'kp-front-prefs', url: BASE, value: encodeURIComponent(JSON.stringify({ theme })) }])
  const page = await ctx.newPage()
  if (autoDark) await (await ctx.newCDPSession(page)).send('Emulation.setAutoDarkModeOverride', { enabled: true })
  await page.goto('/')
  await page.locator('.roster-tile, [data-karte], .topbar').first().waitFor({ timeout: 30000 })
  if (await page.locator('.roster-tile').first().isVisible().catch(() => false)) {
    await page.locator('.roster-tile').first().click()
    await page.locator('.pinpad').waitFor({ timeout: 10000 })
    for (const d of PIN) await page.keyboard.press(d)
    await page.keyboard.press('Enter')
    await page.locator('[data-karte], .topbar').first().waitFor({ timeout: 30000 })
  }
  await page.goto('/karte')
  await page.locator('.topbar').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(2500)
  const declared = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
  const lum = await meanLuminance(await page.screenshot({ clip: await page.locator('.topbar').first().boundingBox() }))
  await browser.close()
  return { lum, declared }
}

// A light surface is far above this and a dark one far below it; the two differ by ~200 of 255,
// so the threshold needs no tuning — it only has to sit between them.
const LIGHT = 150

let red = 0
const say = (ok, line) => { if (!ok) red++; console.log(`${ok ? 'ok  ' : 'RED '}${line}`) }

const dayPlain = await topbarLuminance({ autoDark: false, theme: 'day' })
say(dayPlain.lum > LIGHT, `day, no force-dark: top bar luminance ${dayPlain.lum} (color-scheme: ${dayPlain.declared}) — must be light`)

const dayDark = await topbarLuminance({ autoDark: true, theme: 'day' })
say(dayDark.lum > LIGHT, `day, force-dark ON: top bar luminance ${dayDark.lum} (color-scheme: ${dayDark.declared}) — the owner's bug: must STAY light`)

const nightDark = await topbarLuminance({ autoDark: true, theme: 'night' })
say(nightDark.lum < LIGHT, `night, force-dark ON: top bar luminance ${nightDark.lum} (color-scheme: ${nightDark.declared}) — must stay dark`)

await plain.close()
console.log(red ? `\n${red} RED` : '\nall green')
process.exit(red ? 1 : 0)
