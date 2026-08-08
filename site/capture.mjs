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
// Die README-Bilder entstehen aus denselben Seitenzuständen wie die Landingpage-Shots.
// Vorher wurden sie separat von Hand geschossen und liefen dadurch auseinander — ein Shot
// mit `docs:` schreibt jetzt beides in einem Durchgang.
const DOCS_SHOTS = join(HERE, '..', 'docs', 'screenshots')

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
// Nur die README-Bilder neu schreiben und die Landingpage-JPEGs in Ruhe lassen. Nötig,
// weil beide Ausgaben aus derselben Aufnahme stammen, aber nicht dieselbe Auflösung
// wollen: die Landingpage bindet inline ein (1x), die README-Bilder werden auf GitHub
// vergrössert (2x). Also: erst der normale Lauf, dann `--scale 2 --docs-only`.
const docsOnly = argv.includes('--docs-only')
// Aufnahme-Auflösung: 1 für die Landingpage, 2 für die README-Bilder (siehe oben).
const scale = Number(arg('scale') || 1)
// Die öffentliche Demo lässt ohne Anmeldung herein. Eine lokale Instanz nicht – dort braucht es
// eine Rolle und einen PIN, sonst steht der Browser vor dem Anmeldeschirm und läuft in den Timeout.
const pin = arg('pin')

/** Ein Shot = eine Ansicht aus der linken Navigationsleiste, plus Einschwingzeit.
 *  `prep` öffnet vorher noch etwas (Sheet, Menü); `nav` darf dann fehlen. */
const shots = [
  { name: 'lage', nav: 'Karte', settle: 3500, note: 'Hero: taktische Karte', docs: 'lage' },
  { name: 'plan', nav: 'Modul 1', settle: 4000, note: 'Objektplan als Whiteboard' },
  { name: 'gebaeude', nav: 'Gebäude', settle: 1500, docs: 'gebaeude' },
  { name: 'atemschutz', nav: 'Atemschutz', settle: 1200, docs: 'atemschutz' },
  { name: 'anwesenheit', nav: 'Anwesenheit', settle: 1500 },
  {
    name: 'zeitplan',
    nav: 'Anwesenheit',
    settle: 1500,
    note: 'Zweite Ansicht derselben Mannschaft: Schichten über der Zeit',
    prep: async (page) => {
      await page.getByRole('button', { name: 'Zeitplan', exact: true }).click()
      await page.waitForTimeout(1500)
      // Der Standard-Zeitraum ist auf ein Bild hin zu weit: die Balken der Demo liegen in den
      // ersten Stunden, der Rest der Achse wäre leere Fläche. Enger stellen, bis die Mannschaft
      // die Breite auch füllt – und ans Ende scrollen, damit die Deckungszeile unter der letzten
      // Zeile sitzt statt halb über ihr.
      const narrower = page.getByRole('button', { name: 'Zeitraum enger' }).first()
      for (let i = 0; i < 2 && await narrower.count(); i++) {
        await narrower.click()
        await page.waitForTimeout(400)
      }
      await page.evaluate(() => {
        const box = [...document.querySelectorAll('[class]')]
          .find((el) => [...el.classList].some((c) => c.includes('_scroll_')))
        if (box) box.scrollTop = box.scrollHeight
      })
      await page.waitForTimeout(600)
    },
  },
  { name: 'mittel', nav: 'Mittel', settle: 1200, docs: 'mittel' },
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
  // ⚠️ Der Rapport war einmal ein Dialog, den man über das Einsatz-Menü aufmachte
  // (`.ip-switch-btn` → «Einsatzrapport»), und dieser Schritt scrollte in
  // `.report-preflight-body` bis zur Anwesenheits-Karte. Beides gibt es nicht mehr: der
  // Rapport ist eine eigene Fläche in der linken Leiste (Taste R). Der alte Schritt lief
  // 30 s in einen Timeout und nahm das Bild gar nicht mehr auf – ein Aufruf, der still
  // nichts mehr trifft, ist hier derselbe Fehler wie ein Test, der nichts mehr prüft.
  { name: 'rapport', nav: 'Rapport', settle: 2500, note: 'Der Einsatzrapport: ein vorausgefülltes Erfassungsblatt, über den ganzen Einsatz ergänzt' },
]

