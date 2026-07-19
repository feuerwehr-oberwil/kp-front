// Drive the live demo and capture screenshots of the populated incident's key surfaces.
// Usage: node scripts/demo-screenshots.mjs <baseUrl> <outDir>
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] || 'https://kp-front-demo.up.railway.app'
const OUT = process.argv[3] || 'docs/screenshots'
mkdirSync(OUT, { recursive: true })

const CRASH = 'Ein Fehler ist aufgetreten'

const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`  ✓ ${name}.png`)
}
const noCrash = async (page, where) => {
  if (await page.getByText(CRASH).count()) throw new Error(`ErrorBoundary crash on ${where}`)
}

const run = async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => console.log('  ! pageerror:', e.message))

  // Login: pick the editor tile, tap PIN 000000.
  await page.goto(BASE)
  await page.locator('.roster-tile').filter({ hasText: 'Führungsunterstützung' }).click()
  await page.locator('.pinpad').waitFor()
  for (const d of '000000') await page.keyboard.press(d)

  // Landing: the pending alarm + the running incident. Screenshot it, then open the incident.
  await page.getByText('Gebäudebrand Mehrfamilienhaus').first().waitFor({ timeout: 15000 })
  await shot(page, '01-landing')
  await page.getByText('Gebäudebrand Mehrfamilienhaus').first().click()

  // Lage (map) with the populated command picture. Close the incident menu drawer first by
  // clicking a neutral map point (default tool is select → just deselects, places nothing).
  await page.locator('nav.navrail').waitFor({ timeout: 15000 })
  const canvas = page.locator('canvas.maplibregl-canvas').first()
  await canvas.waitFor()
  await canvas.click({ position: { x: 1050, y: 640 } })
  await page.waitForTimeout(2800) // let tiles + symbols settle
  await noCrash(page, 'Lage')
  await shot(page, '02-lage')

  const surface = async (name, file) => {
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForTimeout(1400)
    await noCrash(page, name)
    await shot(page, file)
  }
  await surface('Atemschutz', '03-atemschutz')
  await surface('Anwesenheit', '04-anwesenheit')
  await surface('Mittel', '05-mittel')
  await surface('Gebäude', '06-gebaeude').catch(()=>{}); await surface('Tafel', '08-tafel').catch(()=>{})
  await surface('Karte', '07-lage-clean')

  await browser.close()
  console.log('done')
}
run().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
