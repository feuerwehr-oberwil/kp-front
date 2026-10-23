// The Checkliste surface's device pictures paint with the first frame of a SECOND open (owner,
// review round 2, 19.10.2026, iPhone: «checklists seem to always have to refetch the image
// labels» – every open of the surface showed the Geräte cards blank, then the photo). A
// device-class check, not a Playwright spec: WebKit at iPhone 13 size, run by hand against a
// running stack that has Anleitungen with pictures (the demo manifest:
// `uv run python -m app.admin_checklists load ../examples/demo-data/checklists.manifest.json`).
//
//   LD_LIBRARY_PATH=… node e2e/checkliste-pictures.mjs http://127.0.0.1:5120   (PIN 000000 stack)
//
// Opens the surface, waits for the pictures, goes to the Karte and back (`--runs`, default 5
// times), and each time reads, in the first animation frame that shows the cards again, whether
// every card picture is already there (`complete` with a size) – and how many picture requests
// the page sent past the service worker (WebKit hands every remount's request to the worker;
// answered from its cache is fine, and the worker's own network fetches are not seen here).
// Then the same for a device page's hero picture, when the stack has a device with chapters.
//
// The symptom lives ONLY with the service worker (`--sw`, the installed app): without one WebKit
// paints the remount from its memory cache and this is green before the fix too. Red before the
// fix (20.10.2026, a vite build of the base served by the stack's backend, SPA_DIR=…): the first
// frame lacked the card pictures in 3 of 5 opens and the device page's hero in 4 of 5 – each new
// <img> waited for the worker. Green after: 10 of 10 (lib/heldPictures – a `blob:` copy never
// goes to the worker). Needs a device with chapters for the hero (the demo has none: add one).
import { webkit, devices } from '@playwright/test'

const BASE = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:5188'
// `--sw`: with the service worker, as the installed app runs (needs a BUILT app – the backend
// serving dist/, not the Vite dev server, which has no worker)
const SW = process.argv.includes('--sw')
// how often to go away and come back (the pop is a race with the worker: one lucky open proves little)
const RUNS = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 5
const PIN = '000000'

const browser = await webkit.launch()
const ctx = await browser.newContext({ ...devices['iPhone 13'], baseURL: BASE, serviceWorkers: SW ? 'allow' : 'block' })
await ctx.addInitScript(() => {
  try { sessionStorage.setItem('kp.karte.view', JSON.stringify({ center: [7.555, 47.515], zoom: 15, bearing: 0, objectId: null, surface: 'karte' })) } catch { /* private mode */ }
  // per frame: the watched pictures (`__picSel`) in the DOM and how many of them are painted
  const frames = []
  window.__picFrames = frames
  window.__picSel = '[class*="dv-pic"] img'
  const tick = () => {
    const imgs = [...document.querySelectorAll(window.__picSel)]
    if (imgs.length) frames.push({ n: imgs.length, shown: imgs.filter((i) => i.complete && i.naturalWidth > 0).length })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
const page = await ctx.newPage()
/** picture responses since the last reset that did NOT come from the service worker */
const picRequests = []
page.on('response', (r) => {
  if (/\/api\/reference\/checklists(%3A|:)[^/?]+(%3A|:)p\d+/.test(r.url()) && !r.fromServiceWorker()) picRequests.push(r.url())
})

await page.goto('/')
await page.locator('.roster-tile, [data-karte]').first().waitFor({ timeout: 90_000 })
if (await page.locator('.roster-tile').first().isVisible()) {
  await page.locator('.roster-tile').first().click()
  await page.locator('.pinpad').waitFor()
  for (const d of PIN) await page.keyboard.press(d)
  await page.keyboard.press('Enter')
}
await page.locator('[data-karte]').first().waitFor({ timeout: 90_000 })
if (SW) {
  // the worker controls the page from the next load on (and fills its caches from then)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await page.locator('[data-karte]').first().waitFor({ timeout: 90_000 })
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) throw new Error('no service worker controls the page')
}

const checkliste = page.getByRole('button', { name: 'Checkliste', exact: true })
const karte = page.getByRole('button', { name: 'Karte', exact: true })
const cards = page.locator('[class*="dv-pic"] img')

// first open: wait until every card picture is painted
await checkliste.first().click()
await cards.first().waitFor({ timeout: 30_000 })
await page.waitForFunction(() => [...document.querySelectorAll('[class*="dv-pic"] img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30_000 })
await page.waitForTimeout(500)

/** go away and come back: the first frame that shows the `sel` pictures again, and the server requests */
async function reopen(sel, away, back) {
  await away()
  await page.waitForFunction((q) => !document.querySelector(q), sel, { timeout: 10_000 })
  await page.evaluate((q) => { window.__picSel = q; window.__picFrames.length = 0 }, sel)
  picRequests.length = 0
  await back()
  await page.waitForTimeout(1500)
  const frames = await page.evaluate(() => window.__picFrames.slice())
  return { first: frames[0] ?? null, requests: picRequests.length }
}

const results = []
for (let i = 1; i <= RUNS; i++) {
  results.push({ what: `device cards, open ${i + 1}`, ...await reopen('[class*="dv-pic"] img', () => karte.first().click(), () => checkliste.first().click()) })
}

// a device page's hero: open the first device that has a page (or its Anleitung), back, again
await cards.first().click()
const hero = page.locator('img[class*="dv-hero"]')
if (await hero.count()) {
  await page.waitForFunction(() => { const i = document.querySelector('img[class*="dv-hero"]'); return i && i.complete && i.naturalWidth > 0 }, null, { timeout: 15_000 })
  const back = page.locator('button.back-row')
  for (let i = 1; i <= RUNS; i++) {
    results.push({ what: `device page hero, open ${i + 1}`, ...await reopen('img[class*="dv-hero"]', () => back.click(), () => cards.first().click()) })
  }
}

await browser.close()
let red = false
for (const r of results) {
  const ok = !!r.first && r.first.shown === r.first.n && r.requests === 0
  red ||= !ok
  console.log(`${ok ? 'GREEN' : 'RED  '} ${r.what}${SW ? ' (service worker)' : ''}: first frame ${r.first ? `${r.first.shown}/${r.first.n} painted` : 'none'}, ${r.requests} picture request(s) to the server`)
}
process.exit(red ? 1 : 0)
