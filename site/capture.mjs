#!/usr/bin/env node
/**
 * Capture the screenshots for the landing page.
 *
 *   node site/capture.mjs                       # against the public demo
 *   node site/capture.mjs --base http://localhost:5188
 *   node site/capture.mjs --only lage,mittel    # only individual shots
 *
 * Drives a real instance with Playwright, switches to day mode, hides the demo
 * chrome (welcome dialog, DEMO ribbon) and writes the images into site/shots/.
 * The image names are the contract with `shots.items` in site/content/de.json –
 * whoever renames one here has to follow suit there (only there: the translations
 * inherit the file name and merely caption it).
 */
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
// The README images come out of the same page states as the landing-page shots. They used
// to be shot separately by hand and drifted apart because of it — a shot with `docs:` now
// writes both in one pass.
const DOCS_SHOTS = join(HERE, '..', 'docs', 'screenshots')

const DEFAULT_BASE = 'https://demo.kp-front.ch'
const VIEWPORT = { width: 1500, height: 937 } // 1.6:1 – the same tile shape for every shot
const QUALITY = 82

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const base = (arg('base') || DEFAULT_BASE).replace(/\/$/, '')
const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean)
// Rewrite only the README images and leave the landing-page JPEGs alone. Needed because
// both outputs come from the same capture but don't want the same resolution: the landing
// page inlines them (1x), the README images are viewed enlarged on GitHub (2x). So: the
// normal run first, then `--scale 2 --docs-only`.
const docsOnly = argv.includes('--docs-only')
// Capture resolution: 1 for the landing page, 2 for the README images (see above).
const scale = Number(arg('scale') || 1)
// The public demo lets you in without signing in. A local instance does not – there it takes a
// role and a PIN, otherwise the browser sits at the login screen and runs into the timeout.
const pin = arg('pin')

/** One shot = one view from the left nav rail, plus settle time.
 *  `prep` opens something else first (sheet, menu); `nav` may then be missing. */
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
      // The default Zeitraum is too wide for a picture: the demo's bars sit in the first few
      // hours, the rest of the axis would be empty space. Narrow it until the crew actually
      // fills the width – and scroll to the end so the coverage row sits below the last row
      // instead of half over it.
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
  // ⚠️ The Rapport used to be a dialog you opened from the Einsatz menu
  // (`.ip-switch-btn` → «Einsatzrapport»), and this step scrolled inside
  // `.report-preflight-body` down to the Anwesenheit card. Neither exists any more: the
  // Rapport is its own surface in the left rail (key R). The old step ran 30 s into a
  // timeout and stopped capturing the image altogether – a call that silently matches
  // nothing is the same mistake here as a test that no longer checks anything.
  { name: 'rapport', nav: 'Rapport', settle: 2500, note: 'Der Einsatzrapport: ein vorausgefülltes Erfassungsblatt, über den ganzen Einsatz ergänzt' },
]

/** Demo chrome that has no business being in a marketing picture. */
const HIDE_CSS = `
  .demo-ribbon, .demo-welcome-scrim, .kp-toast, [data-sonner-toaster] { display: none !important; }
  /* The floating new-alarm strip (.dv-banner) lay right across the head of the Mittel and
     Rapport pictures — on the public demo a fresh Alarm keeps coming in. It is real product
     behaviour, but transient chrome: in a still it reads like an error state covering the
     heading. Same family as the toasts. */
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

  // Force day mode (otherwise the app switches to night after sunset) and mark the demo's
  // welcome dialog as "seen" before React starts.
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
    // First-visit dialogs that don't exist on the demo thanks to kp.demo.welcomed.
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
    // A shot may leave a sheet open (the Verlauf does). Its scrim then lies over the
    // navigation and swallows every click — the next shot ran into the timeout instead of
    // capturing. Escape does not close that sheet, so we reload, and only when a scrim really
    // is in the way: on the normal path this costs nothing.
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
    // Same page state, second output: the README image. PNG, because README images are often
    // viewed enlarged on GitHub and text should stay lossless there.
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
