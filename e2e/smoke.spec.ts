import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// White-screen smoke: log in, open an incident, render each core surface, and
// survive a reload with state intact. This is the catastrophic-regression guard
// (build broke / a surface throws on mount / login or session is wedged) that the
// pure-logic unit suite cannot see. Kept deliberately robust over deep: it asserts
// "every major surface renders and the session/incident persist", not pixel detail.
//
// Runs against a live, seeded stack (see playwright.config.ts). The German strings
// below mirror src/config/copy/de.ts (the default de-CH deployment locale).

// Seed kiosk PIN — the committed dev seed (backend/app/seed_users.json). Override
// with E2E_PIN if a deployment seeds a different one.
const PIN = process.env.E2E_PIN || '000000'

// The ErrorBoundary render-throw fallback (copy/de.ts → errorBoundary.title). If this
// is on screen a surface crashed on mount — the exact failure this smoke exists to catch.
const CRASH_TITLE = 'Ein Fehler ist aufgetreten'

async function expectNoCrash(page: Page, where: string) {
  await expect(
    page.getByText(CRASH_TITLE),
    `${where}: surface crashed (ErrorBoundary fallback shown)`,
  ).toHaveCount(0)
}

async function login(page: Page) {
  await page.goto('/')
  // A station starts on kiosk login; the public demo auto-authenticates and lands directly in
  // its prepared incident. Accept both so the same production-image smoke covers both entryways.
  // ⚠️ ONE locator, not `Promise.race` over two `waitFor`s: the loser of that race stays
  // pending and rejects with a TimeoutError ~30 s later, with nobody left to catch it. Playwright
  // fails the run on an unhandled rejection — typically inside whichever test happens to be
  // running by then, which is not this one.
  const tile = page.locator('.roster-tile').first()
  await page.locator('.roster-tile, nav.navrail').first().waitFor({ state: 'visible' })
  if (await tile.isVisible()) {
    await tile.click()
    await expect(page.locator('.pinpad')).toBeVisible()
    for (const digit of PIN) await page.keyboard.press(digit)
  }

  // The demo's first-visit contract intentionally owns the screen until acknowledged. Read the
  // deployment flag rather than racing an immediate isVisible() against the async config load.
  const config = await page.request.get('/api/config')
  const demoMode = config.ok() && (await config.json()).identity?.demoMode === true
  if (demoMode) {
    const demoWelcome = page.locator('.dw-card')
    await expect(demoWelcome).toBeVisible()
    await demoWelcome.locator('.dw-cta').click()
  }
}

// After login the app shows either the empty state (no open incident) or, if one is
// already open server-side, the incident surfaces directly. Normalise to "an incident
// is open" so the smoke is idempotent across a fresh container and a re-run.
async function ensureIncidentOpen(page: Page) {
  const navrail = page.locator('nav.navrail')

  // The empty state can briefly FLASH before the workspace loads and swaps in an
  // already-open incident, so we can't branch on the CTA being momentarily visible.
  // Instead: give the navrail a chance to appear (incident loaded); only if it never
  // does is the deployment genuinely empty — then open a manual incident.
  try {
    await expect(navrail).toBeVisible({ timeout: 12_000 })
    return
  } catch {
    /* no incident open — fall through to create one */
  }

  // Empty state → open a manual incident (no Divera, no coordinate needed). The landing CTA
  // is "Manueller Einsatz", which opens the create wizard form directly (since the landing
  // rework — there is no intermediate "Einsatz eröffnen" chooser step on the empty state).
  await page.getByRole('button', { name: 'Manueller Einsatz' }).click()
  await page.getByPlaceholder('z. B. Gebäudebrand Schulhaus').fill('E2E Smoke Test')
  await page.getByRole('button', { name: 'Einsatz öffnen' }).click()
  await expect(navrail).toBeVisible()
}

