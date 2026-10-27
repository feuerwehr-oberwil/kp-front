// The Wand's grips on the Gebäude stack, with a mouse (owner, round 3 of the Gebäude drawing,
// 27.10.2026). Two things jsdom cannot see, so a device-class check – Chromium at 1440×900, dark
// mode, a real mouse – run by hand against a running stack:
//
//   LD_LIBRARY_PATH=… node e2e/gebaeude-wand-grips.mjs http://127.0.0.1:5188   (PIN 000000 stack)
//
// 1. «Verlängern» keeps its distance from the end node in EVERY direction. The cause was CSS:
//    .draw-grow's `position: relative` beat .wb-grow's `absolute`, the grips flowed, and the end's
//    arrow sat 32 px lower than its translate – on a Wand ending upwards, right on its node.
// 2. A node of the OPEN Wand (it stays open while it is drawn) snaps when dragged onto the
//    building outline, ring shown – the Vitest twin is Whiteboard.test · «a node of the OPEN Wand».
//
// It opens a fresh Einsatz at a fixed spot and answers the Overpass lookup with a rectangular
// building of its own (no network). Exit code 1 and «RED» lines when a check fails.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
const AT = [7.570345, 47.523718] // lng, lat – where the Einsatz and its building stand
const dx = 0.00028, dy = 0.00012
const BUILDING = [[-dx, -dy], [dx, -dy], [dx, dy], [-dx, dy], [-dx, -dy]].map(([x, y]) => ({ lon: AT[0] + x, lat: AT[1] + y }))
const STEP = 46 // lib/lineStyle · EXTEND_STEP_PX

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
    body: JSON.stringify({ title: 'E2E Gebäude-Wand', lat, lng }),
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
await page.locator('.wb-floor-svg polygon').first().waitFor({ timeout: 10000 })
await page.waitForTimeout(800)

let red = 0
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'RED ', what); if (!ok) red++ }
const arm = async (tool) => { await page.getByRole('button', { name: tool, exact: true }).click(); await page.waitForTimeout(250) }
const centres = (sel) => page.locator(sel).evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] }))
const ringShown = () => page.evaluate(() => !!document.querySelector('.wb-snap-ring'))
const eg = await page.locator('.wb-floor-svg polygon').last().boundingBox()
const mid = [eg.x + eg.width / 2, eg.y + eg.height / 2]

// 1 · a Wand from the middle out, ending up / down / left / right: its end's arrow stays a full
// step off the node, and a press on the node is the node's
for (const [name, ddx, ddy] of [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]]) {
  const end = [mid[0] + ddx * 60, mid[1] + ddy * 50]
  await arm('Linie')
  await page.getByRole('button', { name: 'Wand', exact: true }).click()
  for (const p of [mid, end, end]) { await page.mouse.click(...p); await page.waitForTimeout(200) }
  await arm('Auswahl')
  await page.mouse.click(mid[0] + ddx * 45, mid[1] + ddy * 38)
  await page.waitForTimeout(300)
  const node = (await centres('.wb-vertex')).at(-1)
  const grip = node && (await centres('.wb-grow')).reduce((a, g) => (Math.hypot(g[0] - node[0], g[1] - node[1]) < Math.hypot(a[0] - node[0], a[1] - node[1]) ? g : a))
  const gap = node && grip ? Math.hypot(grip[0] - node[0], grip[1] - node[1]) : 0
  const hits = node ? await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.wb-vertex'), node) : false
  check(Math.abs(gap - STEP) < 1 && hits, `Wand ending ${name}: «Verlängern» ${gap.toFixed(1)} px from its end node, a press there takes the node`)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Rückgängig/ }).first().click()
  await page.waitForTimeout(300)
}

// 2 · the open Wand's last node dragged to 7 px short of the right outline edge, a little askew:
// pink ring while it moves, and it lands on the edge, level with its first point
const y = eg.y + eg.height * 0.75
await arm('Linie')
await page.getByRole('button', { name: 'Wand', exact: true }).click()
for (const x of [eg.x + 40, eg.x + 160]) { await page.mouse.click(x, y); await page.waitForTimeout(250) }
const [first, last] = await centres('.wb-vertex')
const to = [eg.x + eg.width - 7, y + 5]
await page.mouse.move(...last); await page.mouse.down()
for (let i = 1; i <= 10; i++) { await page.mouse.move(last[0] + (to[0] - last[0]) * i / 10, last[1] + (to[1] - last[1]) * i / 10); await page.waitForTimeout(30) }
const ring = await ringShown()
await page.mouse.up(); await page.waitForTimeout(300)
const dropped = (await centres('.wb-vertex')).at(-1)
check(ring && Math.abs(dropped[0] - (eg.x + eg.width)) < 1.5 && Math.abs(dropped[1] - first[1]) < 1.5,
  `the open Wand's node dragged to the outline: ring ${ring ? 'shown' : 'missing'}, lands at ${dropped.map(Math.round)} (edge x ${Math.round(eg.x + eg.width)}, level y ${Math.round(first[1])})`)

await browser.close()
if (red) { console.log(`${red} RED`); process.exit(1) }
console.log('all green')
