import { test, expect, type Page } from '@playwright/test'

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
  // Kiosk login: pick a face, then tap the 6-digit PIN (auto-submits on the 6th).
  const tile = page.locator('.roster-tile').first()
  await expect(tile, 'login roster should load (proves SPA + backend roster)').toBeVisible()
  await tile.click()
  await expect(page.locator('.pinpad')).toBeVisible()
  for (const digit of PIN) await page.keyboard.press(digit)
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

  // Lage (map): the MapLibre canvas must actually mount, not just the chrome.
  await page.getByRole('button', { name: 'Karte', exact: true }).click()
  await expect(page.locator('canvas.maplibregl-canvas').first()).toBeVisible()
  await expectNoCrash(page, 'Lage')

  // Plan: the always-present generic sheet ("Tafel" = Leeres Blatt) renders the whiteboard.
  await page.getByRole('button', { name: 'Tafel', exact: true }).click()
  await expect(page.locator('.whiteboard').first()).toBeVisible()
  await expectNoCrash(page, 'Plan')

  // Atemschutz (SCBA board) — a heavy surface; prove it switches in and mounts clean.
  await page.getByRole('button', { name: 'Atemschutz', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Atemschutz', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expectNoCrash(page, 'Atemschutz')

  // Reload: the session cookie + the synced incident workspace + the surface pref must
  // all survive — i.e. no white-screen, no kicked-to-login, no lost incident.
  await page.reload()
  await expect(page.locator('nav.navrail'), 'still authenticated and in an incident after reload').toBeVisible()
  await expectNoCrash(page, 'after reload')
})
