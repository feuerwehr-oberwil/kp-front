// A folded map name tag is as wide as its longest line (owner, Karte Haus round 3: «wrapped lines
// for objects should have their boxes fitted to the width rather than how they wouldve been»). CSS
// alone keeps a wrapped box at its max-width (280 px) – KarteApp measures the lines on the tag's
// off-screen twin and hands the folded tag its fitted width. A device-class check, not a
// Playwright spec: Chromium at iPhone size (WebKit on this box draws the map only for seconds),
// over the Stallenmatt row of the golden data, run by hand against a running stack:
//
//   LD_LIBRARY_PATH=… node e2e/karte-tag-fit.mjs http://127.0.0.1:5130   (PIN 000000 stack)
//
// For every name tag on screen: its box may be at most 2 px wider than its widest rendered line
// plus its padding and border. Exit code 1 and «RED» lines when a tag is wider.
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

await page.goto('/')
await page.locator('.roster-tile, [data-karte], .topbar').first().waitFor({ timeout: 30000 })
if (await page.locator('.roster-tile').first().isVisible().catch(() => false)) {
  await page.locator('.roster-tile').first().click()
  await page.locator('.pinpad').waitFor({ timeout: 10000 })
  for (const d of PIN) await page.keyboard.press(d)
  await page.keyboard.press('Enter')
  await page.locator('[data-karte], .topbar').first().waitFor({ timeout: 30000 })
}
// the Stallenmatt row: «Stallenmattstrasse 1-14, Kaibmattweg 1-5, …» folds onto two or three lines
await page.evaluate(() => sessionStorage.setItem('kp.karte.view', JSON.stringify({ center: [7.5496535, 47.5136528], zoom: 17.6, bearing: 0, objectId: null, surface: 'karte' })))
await page.goto('/karte')
await page.locator('.maplibregl-canvas').waitFor({ timeout: 30000 })
await page.waitForTimeout(2500)

const tags = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.maplibregl-marker button')).flatMap((el) => {
    const text = el.firstChild
    if (!(el instanceof HTMLElement) || !text || !el.textContent?.trim()) return []
    const range = document.createRange()
    range.selectNodeContents(el)
    const rows = new Map()
    for (const r of Array.from(range.getClientRects())) rows.set(Math.round(r.top), Math.max(rows.get(Math.round(r.top)) ?? 0, r.width))
    const cs = getComputedStyle(el)
    const chrome = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((n, k) => n + parseFloat(cs[k]), 0)
    return [{ name: el.textContent, box: el.getBoundingClientRect().width, line: Math.max(...rows.values()) + chrome, lines: rows.size }]
  })
})

let red = 0
const folded = tags.filter((t) => t.lines > 1)
if (!folded.length) { console.log('RED: no folded tag on screen – the view no longer shows the Stallenmatt row'); red++ }
for (const t of tags) {
  const ok = t.box <= t.line + 2
  if (!ok) red++
  if (!ok || t.lines > 1) console.log(`${ok ? 'ok ' : 'RED'} ${t.lines} line(s), box ${t.box.toFixed(1)} px vs widest line ${t.line.toFixed(1)} px – ${t.name.slice(0, 60)}`)
}
console.log(`${tags.length} tags, ${folded.length} folded, ${red} red`)
await browser.close()
process.exit(red ? 1 : 0)
