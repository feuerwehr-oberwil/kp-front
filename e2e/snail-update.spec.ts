import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from './helpers'

// The real production shell and Workbox run under a disposable local origin. Only the worker
// bytes change between launches; API answers stay anonymous, so the drill touches no station
// data. Page routing cannot reliably intercept the browser's worker-update script fetch.
test('a startup worker update continues the snail instead of replaying its entrance', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('A production stack is required for the worker-update drill')
  let version = 1
  const server = createServer(async (request, response) => {
    try {
      const path = request.url || '/'
      if (path.startsWith('/api/')) {
        if (path === '/api/auth/me') await new Promise(resolve => setTimeout(resolve, 300))
        const denied = path === '/api/auth/me' || path === '/api/auth/refresh'
        response.writeHead(denied ? 401 : 200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(denied ? { detail: 'Not authenticated' } : path === '/api/auth/roster' ? [] : {}))
        return
      }
      const upstream = await fetch(new URL(path, baseURL))
      const body = Buffer.from(await upstream.arrayBuffer())
      response.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      response.end(path === '/sw.js' ? Buffer.concat([body, Buffer.from(`\n// Snail update drill ${version}\n`)]) : body)
    } catch {
      response.writeHead(502)
      response.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.addInitScript(() => {
      const record = (entry: object) => {
        const entries = JSON.parse(sessionStorage.getItem('snail-update-observations') || '[]') as object[]
        sessionStorage.setItem('snail-update-observations', JSON.stringify([...entries, entry]))
      }
      record({ event: 'document' })
      document.addEventListener('animationstart', event => {
        if (event.animationName.endsWith('-arrival')) {
          const node = event.target as Element
          if (node.closest('.boot-splash')) record({ event: 'arrival', elapsed: event.elapsedTime })
          else {
            const animation = node.getAnimations().find(item => (item as CSSAnimation).animationName === event.animationName)
            record({ event: 'react-arrival', progress: animation?.effect?.getComputedTiming().progress })
          }
        }
      }, true)
    })
    const observations = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('snail-update-observations') || '[]') as { event: string; elapsed?: number; progress?: number }[])
    await page.goto(origin)
    await expect(page.locator('.login-state')).toBeVisible()
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)

    // An ordinary reload still gets its own complete entrance.
    await page.evaluate(() => sessionStorage.setItem('snail-update-observations', '[]'))
    await page.reload()
    await expect(page.locator('.login-state')).toBeVisible()
    expect((await observations()).filter(entry => entry.event !== 'react-arrival')).toEqual([{ event: 'document' }, { event: 'arrival', elapsed: 0 }])

    // An update found during the next opening really reloads the page, but its second cover
    // must begin past the entrance. Trigger the check explicitly instead of waiting for the
    // browser's update-check throttle; every install/activation/reload handler is the real one.
    await page.evaluate(() => sessionStorage.setItem('snail-update-observations', '[]'))
    await page.reload()
    await expect(page.locator('.login-state')).toBeVisible()
    version++ // discover only after this entrance ends, still inside the untouched boot window
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update() }).catch(error => {
      if (!String(error).includes('Execution context was destroyed')) throw error
    })
    await expect.poll(async () => {
      try { return (await observations()).filter(entry => entry.event === 'document').length }
      catch (error) {
        if (String(error).includes('Execution context was destroyed')) return 0
        throw error
      }
    }).toBe(2)
    await expect(page.locator('.login-state')).toBeVisible()
    const arrivals = (await observations()).filter(entry => entry.event === 'arrival')
    expect(arrivals).toHaveLength(2)
    expect(arrivals[0].elapsed).toBe(0)
    expect(arrivals[1].elapsed, 'the update reload must not replay the 630 ms entrance').toBeGreaterThanOrEqual(0.63)
    const reactArrivals = (await observations()).filter(entry => entry.event === 'react-arrival')
    expect(reactArrivals.length).toBeGreaterThan(0)
    for (const arrival of reactArrivals) expect(arrival.progress, 'React must also continue past the entrance').toBe(1)

    // The resume is one-shot: a later deliberate reload gets a fresh entrance again.
    await page.evaluate(() => sessionStorage.setItem('snail-update-observations', '[]'))
    await page.reload()
    await expect(page.locator('.login-state')).toBeVisible()
    expect((await observations()).filter(entry => entry.event !== 'react-arrival')).toEqual([{ event: 'document' }, { event: 'arrival', elapsed: 0 }])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
