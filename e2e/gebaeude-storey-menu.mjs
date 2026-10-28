// The Gebäude storey label stays reachable with a create tool armed (owner, round 2 of the Gebäude
// drawing, 27.10.2026: «copying to other storeys doesn't work»). The cause was CSS, which jsdom
// cannot see: the create tools' capture layer (.wb-ink, z 5) lay over the storey label (z 1), so a
// MOUSE click on «EG ⌄» with the Wand armed – and the Wand stays armed – started a wall instead of
// opening «Kopieren nach …». A device-class check, not a Playwright spec: Chromium at 1440×900
// with a real mouse, dark mode, run by hand against a running stack:
//
//   LD_LIBRARY_PATH=… node e2e/gebaeude-storey-menu.mjs http://127.0.0.1:5188   (PIN 000000 stack)
//
// It opens a fresh Einsatz at a fixed spot, answers the Overpass building lookup with a
// rectangular building of its own (no network), takes it over and adds an OG. Then, under each
// create tool: the label is what a click there hits. Under the Wand it copies the EG's wall to the
// 1. OG through the menu, the sheet and «Kopieren» – all with the mouse.
//
// Exit code 1 and «RED» lines when a check fails.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
const AT = [7.570345, 47.523718] // lng, lat – where the Einsatz and its building stand
const dx = 0.00028, dy = 0.00012
const BUILDING = [[-dx, -dy], [dx, -dy], [dx, dy], [-dx, dy], [-dx, -dy]].map(([x, y]) => ({ lon: AT[0] + x, lat: AT[1] + y }))

const browser = await chromium.launch()
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, colorScheme: 'dark', serviceWorkers: 'block' })
await ctx.route('**/api/overpass/buildings', async (r) => {
  const b = r.request().postDataJSON()
  const inside = AT[1] > b.south && AT[1] < b.north && AT[0] > b.west && AT[0] < b.east
  await r.fulfill({ json: { elements: inside ? [{ type: 'way', id: 1, geometry: BUILDING }] : [] } })
})
await ctx.route(/basemaps\.cartocdn\.com\//, (r) => r.abort())
const page = await ctx.newPage()

await page.goto('/')
await page.locator('.roster-tile, [data-karte], nav.navrail').first().waitFor({ timeout: 30000 })
if (await page.locator('.roster-tile').first().isVisible().catch(() => false)) {
  await page.locator('.roster-tile').first().click()
  await page.locator('.pinpad').waitFor({ timeout: 10000 })
  for (const d of PIN) await page.keyboard.press(d)
  await page.keyboard.press('Enter')
  await page.locator('[data-karte], nav.navrail').first().waitFor({ timeout: 30000 })
}
// a fresh Einsatz at AT, remembered as the one picked by hand (lib/prefs) so the reload opens it
const made = await page.evaluate(async ([lng, lat]) => {
  const r = await fetch('/api/incidents', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ title: 'E2E Gebäude-Geschosse', lat, lng }),
  })
  if (r.status !== 201) return `answered ${r.status}`
  const { id } = await r.json()
  document.cookie = `kp-front-prefs=${encodeURIComponent(JSON.stringify({ incidentId: id, incidentChosenAt: Date.now() }))}; path=/`
  return null
}, AT)
if (made) throw new Error(`creating the Einsatz ${made}`)
await page.reload()
await page.locator('nav.navrail:not([data-karte] nav)').waitFor({ timeout: 30000 })
await page.getByRole('button', { name: 'Gebäude', exact: true }).click()
await page.getByRole('button', { name: /^Übernehmen/ }).click({ timeout: 20000 })
await page.getByRole('button', { name: 'OG', exact: true }).click()
await page.locator('.wb-floor-svg polygon').nth(1).waitFor({ timeout: 10000 })
await page.waitForTimeout(800)

let red = 0
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'RED ', what); if (!ok) red++ }
const egLabel = page.getByRole('button', { name: /^EG:/ })
/** what a click on the EG label's middle hits */
const labelHit = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('.wb-floor-menu')].find((e) => e.textContent?.includes('EG'))?.getBoundingClientRect()
  return b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.wb-floor-menu') != null : false
})
const arm = async (tool) => { await page.getByRole('button', { name: tool, exact: true }).click(); await page.waitForTimeout(250) }

for (const tool of ['Linie', 'Fläche', 'Absperrkreis', 'Notiz']) {
  await arm(tool)
  check(await labelHit(), `${tool} armed: a click on «EG ⌄» hits the label, not the drawing layer`)
  await arm('Auswahl')
}

// the owner's path: a wall on the EG with the Wand (which stays armed), then «Kopieren nach …»
const eg = await page.locator('.wb-floor-svg polygon').last().boundingBox()
await arm('Linie')
await page.getByRole('button', { name: 'Wand', exact: true }).click()
const y = eg.y + eg.height - 30
for (const x of [eg.x + 30, eg.x + eg.width - 30, eg.x + eg.width - 30]) { await page.mouse.click(x, y); await page.waitForTimeout(200) }
check(await labelHit(), 'Wand armed: a click on «EG ⌄» hits the label')
const box = await egLabel.boundingBox()
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
const item = page.getByRole('menuitem', { name: /Kopieren nach/ })
const shown = (loc) => loc.waitFor({ timeout: 3000 }).then(() => true, () => false)
const menuOpen = await shown(item)
check(menuOpen, 'the mouse click opens the storey menu')
if (menuOpen) {
  await item.click()
  const sheet = page.getByRole('dialog')
  // a storey row is a TickRow (role checkbox); the button names the result («Auf 1. OG kopieren»)
  await sheet.getByRole('checkbox', { name: /^1\. OG/ }).click()
  await sheet.getByRole('button', { name: /^Auf .+ kopieren$/ }).click()
  check(await shown(page.getByText(/Grundriss kopiert: 1 nach 1\. OG/)), '«Kopieren» copies the wall to the 1. OG')
}

await browser.close()
if (red) { console.log(`${red} RED`); process.exit(1) }
console.log('all green')
