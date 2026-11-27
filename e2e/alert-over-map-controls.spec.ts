import type { APIRequestContext, Page } from '@playwright/test'
import { EINSATZ_RAIL, dismissFirstViewGebaeude, expect, login, openApp, test } from './helpers'

// No map control covers an alert (owner, 26.11.2026: the «Standort» tile lay on the first words
// of «Atemschutz überfällig – Müller Hans / …» and on its «Zum Trupp»). The controls under the top
// bar step BELOW the Meldeleiste while it stands (docs/phone-layout.md › The top bar). Measured on
// the Karte at three phone widths and the iPad both ways, with the tallest strip the field makes:
// an overdue Trupp of four long names plus an Atemschutznotfall.
//   - the strip is on top at every point of its rows (`elementsFromPoint`, not a list of selectors:
//     a control nobody thought of fails it too);
//   - every control of the top edge is still on screen and takes its own tap.
// On the phones the PANELS hung under the bar yield too (owner, 26.11.2026, sign-off block 43): an
// open Messen panel (Höhenprofil + Wassertransport) – with the floating row it lifts (Info ·
// Eintrag) – and the Plan's «in der Nähe» banner start below the strip. The banner needs an
// Einsatzobjekt with plans near the Übung (the Musterdorf demo's Schloss): on a stack without one
// that test skips and says so.
// A tap beside or between the floating row's tiles reaches the map, on the phones and the iPad,
// at rest and lifted over the open Messen panel (UX journeys, follow-up round 26.11.2026: the row's
// box spans the phone's width up to the FAB, and it swallowed every tap there).
//
// On the iPads an armed tool's column stands level with the rail's top, in the strip's band: the
// strip ends left of it and lies on none of its tiles, on the Karte and on the Tafel (owner, Üben
// feedback 27.11.2026: the strip lay on «Freihand»).
//
// It opens an Übung of its own and archives it again afterwards.
// ⚠️ OPT-IN (E2E_WORKFLOWS=1), chromium only: it writes an Einsatz – never against a station in use.

test.skip(!process.env.E2E_WORKFLOWS, 'workflow e2e is opt-in (E2E_WORKFLOWS=1): it opens an Einsatz — run it on a private stack')

const CENTER: [number, number] = [7.570345, 47.523718]
/** ~90 m north of CENTER, at an address of its own: the demo's Schloss is then «merely nearby» */
const NEAR: [number, number] = [7.570345, 47.52452]
const CREW = ['Schönenberger-Vonlanthen Jean-Christophe', 'Müller Hans', 'Meier Anna', 'Brunner Thomas'] as const
/** What stands on the map's top edge: the phone's row under the bar (Standort · GPS caveat · wind)
 *  and the tablet's zoom/compass cluster. Present or not, every one that IS must stay reachable. */
const TOP_CONTROLS = '.tb-share > *, .tb-gps, .phone-wx, [class*="toputil"]'

/** An Übung with the two longest alerts at once: Trupp 1 overdue (no contact for 20 min), its
 *  crew four long names; Trupp 2 in an Atemschutznotfall. */
async function seed(api: APIRequestContext): Promise<string> {
  const created = await api.post('/api/incidents', { data: { title: 'Brand Mehrfamilienhaus', is_exercise: true, lat: CENTER[1], lng: CENTER[0] } })
  expect(created.status(), `creating the Übung: ${await created.text()}`).toBe(201)
  const id = (await created.json() as { id: string }).id
  const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  const trupp = (no: number, name: string, members: string[], extra: Record<string, unknown>) => ({
    id: `ov-tr${no}`, no, order: no, name, members, auftrag: 'loeschen', funkkanal: 11,
    entryPressureBar: 300, entryTime: iso(25), lastContactTime: iso(20), lastPressureBar: 300, lowestBar: 300,
    readings: [{ t: iso(25), bar: 300, kind: 'entry' }], status: 'aktiv', ...extra,
  })
  const [lead, ...rest] = CREW
  const trupps = [
    trupp(1, lead, rest, {}),
    trupp(2, 'Keller Andrea', ['Graf Peter'], { lastContactTime: iso(1), notfallAt: iso(1) }),
  ]
  const cur = await (await api.get(`/api/incidents/${id}/workspace`)).json() as { workspace?: Record<string, unknown>; workspace_rev?: number }
  const put = await api.put(`/api/incidents/${id}/workspace`, { data: { workspace: { ...cur.workspace, trupps }, base_rev: cur.workspace_rev ?? 0 } })
  expect(put.ok(), `seeding the workspace: ${put.status()}`).toBe(true)
  return id
}

