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
  if (await rail.getByRole('button', { name: 'Rapport', exact: true }).isVisible()) {
    await rail.getByRole('button', { name: 'Rapport', exact: true }).tap()
  } else {
    const record = rail.getByRole('button', { name: /^Einsatz(?: ·|$)/ })
    await record.tap()
    await expect(record).toHaveAttribute('aria-pressed', 'true')
    await record.tap()
    await page.getByRole('dialog').getByRole('option', { name: /^Rapport/ }).tap()
  }
  await expect(page.locator('.report-preflight-body')).toBeVisible()
  const field = page.getByRole('button', { name: 'Einsatzende', exact: true })
  await field.tap()
  const picker = page.locator('.wheelpop')
  await expect(picker.locator('.wheel')).toHaveCount(5)
  await expect(picker.getByRole('textbox')).toHaveCount(0)
  const ok = picker.getByRole('button', { name: 'OK', exact: true })
  const box = (await ok.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await ok.tap()
  await expect(picker).toHaveCount(0)
  await expect(field).not.toHaveText('--.--.---- --:--')
  await field.tap()
  const clear = picker.getByRole('button', { name: 'Leeren', exact: true })
  expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await clear.tap()
  await expect(field).toHaveText('--.--.---- --:--')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expectNoCrash(page, 'touch time controls')
})
