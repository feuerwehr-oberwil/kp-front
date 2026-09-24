import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// White-screen smoke: log in, open an incident, render each core surface, and
// survive a reload with state intact. This is the catastrophic-regression guard
// (build broke / a surface throws on mount / login or session is wedged) that the
// pure-logic unit suite cannot see. Kept deliberately robust over deep: it asserts
// "every major surface renders and the session/incident persist", not pixel detail.
//
// Runs against a live, seeded stack (see playwright.config.ts). The German strings
// below mirror src/config/copy/de.ts (the default de-CH deployment locale).

import { test, expect, expectNoCrash, login, ensureIncidentOpen } from './helpers'

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
    // ⚠️ The old page is still alive between these two lines: a request of its own may 401 and
    // start a refresh that the reload then tears down mid-flight. The server has rotated by
    // then, the browser never stored the successor — and until 24.09.2026 that signed the
    // device out (3 in 40 locally; backend auth/router · refresh now re-delivers it). Kept
    // racy on purpose: it is the reload-while-renewing a real tablet does too.
    await context.clearCookies({ name: 'access_token' })
    await page.reload()
    await expect(
      page.locator('nav.navrail'),
      'the refresh cookie must renew the session after a reload – the container log says why a refresh was refused',
    ).toBeVisible()

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

test.describe(() => {
  // Offline, the Karte's basemap tiles fail to load and MapView reports each failure (onError →
  // lib/reportError, kind «error», «Failed to fetch»). The drill takes the network away on
  // purpose, so that one report is expected; any other still fails the test (./guard.ts).
  test.use({ expectedClientErrors: [/^error: Failed to fetch$/] })

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
    // Delivery must come without a click, but not necessarily off the `online` event: after a
    // reload WHILE offline, Chromium's emulation sometimes never dispatches it (the top bar still
    // said «Offline» 15 s later, 24.09.2026). The outbox then goes out on the Verlauf's next poll
    // round, which pushes before it pulls (useJournal) and is at most `livePollMaxMs` (15 s) away.
    await expect(notice, 'the offline entry must be delivered on its own after reconnect').toHaveCount(0, { timeout: 30_000 })
    await expectNoCrash(page, 'after offline journal recovery')
  })
})
