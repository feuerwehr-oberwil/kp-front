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
// camera – on one line. At 320 (an SE 1st gen) too, idle and recording, every option and the clip
// (or the stop control in its place) answers a glove's 44 × 44: measured where a finger lands
// (`elementFromPoint`), so a track's padding does not count for the option inside it (Sol review,
// PR #704 – the options were 39.7px wide idle and 34 while recording).
test('composer one row: I · A · S, ⏱ □ and the clip on one line, each a 44px target at 320', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'touch-phone', 'the letters are the phone layout')
  // a microphone that records at once: the stop control only has to stand in the row
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: class {
      mimeType = 'audio/webm'
      onstop: (() => void) | null = null
      ondataavailable = null
      start() {}
      stop() { this.onstop?.() }
    } })
  })
  await login(page)
  await ensureIncidentOpen(page)
  await page.setViewportSize({ width: 320, height: 400 })
  await page.locator('.fab-entry').tap()
  const row = page.locator('.journal-composer .jc-row')
  await expect(row).toBeVisible()
  /** each control's hit span through its centre (first to last point that lands on it, ¼px
   *  steps) and its box. `count` overwrites the recording's seconds first – the widest readout a
   *  long recording reaches. */
  const targets = (count?: string) => row.evaluate((rowEl, wide) => {
    const time = rowEl.querySelector('.jc-rec-time')
    if (wide && time) time.textContent = wide
    return [...rowEl.querySelectorAll<HTMLElement>('.jc-track .useg-btn, :scope > .jc-rec')].map((el) => {
      const r = el.getBoundingClientRect()
      const span = (from: number, to: number, at: (v: number) => Element | null) => {
        const hits: number[] = []
        for (let v = from; v <= to; v += 0.25) if (el.contains(at(v))) hits.push(v)
        // each sample stands for 0.25px, so the span is last − first + one step (CodeRabbit on #704)
        return hits.length ? hits[hits.length - 1] - hits[0] + 0.25 : 0
      }
      const w = span(r.left - 8, r.right + 8, (x) => document.elementFromPoint(x, r.top + r.height / 2))
      const h = span(r.top - 8, r.bottom + 8, (y) => document.elementFromPoint(r.left + r.width / 2, y))
      return { name: el.getAttribute('aria-label'), w, h, box: r.width, top: Math.round(r.top), right: r.right }
    })
  }, count)
  const expectTargets = async (state: string, count?: string) => {
    const hits = await targets(count)
    expect(hits, state).toHaveLength(6) // I · A · S, ⏱, □, the clip / the stop control
    for (const t of hits) {
      // the span's edges are inclusive (within ½px), so the box holds the width to the px
      expect(Math.min(t.w, t.box), `${state}: ${t.name} wide`).toBeGreaterThanOrEqual(44)
      expect(t.h, `${state}: ${t.name} tall`).toBeGreaterThanOrEqual(44)
      expect(t.right, `${state}: ${t.name} on screen`).toBeLessThanOrEqual(320)
    }
    // one line: the tracks' options sit 3px inside the 44px plate
    for (const t of hits) expect(Math.abs(t.top - hits[0].top), `${state}: ${t.name} on the row`).toBeLessThanOrEqual(3)
  }
  await expectTargets('idle')
  await expect(row.locator('.jc-chip-letter').first()).toHaveText('I')
  await expect(row.locator('.jc-chip-word').first()).toBeHidden()
  await row.getByRole('button', { name: 'Anhang' }).tap()
  for (const word of ['Aufnehmen', 'Datei anhängen', 'Foto']) await expect(page.getByRole('menuitem', { name: word })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Aufnehmen' }).tap()
  await expect(row.getByRole('button', { name: 'Aufnahme stoppen' })).toBeVisible()
  await expectTargets('recording', '120s')
  await row.getByRole('button', { name: 'Aufnahme stoppen' }).tap()
  await expect(row.getByRole('button', { name: 'Anhang' })).toBeVisible()
  // The Lage underneath must keep its canvas in sync as the phone shrinks and expands, even
  // when the first resize coincides with map load. The client-error guard covers both changes.
  const canvas = page.locator('.maplibregl-canvas')
  await expect(canvas).toHaveCSS('height', '400px')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(canvas).toHaveCSS('height', '844px')
  await expectNoCrash(page, 'composer one row')
})

// Offline, a staged Beilage makes «Erfassen» refuse – and on an iPhone with the keyboard up the
// refusal and its «Ohne Datei erfassen» were below the visible part of the scroller, so the save
// seemed to do nothing (Sol review, PR #704). The warning is scrolled into view inside `.jc-body`.
test('composer: an offline refusal shows its warning inside the visible sheet at 390×250', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'touch-phone', 'the short phone sheet')
  await login(page)
  await ensureIncidentOpen(page)
  await page.locator('.fab-entry').tap()
  const sheet = page.locator('.journal-composer')
  await sheet.getByRole('textbox').fill('Eigentümer schickt den Plan')
  await sheet.locator('input[type=file]:not([capture])').setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') })
  await expect(sheet.locator('.jc-file')).toBeVisible()
  // the room an iPhone's keyboard leaves
  await page.setViewportSize({ width: 390, height: 250 })
  // offline as the composer reads it (`navigator.onLine`), without cutting the network the rest
  // of the workspace polls on
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }))
  await sheet.getByRole('button', { name: 'Erfassen' }).tap()
  const skip = sheet.locator('.jc-attach-warn').getByRole('button', { name: 'Ohne Datei erfassen' })
  await expect(skip).toBeVisible()
  await expect.poll(() => sheet.evaluate((card) => {
    const [b, t, a] = ['.jc-body', '.jc-attach-warn .form-warn-text', '.jc-attach-warn .form-warn-act']
      .map((sel) => card.querySelector(sel)?.getBoundingClientRect())
    if (!b || !t || !a) return false
    // the action whole, and the reason beside it on screen too (the line is taller than the room)
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && t.bottom > b.top + 8
  }), 'the warning\'s action whole inside the visible scroller, its reason showing').toBe(true)
  // …its whole 44px TAP area too, not only the 36px face (Sol review round 2): the last pixel row
  // of the hit, just inside its bottom edge, still lands on the button
  await expect.poll(() => skip.evaluate((btn) => {
    const r = btn.getBoundingClientRect()
    const y = r.top + r.height / 2 + 21.5
    return btn.contains(document.elementFromPoint(r.left + r.width / 2, y))
  }), 'the bottom of the 44px hit area is still the button').toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoCrash(page, 'composer offline refusal')
})
