import type { Page } from '@playwright/test'
import { EINSATZ_RAIL, dismissFirstViewGebaeude, expect, login, test } from './helpers'

// «Üben» · the walker: a learner who only ever follows «Zeigen» gets through every step of every
// topic, on a tablet and on a phone layout (owner pick, 20.11.2026: «a UI change then fails CI, not
// the learner»). It reads the topics off the sheet and follows «Weiter» from step to step, so a new
// step or topic in lib/ueben/catalogue is walked without a line here.
//
// How it walks, and nothing else: «Zeigen» → the ring. On a control it taps the ring – or holds it,
// where the ring says so (`data-hold`: a point's pad until its ring is full). On a spot of the map
// it asks for more («Mehr zeigen») and does what the ghost hand does – a tap, a drag along the
// hand's own path, or a drag that rests at its end (`drag-hold`: a Leitung end on a symbol until
// the connect ring is full). It never reads a selector or a coordinate of its own: a hint that
// points at nothing, at the wrong control or along a path that does not finish the step leaves it
// going in circles, and that is the failure.
//
// The practice Einsatz lives on the device (lib/practice): the spec writes NOTHING to the stack, so
// it is not opt-in, and it asserts that no request named the practice id.

const DEVICES = [
  { name: 'tablet', viewport: { width: 1180, height: 820 } },
  // the phone LAYOUT, driven by a mouse: the walker proves the path, not the touch physics
  { name: 'phone', viewport: { width: 390, height: 844 } },
] as const

/** «Zeigen» moves one step of a topic may take */
const MAX_MOVES = 40
/** longer than the app's holds: a point's pad (lib/holdTimings · 825 ms) and the connect ring
 *  (lib/lineAttachments · MAGNET_DWELL_MS, 500 ms) */
const HOLD_MS = 1300

type Point = { x: number; y: number }

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

/** The app menu of wherever the session stands – home's or the Einsatz's – then «Üben». */
async function openSheet(page: Page) {
  await page.locator('[data-karte-menu]:visible, .ip-switch-btn:visible').first().click()
  await button(page, 'Üben').click()
  await expect(page.locator('[data-ueben-topic]').first()).toBeVisible()
}

/** `read()` until two reads 200 ms apart agree: the ring follows a sheet that slides in, the hand a
 *  map that pans. */
async function settled<T>(page: Page, read: () => Promise<T | null>): Promise<T> {
  let last = ''
  for (let i = 0; i < 25; i++) {
    const now = await read()
    const key = JSON.stringify(now)
    if (now !== null && key === last) return now
    last = key
    await page.waitForTimeout(200)
  }
  throw new Error(`«Zeigen» never came to rest: ${last}`)
}

const centre = (b: { x: number; y: number; width: number; height: number }): Point => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) })

/** Follow «Zeigen» from the task card to the step's done card – `done`, or `end` after the topic's
 *  last step. */
