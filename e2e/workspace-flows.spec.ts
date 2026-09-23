import { test, expect, type Page } from '@playwright/test'
import { ensureIncidentOpen, expectNoCrash, login } from './helpers'

// Workflow e2e for the workspace split (23.09.2026): the handful of end-to-end paths that cross
// the seams the IncidentWorkspace / Whiteboard extractions cut along — a gesture's one undo
// step, the one timeline across surfaces, the keyboard routing, the one Abschluss confirm, and
// the replay lock. The jsdom suite pins each seam from the inside
// (src/IncidentWorkspace.harness.test.tsx, src/components/Whiteboard.test.tsx); this drives the
// built app through them.
//
// ⚠️ OPT-IN (E2E_WORKFLOWS=1), chromium only. Every flow WRITES to the open incident, so it must
// never run against a shared demo (skipped there regardless), and it was written without a
// private stack to execute it on — until it has been run green once against one, the CI image
// job must not depend on it. Run locally:
//   E2E_WORKFLOWS=1 E2E_BASE_URL=http://localhost:5188 pnpm exec playwright test workspace-flows --project chromium

test.skip(!process.env.E2E_WORKFLOWS, 'workflow e2e is opt-in (E2E_WORKFLOWS=1) until verified against a private stack')

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'workflow e2e runs on chromium only')
  const config = await page.request.get('/api/config')
  test.skip(config.ok() && (await config.json()).identity?.demoMode === true, 'mutates the incident — never against a shared demo')
  await login(page)
  await ensureIncidentOpen(page)
})

const undoBtn = (page: Page) => page.locator('.tb-act-history').first()
const redoBtn = (page: Page) => page.locator('.tb-act-history').nth(1)
const surface = (page: Page) => page.locator('.app')

/** a freehand Linie across the middle of the Karte (the line tool starts in Freihand) */
async function drawMapLine(page: Page) {
  await page.getByRole('button', { name: 'Karte', exact: true }).click()
  const canvas = page.locator('canvas.maplibregl-canvas').first()
  await expect(canvas).toBeVisible()
  await page.keyboard.press('l')
  const box = (await canvas.boundingBox())!
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x - 120, y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(x - 120 + i * 20, y + (i % 2) * 6)
  await page.mouse.up()
}

test('F1 · Karte: a drawn Linie is one step on the header pair — ↶ takes it, ↷ gives it back', async ({ page }) => {
  await drawMapLine(page)
  await expect(undoBtn(page)).toBeEnabled()
  await undoBtn(page).click()
  await expect(redoBtn(page)).toBeEnabled()
  await redoBtn(page).click()
  await expect(undoBtn(page)).toBeEnabled()
  await expectNoCrash(page, 'Karte after ↶↷')
})

test('F2 · Tafel: a Fläche from three taps, auto-committed on tap-away, is one ↶', async ({ page }) => {
  await page.getByRole('button', { name: 'Tafel', exact: true }).click()
  const board = page.locator('.whiteboard').first()
  await expect(board).toBeVisible()
  await page.getByRole('button', { name: 'Fläche', exact: true }).click()
  const ink = page.locator('.wb-ink').first()
  const box = (await ink.boundingBox())!
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.7]]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
    await page.waitForTimeout(400) // no two taps may read as the double-tap finish
  }
  // three vertex grips on the draft, then tap-away commits it (A6)
  await expect(page.getByRole('button', { name: 'Eckpunkt ziehen · gedrückt halten zum Löschen' })).toHaveCount(3)
  await page.getByRole('button', { name: 'Auswahl', exact: true }).click()
  await expect(page.getByText('Fläche gespeichert')).toBeVisible()
  await expect(undoBtn(page)).toBeEnabled()
  await expectNoCrash(page, 'Tafel')
})

test('F3 · one timeline: ⌘Z takes back the Tafel step first, then the Karte line', async ({ page }) => {
  await drawMapLine(page)
  await page.getByRole('button', { name: 'Tafel', exact: true }).click()
  await expect(page.locator('.whiteboard').first()).toBeVisible()
  await page.getByRole('button', { name: 'Absperrkreis', exact: true }).click()
  const ink = page.locator('.wb-ink').first()
  const box = (await ink.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2) // a tap drops a default cordon
  const rings = page.locator('.wb-ink-svg circle')
  await expect(rings.first()).toBeVisible()
  const before = await rings.count()
  // back on the Karte and home again: the plan's stack lives above the unmounting board
  await page.getByRole('button', { name: 'Karte', exact: true }).click()
  await page.getByRole('button', { name: 'Tafel', exact: true }).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => rings.count()).toBeLessThan(before)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(undoBtn(page)).toBeDisabled()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(undoBtn(page)).toBeEnabled()
})

test('F4 · keyboard: K / C / A / R switch surfaces; an open Hilfe leaves the keys alone', async ({ page }) => {
  await page.getByRole('button', { name: 'Karte', exact: true }).click()
  for (const [k, m] of [['c', 'checklists'], ['a', 'atemschutz'], ['r', 'rapport'], ['k', 'map']] as const) {
    await page.keyboard.press(k)
    await expect(surface(page)).toHaveClass(new RegExp(`mode-${m}\\b`))
  }
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('c')
  await expect(surface(page)).toHaveClass(/mode-map\b/)
  await page.keyboard.press('Escape')
})

test('F5 · Abschluss from the Einsatz menu: the confirm names the open points, Abbrechen leaves the Einsatz open', async ({ page }) => {
  await page.locator('.ip-switch-btn').click()
  await page.getByRole('button', { name: 'Einsatz abschliessen' }).click()
  const ask = page.getByRole('alertdialog')
  await expect(ask).toBeVisible()
  await expect(ask).toContainText('Einsatz abschliessen')
  await ask.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(ask).toHaveCount(0)
  await expect(page.locator('nav.navrail')).toBeVisible()
  await expect(page.getByText('Einsatz abgeschlossen')).toHaveCount(0)
})

test('F7 · replay locks the drawing tools and «Zurück zu Live» hands them back', async ({ page }) => {
  await drawMapLine(page) // something for the replay to show
  await page.getByRole('button', { name: 'Verlauf', exact: true }).click()
  await page.getByRole('button', { name: 'Wiedergabe starten' }).click()
  await expect(page.getByText('VERLAUF · WIEDERGABE')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Linie', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Zurück zu Live' }).click()
  await expect(page.getByRole('button', { name: 'Linie', exact: true })).toBeVisible()
})