/** The controls lying on the strip: every point of its rows, 8px apart (inset past its corners),
 *  must be the strip's own. Named by the control's class, once each. */
async function coveringControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const strip = document.querySelector('.ml')
    if (!strip) return ['no Meldeleiste']
    const r = strip.getBoundingClientRect()
    const bottom = Math.min(r.bottom, innerHeight)
    const hits = new Set<string>()
    for (let y = r.top + 10; y < bottom - 10; y += 8) {
      for (let x = r.left + 10; x < r.right - 10; x += 8) {
        const top = document.elementFromPoint(x, y)
        if (!top || strip.contains(top)) continue
        const ctl = top.closest('button, [role="button"], a') ?? top
        hits.add(`${ctl.tagName.toLowerCase()}.${ctl.getAttribute('class') ?? ''}`)
      }
    }
    return [...hits]
  })
}

/** Every visible top-edge control stands inside the screen and its centre takes the tap itself. */
async function unreachable(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue
      const name = el.getAttribute('class') || el.tagName
      if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) { out.push(`${name} off screen`); continue }
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!top || !el.contains(top)) out.push(`${name} is under ${top?.getAttribute('class') || top?.tagName}`)
    }
    return out
  }, TOP_CONTROLS)
}

/** How far `sel` starts below the strip's foot (px, negative = it reaches up into the strip). */
async function gapUnderStrip(page: Page, sel: string): Promise<number | string> {
  return page.evaluate((s) => {
    const strip = document.querySelector('.ml')
    const el = document.querySelector(s)
    if (!strip || !el) return `missing ${strip ? s : '.ml'}`
    return Math.round(el.getBoundingClientRect().top - strip.getBoundingClientRect().bottom)
  }, sel)
}

/** The floating row's pieces (Info · Eintrag: the tiles of `.wb-botleft`, and the FAB) that reach
 *  up into the strip, each with how far (px). Empty when every one starts below it. */
async function floatRowOnStrip(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const strip = document.querySelector('.ml')
    if (!strip) return ['no Meldeleiste']
    const foot = strip.getBoundingClientRect().bottom
    const out: string[] = []
    for (const el of document.querySelectorAll('.wb-botleft > *, .fab-entry')) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue
      if (r.top < foot) out.push(`${el.getAttribute('aria-label') || el.getAttribute('class')} ${Math.round(r.top - foot)}px`)
    }
    return out
  })
}

/** Where a tap beside or between the floating row's tiles goes (UX journeys, follow-up round
 *  26.11.2026: on a phone the row's box spans the screen up to the FAB, and it swallowed every tap
 *  there). Probes every point of the row's box, 4px apart, that no tile covers: `taken` names what
 *  the ROW took (it must take none – another control standing over its box, like the phone's wind
 *  chip at 320, is that control's tap), `onMap` counts the points that reached the map (its canvas
 *  or a marker on it). */
