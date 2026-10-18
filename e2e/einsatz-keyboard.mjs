// The Einsatz's phone sheets with the keyboard up, in the INSTALLED app (owner, 18.10.2026: once the
// Karte search worked in the installed iPhone app, «the same rule» for the Einsatz screens). A
// device-class check, not a Playwright spec: WebKit at iPhone size, run by hand against a running
// stack (docs/ui-conventions.md · «The keyboard is measured from the app's full height»).
//
//   LD_LIBRARY_PATH=… node e2e/einsatz-keyboard.mjs http://127.0.0.1:5110   (PIN 000000 stack)
//
// What it models (ios-standalone.mjs; the readouts in docs/karte-objekte.md, review rounds 9–10):
// in the installed app, with the keys up, a touch makes iOS shrink `innerHeight` to the visual
// viewport (793 → 424) and scroll the window by the rest (369) — also in STEPS while the finger is
// down (793 → 711 → 785 …, `scrollY = 793 − innerHeight`) — while the frame `position: fixed` is laid
// out in stays 793 tall. Safari tabs never do this. Everything the Einsatz derives from the keyboard
// (`lib/useKeyboardInset`: the sheets' `is-kb` + `--kb-inset`, the composer's `--jc-kb`, the root's
// `data-kb` and `--vv-foot`) read the live `innerHeight`, so in the collapse it saw «no keyboard»
// and the sheets left the keys. Here, per sheet and per frame, with a field focused and the keys up:
//   · the sheet's foot stands on the keys, its field on the screen;
//   · the collapse (kept, and after a `scrollTo(0, 0)` iOS honours) and every step of the stepped one:
//     «keyboard up» stays true (root `data-kb`, the sheet's `is-kb`), the sheet's foot stays on the
//     keys and its field where it was on the SCREEN (layout px − iOS's pan), within 2 px;
//   · the tab frame: iOS's ordinary pan (no collapse) changes nothing either — Safari stays as it was.
// It cannot show what only the iPhone does: where iOS decides to pan, and that `100dvh` (the sheets'
// caps) holds the full height in the collapse as the fixed frame does.
//
// Exit code 1 and «RED» lines when a check fails. `EINSATZ_FRAMES=app` runs one frame only.
import { createRequire } from 'node:module'
import path from 'node:path'
import { FRAMES, phoneContext } from './ios-standalone.mjs'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { webkit } = require('@playwright/test')
const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5188'
const PIN = process.env.E2E_PIN ?? '000000'
// the owner's readout, round 10: innerHeight while the finger was down (2 fps, filled in between)
const STEPS = [756, 711, 690, 666, 690, 740, 782, 792, 785, 740, 711, 666, 711, 785, 793]
const FIELD = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="tel"], input[type="number"]'

let red = 0
const check = (label, ok, detail) => { console.log(`${ok ? 'green' : 'RED  '} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`); if (!ok) red++ }

const browser = await webkit.launch()
let page

const frames = (n = 4) => page.evaluate((n) => new Promise((ok) => { const f = (i) => (i ? requestAnimationFrame(() => f(i - 1)) : ok()); f(n) }), n)

/** A signed-in phone in `frame`, an Einsatz open (one is opened when none is). */
async function openEinsatz(frame) {
  const ctx = await phoneContext(browser, frame, BASE)
  page = await ctx.newPage()
  await page.goto('/')
  await page.locator('.roster-tile, [data-karte], .topbar').first().waitFor({ timeout: 30000 })
  if (await page.locator('.roster-tile').first().isVisible().catch(() => false)) {
    await page.locator('.roster-tile').first().click()
    await page.locator('.pinpad').waitFor()
    for (const d of PIN) await page.keyboard.press(d)
    await page.keyboard.press('Enter')
  }
  await page.locator('[data-karte], .fab-entry').first().waitFor({ timeout: 30000 })
  // no Einsatz open: «Karte & Objekte» → app menu → «Einsatz eröffnen»
  if (!(await page.locator('.fab-entry').count())) {
    await page.locator('[data-karte-menu]').click()
    await page.getByRole('button', { name: 'Einsatz eröffnen' }).click()
    await page.getByPlaceholder('z. B. Gebäudebrand Schulhaus').fill('Tastatur-Check')
    await page.getByRole('button', { name: 'Einsatz öffnen' }).click()
  }
  await page.locator('.fab-entry').first().waitFor({ timeout: 30000 })
  // the first-visit guide, when it shows
  const later = page.getByRole('button', { name: 'Später' })
  if (await later.isVisible().catch(() => false)) await later.click()
  return ctx
}

/** Where things stand on the SCREEN (layout px − iOS's pan): the sheet's top and foot, its field,
 *  the visible band's foot (`vvh` — the keyboard's top edge) and whether «keyboard up» holds. */
function reading(sel) {
  const vv = window.visualViewport
  const sheet = [...document.querySelectorAll(sel)].filter((el) => el.getBoundingClientRect().height > 0).at(-1)
  const field = document.activeElement
  const screen = (y) => Math.round(y - vv.offsetTop)
  const s = sheet.getBoundingClientRect()
  return { rootKb: document.documentElement.hasAttribute('data-kb'), isKb: sheet.classList.contains('is-kb'),
    inner: window.innerHeight, scrollY: window.scrollY, vvh: Math.round(vv.height), top: screen(s.top), foot: screen(s.bottom),
    field: sheet.contains(field) ? screen(field.getBoundingClientRect().top) : null }
}

/** One sheet: `open` puts it on screen, `sel` finds its frame; the first text field in it gets the
 *  caret and the keys come up. */
