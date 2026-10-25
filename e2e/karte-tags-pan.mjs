// The Karte's name tags arrive WHILE the map pans (owner, 25.10.2026, desktop: «Pre-render UI
// elements so that when panning the map they don't just show up once we release the cursor, but
// they arrive immediately after coming into view»). A device-class check, not a Playwright spec:
// Chromium at tablet size, a mouse drag held down mid-pan, run by hand against a dev stack:
//
//   LD_LIBRARY_PATH=… node e2e/karte-tags-pan.mjs http://127.0.0.1:5188   (PIN 000000 stack)
//
// It counts the tags inside the map's box with the button still held, and again after release –
// a tag that only shows after release is the symptom. Exit code 1 and «✗» lines when it fails.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
let failed = 0
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failed++ }

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, baseURL: BASE, serviceWorkers: 'block' })
// Oberwil's centre at a zoom where tags show; the pan then brings the east of the village in
await ctx.addInitScript(() => { if (!sessionStorage.getItem('kp.karte.view')) sessionStorage.setItem('kp.karte.view', JSON.stringify({ center: [7.553, 47.513], zoom: 16.6, bearing: 0, objectId: null, surface: 'karte' })) })
const page = await ctx.newPage()
await page.goto('/')
await page.locator('.roster-tile, [data-karte]').first().waitFor({ timeout: 30000 })
if (await page.locator('.roster-tile').first().isVisible().catch(() => false)) {
  await page.locator('.roster-tile').first().click()
  await page.locator('.pinpad').waitFor()
  for (const d of PIN) await page.keyboard.press(d)
  await page.keyboard.press('Enter')
  await page.locator('[data-karte], .topbar').first().waitFor({ timeout: 30000 })
}
await page.goto('/karte')
await page.locator('[data-karte]').first().waitFor({ timeout: 30000 })
await page.waitForTimeout(2500)

/** names of the tags whose box lies inside the map's visible box */
const tagsInView = () => page.evaluate(() => {
  const map = document.querySelector('.maplibregl-map').getBoundingClientRect()
  return [...document.querySelectorAll('.maplibregl-marker button')]
    .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= map.left && r.right <= map.right && r.top >= map.top && r.bottom <= map.bottom })
    .map((b) => b.textContent.trim()).sort()
})
const before = await tagsInView()
const box = await page.locator('.maplibregl-canvas').boundingBox()
const x = box.x + box.width * 0.75, y = box.y + box.height * 0.55
await page.mouse.move(x, y)
await page.mouse.down()
for (let i = 1; i <= 25; i++) { await page.mouse.move(x - i * 22, y - i * 4); await page.waitForTimeout(16) }
await page.waitForTimeout(700) // held: the finger rests mid-pan
const held = await tagsInView()
await page.mouse.up()
await page.waitForTimeout(1200)
const after = await tagsInView()
const late = after.filter((n) => !held.includes(n))
console.log(`tags in view: before ${before.length}, held mid-pan ${held.length}, after release ${after.length}`)
check(late.length === 0, `no tag waits for the release (late: ${late.join(' · ') || '–'})`)
await browser.close()
process.exit(failed ? 1 : 0)
