#!/usr/bin/env node
/**
 * Capture the screenshots for the landing page and the README.
 *
 *   node site/capture.mjs                       # against the public demo
 *   node site/capture.mjs --base http://localhost:5188
 *   node site/capture.mjs --only feuer,trupps   # only individual shots (either pass)
 *
 * Drives a real instance with Playwright and hides the demo chrome (welcome dialog, DEMO
 * ribbon, alarm strips). Two passes:
 *
 *   devices  – what the landing page shows: the app on an iPad and on an iPhone, full UI, in
 *              both themes → shots/<device>/<name>.webp and shots/dark/<device>/<name>.webp
 *   desktop  – day theme only: the link-preview JPEG (shots/lage.jpg) and the README PNGs
 *              (docs/screenshots/)
 *
 * --theme light|dark limits the device pass to one theme; --site-only skips the README PNGs;
 * --docs-only writes only the README PNGs. The device image names are the contract with
 * `hero.img` and `chapters[].img` in site/content/de.json – rename one here, rename it there.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
// The README images come out of the same page states as the link preview – a shot with `docs:`
// writes both in one pass, so they cannot drift apart.
const DOCS_SHOTS = join(HERE, '..', 'docs', 'screenshots')

const DEFAULT_BASE = 'https://demo.kp-front.ch'
// The encoding happens inside the Chromium Playwright ships anyway – no second dependency.
const WEBP_QUALITY = 0.8
// The one JPEG: link previews (og:image). WhatsApp, Facebook and friends show no WebP.
const OG_QUALITY = 0.82

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const base = (arg('base') || DEFAULT_BASE).replace(/\/$/, '')
const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean)
// The README PNGs are viewed enlarged on GitHub and want 2x: the normal run first, then
// `--scale 2 --docs-only`.
const docsOnly = argv.includes('--docs-only')
const siteOnly = argv.includes('--site-only')
const requestedTheme = arg('theme')
if (requestedTheme && !['light', 'dark'].includes(requestedTheme)) throw new Error('--theme must be light or dark')
const themes = requestedTheme ? [requestedTheme] : ['light', 'dark']
if (docsOnly && (siteOnly || requestedTheme === 'dark')) throw new Error('--docs-only requires light theme and cannot be combined with --site-only')
// Desktop capture resolution: 1 for the link preview, 2 for the README images (see above).
const scale = Number(arg('scale') || 1)
// The public demo lets you in without signing in. A local instance does not – there it takes a
// role and a PIN, otherwise the browser sits at the login screen and runs into the timeout.
const pin = arg('pin')
const wanted = (name) => !only || only.includes(name)

/** Demo chrome that has no business being in a marketing picture. */
const HIDE_CSS = `
  .demo-ribbon, .demo-welcome-scrim, .kp-toast, [data-sonner-toaster] { display: none !important; }
  /* The floating new-alarm strip (.dv-banner): on the public demo a fresh Alarm keeps coming
     in. Real product behaviour, but transient chrome – in a still it reads like an error. */
  .dv-banner { display: none !important; }
  /* The Meldeleiste (.ml) for the same reason (06.10.2026): the demo's seeded AS-Trupps run
     overdue within minutes of a reset, so «Atemschutz überfällig» lay across the head of every
     picture. The Trupps board still shows the overdue Trupps; only the floating row goes. */
  .ml { display: none !important; }
`

// ─── Device pass ──────────────────────────────────────────────────────────────
//
// Each device is shot at its real screen size, with its safe-area insets emulated: the app runs
// with `viewport-fit=cover`, so on a device the map sits under the status bar and the bars keep
// clear of the home indicator – and so it does here. The picture then keeps only part of that
// gap (`keep`, in points): on the page there is no status bar, and the full gap would read as
// dead padding. The crop happens in the file, never in CSS – negative margins inside a rounded,
// clipped frame left an empty band under the picture in Safari (19.11.2026).
//
// ⚠️ Playwright's `devices['iPhone 14']` is the SAFARI viewport (390×664), not the screen. An
// installed app has the whole 390×844 – the preset's pictures came out a third too short.
const DEVICES = {
  tablet: { viewport: { width: 1180, height: 820 }, scale: 2, insets: { top: 24, bottom: 20 }, keep: { top: 8, bottom: 20 }, width: 1600, mobile: false },
  phone: { viewport: { width: 390, height: 844 }, scale: 3, insets: { top: 47, bottom: 34 }, keep: { top: 19, bottom: 14 }, width: 780, mobile: true },
}