async function sheetChecks(name, { open, close, sel }, frame) {
  await open()
  await page.locator(sel).last().waitFor()
  await frames(6)
  const kb = frame.collapse?.kb ?? frame.kb
  await page.locator(sel).last().locator(FIELD).first().focus()
  await page.evaluate((kb) => window.__kb({ kb, pan: 0 }), kb)
  await frames(6)
  const at = () => page.evaluate(reading, sel)
  const up = await at()
  const onKeys = (b) => b.rootKb && b.isKb && Math.abs(b.foot - b.vvh) <= 2 && b.field != null && b.field >= 0 && b.field < b.vvh
  check(`${name} · keys up: «keyboard up», the sheet's foot on the keys, its field on the screen`, onKeys(up), up)
  // still: «keyboard up», the foot on the keys, the field where it was on the screen
  const held = (b) => onKeys(b) && Math.abs(b.field - up.field) <= 2 && Math.abs(b.top - up.top) <= 2
  if (frame.collapse) {
    // round 9: the collapse, iOS keeping the scroll (it ignores scrollTo during the touch)
    await page.evaluate(({ kb, pan }) => window.__kb({ kb, pan, collapse: true, ignoreScrollTo: true }), frame.collapse)
    await frames(6)
    let b = await at()
    check(`${name} · collapse (innerHeight ${b.inner}, scrollY ${b.scrollY}): keyboard up, sheet on the keys, field where it was`, held(b), { up, b })
    // …and after a scrollTo(0, 0) iOS honours: the window back at 0, innerHeight still collapsed
    await page.evaluate(() => { window.__kb({ ignoreScrollTo: false }); window.scrollTo(0, 0) })
    await frames(6)
    b = await at()
    check(`${name} · collapse, window back at 0 (innerHeight ${b.inner}): keyboard up, sheet on the keys, field where it was`, held(b) && b.scrollY === 0, { up, b })
    await page.evaluate(() => window.__kb({ collapse: false, shrink: null, pan: 0 }))
    await frames(6)
    // round 10: the collapse in steps — one frame after each, nothing moved on the screen
    const steps = await page.evaluate(async ({ inners, sel, reading }) => {
      const read = new Function(`return (${reading})`)()
      const raf = () => new Promise((ok) => requestAnimationFrame(() => ok()))
      const out = []
      for (const inner of inners) { window.__collapseTo(inner, 'icb'); await raf(); out.push({ inner, ...read(sel) }) }
      return out
    }, { inners: STEPS, sel, reading: reading.toString() })
    await page.evaluate(() => window.__kb({ collapse: false, shrink: null, pan: 0 }))
    await frames(6)
    const bad = steps.filter((b) => !held(b))
    check(`${name} · collapse in steps (${STEPS.length}): at every step keyboard up, sheet on the keys, field within 2px`, !bad.length,
      { up, bad: bad.map((b) => `${b.inner}: kb ${b.rootKb}/${b.isKb} foot ${b.foot}/${b.vvh} field ${b.field} top ${b.top}`) })
  } else {
    // a Safari tab: iOS's ordinary pan, innerHeight untouched
    await page.evaluate(() => window.__kb({ pan: 90, ignoreScrollTo: true }))
    await frames(6)
    const b = await at()
    check(`${name} · iOS pans the page by 90px: keyboard up, sheet on the keys, field where it was`, held(b), { up, b })
  }
  await page.evaluate(() => window.__kb({ kb: 0, pan: 0, ignoreScrollTo: false, collapse: false, shrink: null }))
  await page.evaluate(() => document.activeElement?.blur?.())
  await frames(6)
  await close()
  await page.locator(sel).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
}

// the sheet's own ✕ (or «Abbrechen»): Escape in a sheet with fields does not close it
const closeDialog = () => page.locator('[role="dialog"]').last().getByRole('button', { name: /^(Schliessen|Abbrechen)$/ }).first().click()

const SURFACES = {
  // the owner's re-check: Journal → «Neuer Eintrag» (lib/overlays/Overlay, its own `--jc-kb` answer)
  'Neuer Eintrag': {
    sel: '.journal-composer',
    open: () => page.locator('.fab-entry').first().click(),
    close: () => page.locator('.journal-composer').getByRole('button', { name: 'Schliessen' }).first().click(),
  },
  // a Sheet with fields (lib/overlays/Sheet · .ip-sheet)
  'Einsatzdaten bearbeiten': {
    sel: '[role="dialog"]',
    open: async () => { await page.locator('.ip-switch-btn').click(); await page.getByRole('button', { name: 'Einsatzdaten bearbeiten' }).click() },
    close: () => closeDialog(),
  },
  // Trupps → «Trupp anmelden» (the Atemschutz form, Overlay)
  'Trupp anmelden': {
    sel: '[role="dialog"]',
    open: async () => { await page.locator('.nav-item').filter({ hasText: 'Trupps' }).click(); await page.getByRole('button', { name: 'Trupp anmelden' }).first().click() },
    close: () => closeDialog(),
  },
}

for (const name of (process.env.EINSATZ_FRAMES ?? 'tab,app').split(',')) {
  const frame = FRAMES[name]
  const ctx = await openEinsatz(frame)
  check(`[${name}] the app sees itself as ${frame.standalone ? 'the installed app (standalone)' : 'a browser tab'}`, await page.evaluate(() => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) === frame.standalone, {})
  for (const [label, s] of Object.entries(SURFACES)) await sheetChecks(`[${name}] ${label}`, s, frame)
  await ctx.close()
}

await browser.close()
console.log(red ? `${red} RED` : 'all green')
process.exit(red ? 1 : 0)
