import { test, expect, login, ensureIncidentOpen, OFFLINE_FETCH_FAILURE } from './helpers'
import { isolateFromOutside } from './perf/harness'

// An idle worker restart does not fire controllerchange. The account page must re-announce
// its current session when asked, before Workbox decides whether its reference cache may answer.
test.use({ expectedClientErrors: [OFFLINE_FETCH_FAILURE] })

test('cached plans stay available offline after an idle service-worker restart', async ({ page, context, browserName, baseURL }) => {
  test.skip(browserName !== 'chromium', 'service-worker stop uses Chromium CDP')
  if (!baseURL) throw new Error('The reference-cache regression needs a configured baseURL')
  await isolateFromOutside(context, baseURL, [])
  await login(page)
  await ensureIncidentOpen(page)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  if (!await page.evaluate(() => !!navigator.serviceWorker.controller)) {
    await page.reload()
    await expect(page.locator('nav.navrail')).toBeVisible()
  }
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open('kp-media-cache-owner')
    return !!await cache.match('/__kp/media-cache-owner')
  })).toBe(true)

  const path = '/api/reference/plan%3Aoffline-restart-proof?v=1'
  await page.evaluate(async (url) => {
    const cache = await caches.open('reference-plans')
    await cache.put(url, new Response('cached plan bytes', { headers: { 'content-type': 'application/pdf' } }))
  }, path)
  expect(await page.evaluate(async (url) => (await fetch(url)).text(), path)).toBe('cached plan bytes')

  const cdp = await context.newCDPSession(page)
  let activeVersion = ''
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    const version = versions.find((v) => v.status === 'activated' && v.scriptURL === new URL('/sw.js', baseURL).href)
    if (version) activeVersion = version.versionId
  })
  await cdp.send('ServiceWorker.enable')
  await expect.poll(() => activeVersion).not.toBe('')
  try {
    await context.setOffline(true)
    await cdp.send('ServiceWorker.stopWorker', { versionId: activeVersion })
    const result = await page.evaluate(async (url) => {
      try { return { body: await (await fetch(url)).text() } }
      catch (error) { return { error: String(error) } }
    }, path)
    expect(result).toEqual({ body: 'cached plan bytes' })
  } finally {
    await context.setOffline(false)
    await cdp.detach()
  }
})