// The Feuer symbol, selected with its detail panel open. The seeded Trupp pill «Müller H.» lies
// right on top of the fire, so a real tap at that spot selects the Trupp: the tap goes straight
// to the Feuer marker instead (a touch-type pointerdown/up – the marker selects on its hold
// gesture's tap, see useHoldToDrag). The Feuer glyph is the one marker that draws `.sym-spread`.
const selectFeuer = async (page) => {
  await page.evaluate(() => {
    const marker = [...document.querySelectorAll('.marker')].find((el) => el.querySelector('.sym-spread'))
    if (!marker) throw new Error('Feuer marker not found')
    const r = marker.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 7, isPrimary: true, button: 0, buttons: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerType: 'touch' }
    marker.dispatchEvent(new PointerEvent('pointerdown', o))
    marker.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }))
  })
  await page.waitForTimeout(1500)
}

// The Einsatz camera fits the whole incident, so at load the Schloss is small in the frame.
// Three wheel notches around the fire (≈2.3×) make the scene readable and keep the street and
// the hose line in view; the same on both devices, so the hero pair shows one picture twice.
const zoomToScene = async (page) => {
  const c = await page.evaluate(() => {
    const marker = [...document.querySelectorAll('.marker')].find((el) => el.querySelector('.sym-spread'))
    const r = marker.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(c.x, c.y)
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(2500) // tiles for the new zoom
}

// The same for a plan: at sheet scale (Modul 1 is 1:2500) the Karte's symbols, mirrored onto
// it through the demo's georeference, pile up on the castle. Zoom on the castle – a fixed spot
// of the sheet (`at`, fractions of it) – until they stand apart.
// Where the castle sits on the Schloss's Modul 1 sheet, as fractions of the page.
const CASTLE = { x: 0.53, y: 0.475 }
const zoomOnSheet = (at, notches) => async (page) => {
  // the sheet is drawn as image tiles (Whiteboard · wb-tile); their union is the whole page
  const r = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('img[class*="wb-tile"]')].map((el) => el.getBoundingClientRect()).filter((b) => b.width > 0)
    if (!tiles.length) return null
    const x = Math.min(...tiles.map((b) => b.left)), y = Math.min(...tiles.map((b) => b.top))
    return { x, y, w: Math.max(...tiles.map((b) => b.right)) - x, h: Math.max(...tiles.map((b) => b.bottom)) - y }
  })
  if (!r) throw new Error('plan sheet not found')
  for (let i = 0; i < notches; i++) {
    await page.mouse.move(r.x + at.x * r.w, r.y + at.y * r.h)
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(2000)
}

// The app remembers the last view across loads, so every shot navigates first – the map shots
// too. The iPad's rail buttons carry plain names (exact match: «Gebäude» must not hit the
// «Gebäude-Info» pill); the phone's bottom bar names carry a status («Pläne · Modul 1»,
// «Rapport · 4 offen»), so there they match by prefix.
const navTo = (name) => async (page) => {
  const rail = page.locator('.nav-item').getByText(name, { exact: true })
  if (await rail.count()) await rail.first().click()
  else await page.getByRole('button', { name: new RegExp(`^${name}`) }).last().click()
  await page.waitForTimeout(2500)
}
const then = (...steps) => async (page) => { for (const step of steps) await step(page) }
const openPlan = async (page) => {
  await page.getByRole('button', { name: /^Pläne/ }).first().click()
  await page.waitForTimeout(800)
  await page.getByText('Modul 1', { exact: true }).last().click()
  await page.waitForTimeout(3500)
}
const openVerlauf = async (page) => {
  await navTo('Karte')(page)
  await page.getByRole('button', { name: /^Verlauf/ }).first().click()
  await page.waitForTimeout(2500)
}

/** One device shot = a fresh load of the demo, then `prep`. Atemschutz first: the seeded
 *  Trupps go overdue ~10 min after a reset. */
