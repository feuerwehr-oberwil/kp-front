import { test, expect, dismissFirstViewGebaeude, ensureIncidentOpen, login, EINSATZ_RAIL } from './helpers'

// Android's back = Esc (owner, 17.11.2026, duck sweep CONT.4 – the Samsung tablet's back button
// left the Einsatz instead of closing the sheet): the native back closes the TOP layer – a sheet,
// a menu, a dialog – one per press, and never leaves the Einsatz while one is open
// (lib/overlays/layer · useBackLayer). Read-only: it opens and closes, it writes nothing.

test.beforeEach(async ({ page }) => {
  await login(page)
  await ensureIncidentOpen(page)
  await dismissFirstViewGebaeude(page)
})

test('the native back closes the top layer, one per press, and stays in the Einsatz', async ({ page }) => {
  const at = page.url()
  const menu = page.locator('.ip-switch .ip-menu')
  const settings = page.getByRole('dialog', { name: 'Einstellungen' })

  // the Einsatz-Menü, then «Einstellungen» from it – the menu waits under the sheet
  await page.locator('.ip-switch-btn').click()
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: 'Einstellungen' }).click()
  await expect(settings).toBeVisible()

  // back #1: the sheet goes, the menu it was opened from is still there
  await page.goBack()
  await expect(settings).toHaveCount(0)
  await expect(menu).toBeVisible()

  // back #2: the menu goes; the Einsatz stands where it stood
  await page.goBack()
  await expect(menu).toHaveCount(0)
  await expect(page.locator(EINSATZ_RAIL)).toBeVisible()
  expect(page.url()).toBe(at)
})

test('a layer closed by hand takes its back entry with it', async ({ page }) => {
  const onLayerEntry = () => page.evaluate(() => (history.state as Record<string, unknown> | null)?.kpLayer ?? null)
  const menu = page.locator('.ip-switch .ip-menu')
  await page.locator('.ip-switch-btn').click()
  await expect(menu).toBeVisible()
  await expect.poll(onLayerEntry).toBe(true)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // the entry it stood on was walked back: no stale entry for a later back to land on
  await expect.poll(onLayerEntry).toBeNull()
})