/** Demo-Chrome, die im Marketing-Bild nichts zu suchen hat. */
const HIDE_CSS = `
  .demo-ribbon, .demo-welcome-scrim, .kp-toast, [data-sonner-toaster] { display: none !important; }
  /* Der schwebende Neualarm-Streifen (.dv-banner) legte sich quer über den Kopf der Mittel-
     und Rapport-Bilder — auf der öffentlichen Demo läuft ständig ein frischer Alarm ein.
     Er ist echtes Produktverhalten, aber vorübergehendes Chrome: im Standbild liest er sich
     wie ein Fehlerzustand, der die Überschrift verdeckt. Gleiche Familie wie die Toasts. */
  .dv-banner { display: none !important; }
`

const run = async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: scale,
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
  if (pin) {
    const role = page.getByRole('button', { name: /Führungsunterstützung/ }).first()
    await role.waitFor({ timeout: 30000 })
    await role.click()
    for (const digit of pin) {
      await page.keyboard.press(digit)
      await page.waitForTimeout(80)
    }
    await page.waitForTimeout(2500)
    // Erstbesuch-Dialoge, die es auf der Demo dank kp.demo.welcomed nicht gibt.
    for (const label of [/Los geht/i, /Verstanden/i]) {
      const btn = page.getByRole('button', { name: label })
      if (await btn.count()) await btn.first().click().catch(() => {})
    }
  }
  await page.locator('.nav-item').first().waitFor({ timeout: 45000 })
  await page.addStyleTag({ content: HIDE_CSS })
  await page.waitForLoadState('networkidle').catch(() => {})

  const wanted = shots.filter((s) => !only || only.includes(s.name))
  if (!wanted.length) throw new Error(`--only passt auf keinen Shot (${shots.map((s) => s.name).join(', ')})`)

  for (const shot of wanted) {
    // Ein Shot darf ein Sheet offen lassen (der Verlauf tut das). Dessen Scrim liegt danach
    // über der Navigation und fängt jeden Klick ab — der nächste Shot lief in den Timeout,
    // statt aufzunehmen. Escape schliesst dieses Sheet nicht, also wird neu geladen, und zwar
    // nur dann, wenn wirklich ein Scrim im Weg ist: auf dem normalen Weg kostet das nichts.
    if (await page.locator('.journal-scrim, [data-base-ui-portal] [role="presentation"]').count()) {
      await page.goto(base, { waitUntil: 'domcontentloaded' })
      await page.locator('.nav-item').first().waitFor({ timeout: 45000 })
      await page.addStyleTag({ content: HIDE_CSS })
      await page.waitForLoadState('networkidle').catch(() => {})
    }
    const item = page.locator('.nav-item').filter({ hasText: shot.nav }).first()
    await item.click()
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(shot.settle)
    if (shot.prep) await shot.prep(page)
    if (!docsOnly) {
      const path = join(SHOTS, `${shot.name}.jpg`)
      await page.screenshot({ path, type: 'jpeg', quality: QUALITY })
      console.log(`  ✓ ${shot.name}.jpg  (${shot.nav})`)
    }
    // Derselbe Seitenzustand, zweite Ausgabe: das README-Bild. PNG, weil README-Bilder auf
    // GitHub oft vergrössert betrachtet werden und Text dort verlustfrei bleiben soll.
    if (shot.docs) {
      const docsPath = join(DOCS_SHOTS, `${shot.docs}.png`)
      await page.screenshot({ path: docsPath, type: 'png' })
      console.log(`  ✓ docs/screenshots/${shot.docs}.png`)
    }
  }

  await browser.close()
  console.log('Fertig. Danach: node site/build.mjs')
  console.log('README-Bilder (docs/screenshots/) wurden mitgeschrieben, wo ein Shot `docs:` trägt.')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