test('core surfaces render and survive reload', async ({ page }) => {
  await login(page)
  await ensureIncidentOpen(page)

  // Karte (map): the MapLibre canvas must actually mount, not just the chrome.
  await page.getByRole('button', { name: 'Karte', exact: true }).click()
  await expect(page.locator('canvas.maplibregl-canvas').first()).toBeVisible()
  await expectNoCrash(page, 'Karte')

  // Plan: the always-present generic sheet ("Tafel" = Leeres Blatt) renders the whiteboard.
  await page.getByRole('button', { name: 'Tafel', exact: true }).click()
  await expect(page.locator('.whiteboard').first()).toBeVisible()
  await expectNoCrash(page, 'Plan')

  // Trupps (the Atemschutz/SCBA board, renamed 04.09. — it carries work squads too) — a heavy
  // surface; prove it switches in and mounts clean.
  await page.getByRole('button', { name: 'Trupps', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Trupps', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expectNoCrash(page, 'Trupps')

  // ⚠️ Checkliste / Anwesenheit / Material / Rapport are NOT driven here yet. Adding
  // them turned main red: the first three switched in, «Material» never reported
  // itself active, and this suite runs against the built image at CI's viewport — a
  // layout this file has no evidence about. Reinstate them with a trace in hand, not
  // by assuming the rail looks the way it does on a desk.

  // Reload: the session cookie + the synced incident workspace + the surface pref must
  // all survive — i.e. no white-screen, no kicked-to-login, no lost incident.
  await page.reload()
  await expect(page.locator('nav.navrail'), 'still authenticated and in an incident after reload').toBeVisible()
  await expectNoCrash(page, 'after reload')
})

async function enterJournalRow(page: Page, text: string) {
  await page.getByRole('button', { name: 'Eintrag', exact: true }).click()
  await page.getByPlaceholder('Was ist passiert? Meldung, Beobachtung, Entscheid …').fill(text)
  await page.getByRole('button', { name: 'Erfassen', exact: true }).click()
  await page.getByRole('button', { name: 'Verlauf', exact: true }).click()
}

test.describe(() => {
  // A service worker can forward requests outside page.route (observed on Linux WebKit).
  // This drill needs a guaranteed server rejection; actual service-worker coverage stays
  // in the core reload and separate offline-recovery tests.
  test.use({ serviceWorkers: 'block' })

  test('session renewal and rejected journal delivery recover', async ({ page, context }) => {
    await login(page)
    const config = await page.request.get('/api/config')
    test.skip((await config.json()).identity?.demoMode === true, 'Recovery drill requires an ordinary station session')
    await ensureIncidentOpen(page)
    await context.clearCookies({ name: 'access_token' })
    await page.reload()
    await expect(page.locator('nav.navrail')).toBeVisible()

    // A locally visible row must never masquerade as accepted by the server.
    const endpoint = '**/api/incidents/*/journal'
    let rejectedPosts = 0
    await page.route(endpoint, async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      await route.fulfill({ status: 422, contentType: 'application/json', body: '{"detail":"Synthetic rejection drill"}' })
      rejectedPosts++
    })
    const rejected = `E2E recovery ${Date.now()}`
    await enterJournalRow(page, rejected)
    await expect.poll(() => rejectedPosts, 'The journal POST must receive the synthetic 422').toBeGreaterThan(0)
    const notice = page.locator('.jr-delivery')
    await expect(notice).toContainText('Auf diesem Gerät gespeichert')
    const downloading = page.waitForEvent('download')
    await notice.getByRole('button', { name: 'Einträge sichern' }).click()
    const path = await (await downloading).path()
    if (!path) throw new Error('Recovery export was not downloaded')
    expect(await readFile(path, 'utf8')).toContain(rejected)
    await expect(notice).toBeVisible() // exporting does not acknowledge delivery
    await page.unroute(endpoint)
    await notice.getByRole('button', { name: 'Erneut versuchen' }).click()
    await expect(notice).toHaveCount(0)
  })
})

test('offline journal entries survive reload and reconnect', async ({ page, context, browserName }) => {
  // Playwright's service-worker support is Chromium-only (playwright.dev/docs/service-workers).
  // WebKit offline emulation fails even for a minimal cached page; physical Safari remains
  // an acceptance gate. Core reload + session/rejection recovery above still run in WebKit.
  test.skip(browserName !== 'chromium', 'Offline service-worker automation requires Chromium')
  await login(page)
  const config = await page.request.get('/api/config')
  test.skip((await config.json()).identity?.demoMode === true, 'Recovery drill requires an ordinary station session')
  await ensureIncidentOpen(page)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await context.setOffline(true)
  const offline = `E2E offline ${Date.now()}`
  await enterJournalRow(page, offline)
  const notice = page.locator('.jr-delivery')
  await expect(notice).toBeVisible()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('nav.navrail')).toBeVisible()
  await page.getByRole('button', { name: 'Verlauf', exact: true }).click()
  await expect(page.getByText(offline, { exact: true })).toBeVisible()
  await context.setOffline(false)
  await expect(notice).toHaveCount(0)
  await expectNoCrash(page, 'after offline journal recovery')
})
