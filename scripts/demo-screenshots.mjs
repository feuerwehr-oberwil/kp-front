// Drive the live demo and capture the README screenshots of the pre-filled incident's key
// surfaces. The demo seeds one running incident (see backend/app/demo_reset.py) that this
// opens (or that auto-opens), then shoots Lage, Atemschutz, Gebäude, and Mittel.
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

  // The pre-filled incident either auto-opens (nav rail appears) or waits on the landing as a
  // card to click. Handle both so the shot doesn't depend on the auto-open setting.
  const navrail = page.locator('nav.navrail')
  const landingCard = page.getByText('Zimmerbrand').first()
  await Promise.race([
    navrail.waitFor({ timeout: 20000 }),
    landingCard.waitFor({ timeout: 20000 }),
  ])
  if (!(await navrail.count())) {
    await landingCard.click()
    await navrail.waitFor({ timeout: 15000 })
  }

  // Lage (map): settle tiles + symbols, then deselect by clicking a neutral map point (default
  // tool is select → just deselects, places nothing).
  const canvas = page.locator('canvas.maplibregl-canvas').first()
  await canvas.waitFor()
  await canvas.click({ position: { x: 1050, y: 640 } })
  await page.waitForTimeout(3000)
  await noCrash(page, 'Lage')
  await shot(page, 'lage')

  const surface = async (label, file, wait = 1800) => {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.waitForTimeout(wait)
    await noCrash(page, label)
    await shot(page, file)
  }
  await surface('Atemschutz', 'atemschutz')
  await surface('Mittel', 'mittel')
  await surface('Gebäude', 'gebaeude', 3000) // the floor stack (present once a building outline exists)

  await browser.close()
  console.log('done')
}
run().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