const deviceShots = [
  { device: 'phone', name: 'trupps', prep: navTo('Trupps') },
  { device: 'tablet', name: 'karte', prep: then(navTo('Karte'), zoomToScene) },
  { device: 'phone', name: 'karte', prep: then(navTo('Karte'), zoomToScene) },
  { device: 'tablet', name: 'feuer', prep: then(navTo('Karte'), zoomToScene, selectFeuer) },
  { device: 'phone', name: 'feuer', prep: then(navTo('Karte'), zoomToScene, selectFeuer) },
  { device: 'tablet', name: 'plan', prep: then(navTo('Modul 1'), zoomOnSheet(CASTLE, 12)) },
  { device: 'phone', name: 'plan', prep: then(openPlan, zoomOnSheet(CASTLE, 12)) },
  { device: 'phone', name: 'verlauf', prep: openVerlauf },
  { device: 'tablet', name: 'rapport', prep: navTo('Rapport') },
  { device: 'phone', name: 'rapport', prep: navTo('Rapport') },
]

/**
 * Crops one lossless capture to `keep` (device pixels from `cut`), scales it to `width` and
 * encodes it. `page` is a blank tab of the same browser – the app has nothing to do with it.
 */
const encode = async (page, png, { width, type, quality, cut, crop }) => {
  const b64 = await page.evaluate(async ([src, width, type, quality, cut, crop]) => {
    const img = new Image()
    img.src = src
    await img.decode()
    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight
    if (cut) { sy = cut.top; sh -= cut.top + cut.bottom }
    if (crop) {
      // A window around (cx, cy) at 1/zoom size – the link preview's close-up of the Einsatzort.
      sw = img.naturalWidth / crop.zoom
      sh = img.naturalHeight / crop.zoom
      sx = Math.min(Math.max(crop.cx * img.naturalWidth - sw / 2, 0), img.naturalWidth - sw)
      sy = Math.min(Math.max(crop.cy * img.naturalHeight - sh / 2, 0), img.naturalHeight - sh)
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = Math.round(sh * (width / sw))
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL(type, quality).split(',')[1]
  }, [`data:image/png;base64,${png.toString('base64')}`, width, type, quality, cut ?? null, crop ?? null])
  return Buffer.from(b64, 'base64')
}

const prefsCookie = (theme, mode) => {
  const { host, protocol } = new URL(base)
  return {
    name: 'kp-front-prefs',
    value: encodeURIComponent(JSON.stringify({ theme: theme === 'dark' ? 'night' : 'day', mode })),
    domain: host.split(':')[0],
    path: '/',
    secure: protocol === 'https:',
    sameSite: 'Lax',
    expires: Math.floor(Date.now() / 1000) + 3600,
  }
}

/** Loads the demo into `page` until the app stands, signed in if `--pin`, demo chrome hidden. */
const openApp = async (page) => {
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
  await page.getByRole('button', { name: 'Karte', exact: true }).first().waitFor({ timeout: 45000 })
  await page.addStyleTag({ content: HIDE_CSS })
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1500)
  // The Gebäude card opens by itself the first time a device shows this Einsatz. Right for an
  // operator, wrong in a picture of the map: close it.
  const buildingX = page.locator('section[aria-label="Gebäude"] button[aria-label="Schliessen"]')
  if (await buildingX.count()) {
    await buildingX.first().click().catch(() => {})
    await page.waitForTimeout(400)
  }
}