async function rowGapTaps(page: Page): Promise<{ onMap: number; taken: string[] }> {
  return page.evaluate(() => {
    const row = document.querySelector('.wb-botleft')
    if (!row) return { onMap: 0, taken: ['no floating row'] }
    const r = row.getBoundingClientRect()
    const tiles = [...row.children].map((c) => c.getBoundingClientRect()).filter((t) => t.width && t.height)
    const onTile = (x: number, y: number) => tiles.some((t) => x >= t.left - 1 && x <= t.right + 1 && y >= t.top - 1 && y <= t.bottom + 1)
    let onMap = 0
    const taken = new Set<string>()
    for (let y = r.top + 2; y < r.bottom - 1; y += 4) {
      for (let x = r.left + 2; x < r.right - 1; x += 4) {
        if (onTile(x, y)) continue
        const top = document.elementFromPoint(x, y)
        if (top?.closest('.maplibregl-canvas-container')) onMap++
        else if (top && row.contains(top)) taken.add(`${top.tagName.toLowerCase()}.${top.getAttribute('class') ?? ''}`)
      }
    }
    return { onMap, taken: [...taken] }
  })
}

/** The armed tool's column tiles that something else lies on (the strip, a toast …): a tile's
 *  corners and centre must be the tile's own – or the column's, under the readout tile, which
 *  takes no pointer. Named by the tile and what lies on it, once each. */
async function dockTilesCovered(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const dock = document.querySelector('.wb-dock')
    if (!dock) return ['no tool dock']
    const out: string[] = []
    for (const tile of dock.children) {
      const r = tile.getBoundingClientRect()
      if (!r.width || !r.height) continue
      const points = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4], [r.left + r.width / 2, r.top + r.height / 2], [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4]]
      const top = points.map(([x, y]) => document.elementFromPoint(x, y)).find((el) => !el || !(tile.contains(el) || el === dock))
      if (top !== undefined) out.push(`${tile.getAttribute('aria-label') ?? tile.getAttribute('class')} under ${top?.getAttribute('class') ?? 'nothing'}`)
    }
    return out
  })
}

