#!/usr/bin/env node
/**
 * Screenshots für die Landingpage aufnehmen.
 *
 *   node site/capture.mjs                       # gegen die öffentliche Demo
 *   node site/capture.mjs --base http://localhost:5188
 *   node site/capture.mjs --only lage,mittel    # nur einzelne Shots
 *
 * Fährt eine echte Instanz mit Playwright an, schaltet auf Tagmodus, blendet die
 * Demo-Chrome (Willkommensdialog, DEMO-Banderole) aus und legt die Bilder in
 * site/shots/ ab. Die Bildnamen sind der Vertrag mit site/index.html – wer hier
 * umbenennt, muss dort mitziehen.
 */
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')

const DEFAULT_BASE = 'https://demo.kp-front.ch'
const VIEWPORT = { width: 1500, height: 937 } // 1.6:1 – dieselbe Kachelform für alle Shots
const QUALITY = 82

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const base = (arg('base') || DEFAULT_BASE).replace(/\/$/, '')
const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean)

/** Ein Shot = eine Ansicht aus der linken Navigationsleiste, plus Einschwingzeit.
 *  `prep` öffnet vorher noch etwas (Sheet, Menü); `nav` darf dann fehlen. */
const shots = [
  { name: 'lage', nav: 'Karte', settle: 3500, note: 'Hero: taktische Karte' },
  { name: 'plan', nav: 'Modul 1', settle: 4000, note: 'Objektplan als Whiteboard' },
  { name: 'gebaeude', nav: 'Gebäude', settle: 1500 },
  { name: 'atemschutz', nav: 'Atemschutz', settle: 1200 },
  { name: 'anwesenheit', nav: 'Anwesenheit', settle: 1500 },
  { name: 'mittel', nav: 'Mittel', settle: 1200 },
  { name: 'checkliste', nav: 'Checkliste', settle: 1500 },
  {
    name: 'verlauf',
    nav: 'Karte',
    settle: 2500,
    prep: async (page) => {
      await page.locator('.tb-act').filter({ hasText: 'Verlauf' }).first().click()
      await page.waitForTimeout(1500)
    },
  },
]

/** Demo-Chrome, die im Marketing-Bild nichts zu suchen hat. */
const HIDE_CSS = `
  .demo-ribbon, .demo-welcome-scrim, .kp-toast, [data-sonner-toaster] { display: none !important; }
`

const run = async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })

  // Tagmodus erzwingen (die App schaltet sonst nach Sonnenuntergang auf Nacht) und
  // den Willkommensdialog der Demo als "gesehen" markieren, bevor React startet.
  const { host, protocol } = new URL(base)
  await ctx.addCookies([{
    name: 'kp-front-prefs',
    value: encodeURIComponent(JSON.stringify({ theme: 'day', mode: 'map' })),
    domain: host.split(':')[0],
    path: '/',
    secure: protocol === 'https:',
    sameSite: 'Lax',
    expires: Math.floor(Date.now() / 1000) + 3600,
  }])
  await ctx.addInitScript(() => {
    try { localStorage.setItem('kp.demo.welcomed', '1') } catch { /* private mode */ }
  })

  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.warn('  ! page error:', String(e).slice(0, 120)))

  console.log(`→ ${base}`)
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.locator('.nav-item').first().waitFor({ timeout: 45000 })
  await page.addStyleTag({ content: HIDE_CSS })
  await page.waitForLoadState('networkidle').catch(() => {})

  const wanted = shots.filter((s) => !only || only.includes(s.name))
  if (!wanted.length) throw new Error(`--only passt auf keinen Shot (${shots.map((s) => s.name).join(', ')})`)

  for (const shot of wanted) {
    const item = page.locator('.nav-item').filter({ hasText: shot.nav }).first()
    await item.click()
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(shot.settle)
    if (shot.prep) await shot.prep(page)
    const path = join(SHOTS, `${shot.name}.jpg`)
    await page.screenshot({ path, type: 'jpeg', quality: QUALITY })
    console.log(`  ✓ ${shot.name}.jpg  (${shot.nav})`)
  }

  await browser.close()
  console.log('Fertig. Danach: node site/build.mjs')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