const captureDevices = async (browser, theme) => {
  const shots = deviceShots.filter((s) => wanted(s.name))
  for (const [device, d] of Object.entries(DEVICES)) {
    const mine = shots.filter((s) => s.device === device)
    if (!mine.length) continue
    const output = join(SHOTS, ...(theme === 'dark' ? ['dark'] : []), device)
    mkdirSync(output, { recursive: true })
    const ctx = await browser.newContext({
      viewport: d.viewport,
      deviceScaleFactor: d.scale,
      isMobile: d.mobile,
      hasTouch: true,
      locale: 'de-CH',
      timezoneId: 'Europe/Zurich',
      colorScheme: theme,
      reducedMotion: 'reduce',
    })
    await ctx.addCookies([prefsCookie(theme, 'map')])
    await ctx.addInitScript(() => {
      try { localStorage.setItem('kp.demo.welcomed', '1') } catch { /* private mode */ }
    })
    const encoder = await ctx.newPage()
    console.log(`→ ${base} (${device}, ${theme})`)
    for (const shot of mine) {
      const page = await ctx.newPage()
      page.on('pageerror', (e) => console.warn('  ! page error:', String(e).slice(0, 120)))
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { ...d.insets, left: 0, right: 0 } })
      await openApp(page)
      if (shot.prep) await shot.prep(page)
      const png = await page.screenshot({ type: 'png' })
      const cut = { top: (d.insets.top - d.keep.top) * d.scale, bottom: (d.insets.bottom - d.keep.bottom) * d.scale }
      writeFileSync(join(output, `${shot.name}.webp`), await encode(encoder, png, { width: d.width, type: 'image/webp', quality: WEBP_QUALITY, cut }))
      console.log(`  ✓ ${device}/${shot.name}.webp`)
      await page.close()
    }
    await ctx.close()
  }
}

// ─── Desktop pass: link preview + README ──────────────────────────────────────
//
// One shot = one view from the left nav rail. `og` marks the link-preview picture (a crop
// around the Einsatzort: the Einsatz camera fits the whole incident, so the Schloss is small in
// the full frame); `docs` names the README PNG written from the same page state.
const VIEWPORT = { width: 1500, height: 937 }
const desktopShots = [
  { name: 'lage', nav: 'Karte', settle: 3500, docs: 'lage', og: true, crop: { cx: 0.49, cy: 0.6, zoom: 1.8 } },
  { name: 'gebaeude', nav: 'Gebäude', settle: 1500, docs: 'gebaeude' },
  { name: 'atemschutz', nav: 'Trupps', settle: 1200, docs: 'atemschutz' },
  { name: 'mittel', nav: 'Material', settle: 1200, docs: 'mittel' },
]

const captureDesktop = async (browser) => {
  const shots = desktopShots.filter((s) => wanted(s.name) && ((s.og && !docsOnly) || (s.docs && !siteOnly)))
  if (!shots.length) return
  mkdirSync(DOCS_SHOTS, { recursive: true })
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    // Never below 2: the link preview is a crop and a 1× capture would be upscaled.
    deviceScaleFactor: Math.max(2, scale),
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  await ctx.addCookies([prefsCookie('light', 'map')])
  await ctx.addInitScript(() => {
    try { localStorage.setItem('kp.demo.welcomed', '1') } catch { /* private mode */ }
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.warn('  ! page error:', String(e).slice(0, 120)))
  const encoder = await ctx.newPage()
  console.log(`→ ${base} (desktop)`)
  await openApp(page)
  for (const shot of shots) {
    await page.getByRole('button', { name: shot.nav, exact: true }).and(page.locator('.nav-item')).first().click()
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(shot.settle)
    const png = await page.screenshot({ type: 'png' })
    if (shot.og && !docsOnly) {
      writeFileSync(join(SHOTS, `${shot.name}.jpg`), await encode(encoder, png, { width: VIEWPORT.width, type: 'image/jpeg', quality: OG_QUALITY, crop: shot.crop }))
      console.log(`  ✓ ${shot.name}.jpg  (link preview)`)
    }
    // PNG, because README images are often viewed enlarged on GitHub and text should stay
    // lossless there. A cropped shot goes through the same canvas, at the capture's own scale.
    if (shot.docs && !siteOnly) {
      const out = shot.crop
        ? await encode(encoder, png, { width: Math.round(VIEWPORT.width * scale), type: 'image/png', crop: shot.crop })
        : png
      writeFileSync(join(DOCS_SHOTS, `${shot.docs}.png`), out)
      console.log(`  ✓ docs/screenshots/${shot.docs}.png`)
    }
  }
  await ctx.close()
}

const run = async () => {
  const browser = await chromium.launch()
  try {
    if (!docsOnly) for (const theme of themes) await captureDevices(browser, theme)
    if (!requestedTheme || requestedTheme === 'light') await captureDesktop(browser)
  } finally {
    await browser.close()
  }
  console.log('Screenshots captured. Rebuild with: node site/build.mjs')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
