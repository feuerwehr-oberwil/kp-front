import { test, expect } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 } })

test('public demo entry fits a phone and reaches the prepared incident', async ({ page }) => {
  const config = await page.request.get('/api/config')
  const body = config.ok() ? await config.json() : {}
  test.skip(body.identity?.demoMode !== true, 'this production image is configured as a station')

  await page.goto('/')
  const welcome = page.locator('.dw-card')
  await expect(welcome).toBeVisible()
  await expect(welcome.locator('.dw-cta')).toBeVisible()

  const box = await welcome.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(box!.y + box!.height).toBeLessThanOrEqual(844)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await welcome.locator('.dw-cta').click()
  await expect(page.locator('nav.navrail')).toBeVisible()
})