for (const device of [
  { name: 'phone 320', viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true },
  { name: 'phone 390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: 'phone 430', viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true },
  { name: 'iPad landscape', viewport: { width: 1180, height: 820 }, hasTouch: true },
  { name: 'iPad portrait', viewport: { width: 820, height: 1180 }, hasTouch: true },
] as const) {
  test.describe(`the alert over the map controls (${device.name})`, () => {
    const { name: _name, ...use } = device
    test.use({ ...use, serviceWorkers: 'block' })
    let incidentId = ''

    test.beforeEach(async ({ page, context, browserName }) => {
      test.skip(browserName !== 'chromium', 'runs on chromium only')
      const config = await page.request.get('/api/config')
      test.skip(config.ok() && (await config.json()).identity?.demoMode === true, 'opens Einsätze — never against a shared demo')
      await login(page)
      incidentId = await seed(page.request)
      await context.addCookies([{
        name: 'kp-front-prefs', url: new URL(page.url()).origin,
        // a name confirmed for THIS Einsatz, so «Standort teilen» starts on one tap (lib/useShareMyPosition)
        value: encodeURIComponent(JSON.stringify({
          incidentId, incidentChosenAt: Date.now(),
          sharePosition: { allowed: true, personId: 'ov-p1', displayName: 'Müller Hans', confirmedIncidentId: incidentId },
        })),
      }])
      // the wind chip needs weather, which a private stack may not reach
      await page.route('**/api/weather?*', (route) => route.fulfill({ json: {
        wind_dir_deg: 225, wind_speed_kmh: 11, wind_gust_kmh: 24, temp_c: 7, weather_code: 3, observed_at: new Date().toISOString(), source: 'meteoswiss',
      } }))
      await context.grantPermissions(['geolocation'])
      await context.setGeolocation({ latitude: CENTER[1], longitude: CENTER[0] })
    })

    test.afterEach(async ({ page }) => {
      if (incidentId) await page.request.patch(`/api/incidents/${incidentId}`, { data: { is_archived: true } })
      incidentId = ''
    })

    test(`no control covers the alert, and every control stays reachable (${device.name})`, async ({ page }) => {
      await openApp(page, '/')
      await expect(page.locator(EINSATZ_RAIL)).toBeVisible()
      await dismissFirstViewGebaeude(page)
      // every control the top edge can hold: the Standort tile (sharing on) and the wind
      await page.getByRole('button', { name: /^Ansichten/ }).first().click()
      await page.getByRole('button', { name: /^Standort teilen/ }).click()
      await expect(page.locator('.tb-share > *')).toBeVisible()
      if (device.isMobile) await expect(page.locator('.phone-wx')).toBeVisible()
      const strip = page.locator('.ml')
      await expect(strip.getByText(/^Atemschutz überfällig – Schönenberger/)).toBeVisible()
      await expect(strip.getByText(/Notfall/).first()).toBeAttached()
      // the row under the bar is laid out once the strip's height is published (`--ml-h`)
      await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--ml-h'))).toMatch(/px$/)
      await expect.poll(() => coveringControls(page), 'no map control lies on the alert').toEqual([])
      await expect.poll(() => unreachable(page), 'every top-edge control stays reachable').toEqual([])
    })

    test(`a tap between the floating row's tiles reaches the map (${device.name})`, async ({ page }) => {
      // a Messpunkt on the map, south of the Übung: the row holds two tiles (Gebäude · Messungen),
      // so the tablet's row – as wide as its tiles – has a gap between them too
      const point = { id: 'ov-mp1', kind: 'symbol', layer: 'taktisch', coord: [CENTER[0], CENTER[1] - 0.0006], symbol: 'FW Messpunkt', fields: { CO: '12' } }
      const cur = await (await page.request.get(`/api/incidents/${incidentId}/workspace`)).json() as { workspace: Record<string, unknown> & { entities?: unknown[]; objects?: unknown[] }; workspace_rev: number }
      const ws = cur.workspace
      const put = await page.request.put(`/api/incidents/${incidentId}/workspace`, { data: {
        workspace: { ...ws, entities: [...ws.entities ?? [], point], objects: [...ws.objects ?? [], { id: point.id, entity: point }] }, base_rev: cur.workspace_rev,
      } })
      expect(put.ok(), `adding the Messpunkt: ${put.status()}`).toBe(true)
      await openApp(page, '/')
      await expect(page.locator(EINSATZ_RAIL)).toBeVisible()
      await dismissFirstViewGebaeude(page)
      await expect(page.locator('.wb-botleft > *')).toHaveCount(2)
      const gaps = await rowGapTaps(page)
      expect(gaps.taken, 'the row takes no tap beside its tiles').toEqual([])
      expect(gaps.onMap, 'a tap beside the tiles reaches the map').toBeGreaterThan(0)
    })

    if (!device.isMobile) test(`an armed tool's column stays clear of the alert (${device.name})`, async ({ page }) => {
      await openApp(page, '/')
      await expect(page.locator(EINSATZ_RAIL)).toBeVisible()
      await dismissFirstViewGebaeude(page)
      await expect(page.locator('.ml').getByText(/^Atemschutz überfällig – Schönenberger/)).toBeVisible()
      await page.locator('aside.vrail button[aria-label="Linie"]').click()
      await expect(page.locator('.wb-dock')).toBeVisible()
      await expect.poll(() => dockTilesCovered(page), 'the strip lies on no tile of the column (Karte)').toEqual([])
      // …and on a Plan: the Tafel, which every Einsatz has
      // a DOM click: a pointer click lands in the nav tile's hold handler
      await page.locator(`${EINSATZ_RAIL} .nav-item[aria-label^="Tafel"]`).first().evaluate((b: HTMLElement) => b.click())
      await page.locator('aside.vrail button[aria-label="Linie"]').click()
      await expect(page.locator('.wb-dock')).toBeVisible()
      await expect.poll(() => dockTilesCovered(page), 'the strip lies on no tile of the column (Plan)').toEqual([])
    })

    // the panels: phones only – the tablet docks Messen at the foot and stands the banner right of
    // the rail, nowhere near the strip at the top right
    if (!device.isMobile) return

    test(`an open Messen panel starts under the alert (${device.name})`, async ({ page }) => {
      await openApp(page, '/')
      await expect(page.locator(EINSATZ_RAIL)).toBeVisible()
      await dismissFirstViewGebaeude(page)
      const strip = page.locator('.ml')
      await expect(strip.getByText(/^Atemschutz überfällig – Schönenberger/)).toBeAttached()
      await page.getByRole('button', { name: /^Messen/ }).first().tap()
      await expect(page.locator('.phone-tools .wb-dock')).toBeVisible()
      // a Strecke of two points on one line just under the strip: the free map there runs left of
      // the wind chip, above the floating row (Info · Eintrag) and the Einsatz marker – at 320×640
      // a band of ~25 px
      const panel = page.locator('.phone-tools [data-float-stack]')
      const stripBox = await strip.boundingBox()
      if (!stripBox) throw new Error('the Meldeleiste has no box')
      const y = stripBox.y + stripBox.height + 10
      for (const [i, fx] of [0.2, 0.6].entries()) {
        await page.touchscreen.tap(device.viewport.width * fx, y)
        // each point lands before the next tap – two quick taps are a double tap, which ends it
        await expect(page.locator('.measure-handle')).toHaveCount(i + 1)
      }
      // the row lifted over the short panel: a tap beside its tiles still reaches the map (the row
      // is a frame, not a surface – 09-whiteboard · .wb-botleft)
      await expect(page.locator('.wb-botleft')).toBeVisible()
      const lifted = await rowGapTaps(page)
      expect(lifted.taken, 'the lifted row takes no tap beside its tiles').toEqual([])
      expect(lifted.onMap, 'a tap beside the lifted row\'s tiles reaches the map').toBeGreaterThan(0)
      // open it all the way: the Höhenprofil, then the Wassertransport – it grows to its cap
      await panel.locator('button[aria-expanded="false"]').first().tap()
      await panel.getByRole('button', { name: /Wassertransport berechnen/ }).tap()
      await expect.poll(() => gapUnderStrip(page, '.phone-tools [data-float-stack]'), 'the panel starts under the strip').toBeGreaterThanOrEqual(0)
    // …and the floating row it lifts above it (Info · Eintrag) never reaches up into the strip:
    // where its line would, it yields (lib/floatRow · crossesCeiling)
    await expect(page.locator('.fab-entry')).toBeAttached()
    await expect.poll(() => floatRowOnStrip(page), 'the floating row starts under the strip').toEqual([])
    })

    test(`the Plan's «in der Nähe» banner starts under the alert (${device.name})`, async ({ page }) => {
      // the Übung moves off the object, to an address of its own
      const moved = await page.request.patch(`/api/incidents/${incidentId}`, { data: { address: 'Rittergasse 4, 9999 Musterdorf', lat: NEAR[1], lng: NEAR[0] } })
      expect(moved.ok(), `moving the Übung: ${moved.status()}`).toBe(true)
      const objects = await (await page.request.get(`/api/incidents/${incidentId}/objects`)).json() as { address_match?: boolean | null; plans?: unknown[] }[]
      test.skip(!(objects[0]?.address_match === false && objects[0]?.plans?.length), 'no Einsatzobjekt with plans near the Übung – load the Musterdorf demo objects to run this')
      await openApp(page, '/')
      await expect(page.locator(EINSATZ_RAIL)).toBeVisible()
      await dismissFirstViewGebaeude(page)
      // a DOM click: a pointer click lands in the nav tile's hold handler
      await page.locator(`${EINSATZ_RAIL} .nav-item[aria-label^="Pläne"]`).first().evaluate((b: HTMLElement) => b.click())
      const chooser = page.getByRole('dialog', { name: 'Plan wählen' })
      if (await chooser.isVisible()) await chooser.getByRole('option').first().click()
      await expect(page.locator('.wb-nearby-banner')).toBeVisible()
      await expect.poll(() => gapUnderStrip(page, '.wb-nearby-banner'), 'the banner starts under the strip').toBeGreaterThanOrEqual(0)
    })
  })
}