async function walk(page: Page, name: string): Promise<'done' | 'end'> {
  const card = page.locator('[data-ueben-card]')
  const ring = page.locator('[data-anchor]')
  const hand = page.locator('[data-gesture]')
  const trail: string[] = []

  for (let move = 0; move < MAX_MOVES; move++) {
    const state = await card.getAttribute('data-ueben-card')
    if (state === 'done' || state === 'end') return state
    // a hand left over from the move before: back to the bottom of the ladder
    if (!(await ring.isVisible()) && (await hand.isVisible())) await button(page, 'Ausblenden').click()
    // the ladder stands at the bottom: «Zeigen». Otherwise the ring is on its way – the camera
    // brings a line out from under a sheet before the ring shows on one of its points
    if (!(await ring.isVisible()) && (await button(page, 'Zeigen').isVisible())) await button(page, 'Zeigen').click()
    await expect(ring, `move ${move + 1} of «${name}»: «Zeigen» shows a ring`).toBeVisible()
    const at = centre(await settled(page, () => ring.boundingBox()))
    const anchor = await ring.getAttribute('data-anchor')
    const hold = (await ring.getAttribute('data-hold')) !== null
    trail.push(`${anchor}${hold ? ' hold' : ''} ${at.x},${at.y}`)
    expect(trail.filter((t) => t === trail[trail.length - 1]).length, `«${name}»: «Zeigen» keeps pointing at the same thing: ${trail.join(' → ')}`).toBeLessThan(4)

    if (anchor === 'control') {
      if (!hold) { await page.mouse.click(at.x, at.y); continue }
      await page.mouse.move(at.x, at.y)
      await page.mouse.down()
      await page.waitForTimeout(HOLD_MS)
      await page.mouse.up()
      continue
    }

    // a spot on the map: «Mehr zeigen» plays the gesture there – do what the hand does
    await button(page, 'Mehr zeigen').click()
    await expect(hand.or(ring).first()).toBeVisible()
    if (!(await hand.isVisible())) { await page.mouse.click(at.x, at.y); continue }
    const path = await settled(page, () => hand.evaluate((el: HTMLElement) => {
      const px = (v: string) => Math.round(parseFloat(el.style.getPropertyValue(v)))
      return { a: { x: px('--hx0'), y: px('--hy0') }, b: { x: px('--hx1'), y: px('--hy1') } }
    }))
    const gesture = await hand.getAttribute('data-gesture')
    if (gesture === 'tap') { await page.mouse.click(path.a.x, path.a.y); continue }
    await page.mouse.move(path.a.x, path.a.y)
    await page.mouse.down()
    for (let i = 1; i <= 16; i++) await page.mouse.move(path.a.x + ((path.b.x - path.a.x) * i) / 16, path.a.y + ((path.b.y - path.a.y) * i) / 16)
    if (gesture === 'drag-hold') await page.waitForTimeout(HOLD_MS)
    await page.mouse.up()
  }
  throw new Error(`«${name}»: «Zeigen» did not finish the step in ${MAX_MOVES} moves: ${trail.join(' → ')}`)
}

for (const device of DEVICES) {
  test.describe(`Üben · ${device.name}`, () => {
    test.use({ viewport: device.viewport, serviceWorkers: 'block' })

    // the device is in the TITLE too: scripts/check-e2e-suites.mjs tells cases apart by file, line and title
    test(`${device.name}: following «Zeigen» finishes every step of every topic, and nothing of it reaches the server`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'runs on chromium only')
      test.setTimeout(420_000)
      const requests: string[] = []
      page.on('request', (r) => requests.push(r.url()))
      await login(page)
      // an Einsatz that stands open on a building shows its Gebäude card by itself: a layer, whose
      // first tap beside it only closes it – it would take the tap on «Üben»
      await page.locator(`${EINSATZ_RAIL}, [data-karte]`).first().waitFor({ state: 'visible' })
      if (await page.locator(EINSATZ_RAIL).isVisible()) await dismissFirstViewGebaeude(page)

      await openSheet(page)
      const topics = await page.locator('[data-ueben-topic]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-ueben-topic') ?? ''))
      expect(topics.length, 'the sheet lists the topics').toBeGreaterThan(0)

      const card = page.locator('[data-ueben-card]')
      let steps = 0
      for (const [i, topic] of topics.entries()) {
        if (i > 0) await openSheet(page)
        await page.locator(`[data-ueben-topic="${topic}"]`).click()
        // the topic's intro card first (what is practised and why), then the first task
        await expect(card).toHaveAttribute('data-ueben-card', 'intro', { timeout: 30_000 })
        await button(page, 'Los').click()
        await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible()
        for (;;) {
          await expect(card).toHaveAttribute('data-ueben-card', /^(task|folded)$/)
          steps++
          if ((await walk(page, `${topic} · step ${steps}`)) === 'end') break
          await button(page, 'Weiter').click()
        }
      }

      const done = await page.evaluate(() => JSON.parse(localStorage.getItem('kp.ueben.done') ?? '[]') as string[])
      expect(done.length, 'every step walked is marked done on this device').toBe(steps)
      const practiceId = await page.evaluate(() => localStorage.getItem('kp.practice.id'))
      expect(practiceId, 'the device has its practice Einsatz').toBeTruthy()
      expect(requests.filter((u) => u.includes(practiceId ?? '-')), 'the practice Einsatz stays on the device').toEqual([])
    })
  })
}
