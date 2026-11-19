import { test, expect, login, ensureIncidentOpen, expectNoCrash } from './helpers'

// Runs in real coarse-pointer browser contexts at phone and tablet sizes. Writes only on
// explicitly opted-in disposable stacks, like workspace-flows.spec.ts.
test.skip(!process.env.E2E_WORKFLOWS, 'touch workflows require a private stack (E2E_WORKFLOWS=1)')
test('touch time picker stays reachable, commits a wheel selection and can clear it', async ({ page }) => {
  const config = await page.request.get('/api/config')
  test.skip((await config.json()).identity?.demoMode === true, 'Never mutate a shared demo')
  await login(page)
  await ensureIncidentOpen(page)
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
  const rail = page.locator('nav.navrail')
  // one tile on every width since 10.11.2026 («Rapport», with its open count on a phone). On a
  // phone it is the group's door: with nobody present yet it opens the Anwesenheit, and a second
  // tap offers the three pages.
  const tile = rail.getByRole('button', { name: /^Rapport(?: ·|$)/ })
  await tile.tap()
  const body = page.locator('.report-preflight-body')
  if (!(await body.waitFor({ timeout: 3000 }).then(() => true, () => false))) {
    await tile.tap()
    await page.getByRole('dialog').getByRole('option', { name: /^Rapport/ }).tap()
  }
  await expect(page.locator('.report-preflight-body')).toBeVisible()
  const field = page.getByRole('button', { name: 'Einsatzende', exact: true })
  await field.tap()
  const picker = page.locator('.wheelpop')
  // one date-time control (05.10.2026): hour + minute, plus the day column (always there since
  // 12.11.2026 – the Rapport's read-out is «12.11. 11:26», empty «--.--. --:--», src/lib/format · fieldWhen)
  await expect(picker.locator('.wheel').nth(1)).toBeVisible()
  expect(await picker.locator('.wheel').count()).toBeLessThanOrEqual(3)
  await expect(picker.getByRole('textbox')).toHaveCount(0)
  const ok = picker.getByRole('button', { name: 'OK', exact: true })
  const box = (await ok.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await ok.tap()
  await expect(picker).toHaveCount(0)
  await expect(field).not.toHaveText('--.--. --:--')
  await field.tap()
  const clear = picker.getByRole('button', { name: 'Leeren', exact: true })
  expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await clear.tap()
  await expect(field).toHaveText('--.--. --:--')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expectNoCrash(page, 'touch time controls')
})

// The composer's ONE row (owner pick B «One row», 19.11.2026; 10-journal.css · .jc-row): the Art
// track as «I · A · S» on a phone, the ⏱ | □ track and ONE paper-clip that holds mic · upload ·
// camera – on one line, on a short phone screen too, every control at least a glove's 44px tall.
test('composer one row: I · A · S, ⏱ □ and the clip on one line, the clip holds the media', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'touch-phone', 'the letters are the phone layout')
  await login(page)
  await ensureIncidentOpen(page)
  await page.setViewportSize({ width: 390, height: 400 })
  await page.locator('.fab-entry').tap()
  const row = page.locator('.journal-composer .jc-row')
  await expect(row).toBeVisible()
  const boxes = await row.locator('.jc-track, .jc-rec')
    .evaluateAll((els) => els.map((el) => {
      const { height, top, right } = el.getBoundingClientRect()
      return { height, top, right }
    }))
  expect(boxes).toHaveLength(3)
  for (const b of boxes) {
    expect(b.top).toBeCloseTo(boxes[0].top, 0)
    expect(b.height).toBeGreaterThanOrEqual(44)
    expect(b.right).toBeLessThanOrEqual(390)
  }
  await expect(row.locator('.jc-chip-letter').first()).toHaveText('I')
  await expect(row.locator('.jc-chip-word').first()).toBeHidden()
  await row.getByRole('button', { name: 'Anhang' }).tap()
  for (const word of ['Aufnehmen', 'Datei anhängen', 'Foto']) await expect(page.getByRole('menuitem', { name: word })).toBeVisible()
  // The Lage underneath must keep its canvas in sync as the phone shrinks and expands, even
  // when the first resize coincides with map load. The client-error guard covers both changes.
  const canvas = page.locator('.maplibregl-canvas')
  await expect(canvas).toHaveCSS('height', '400px')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(canvas).toHaveCSS('height', '844px')
  await expectNoCrash(page, 'composer one row')
})
