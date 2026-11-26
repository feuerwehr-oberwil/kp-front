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
//
// It opens an Übung of its own and archives it again afterwards.
// ⚠️ OPT-IN (E2E_WORKFLOWS=1), chromium only: it writes an Einsatz – never against a station in use.

test.skip(!process.env.E2E_WORKFLOWS, 'workflow e2e is opt-in (E2E_WORKFLOWS=1): it opens an Einsatz — run it on a private stack')

const CENTER: [number, number] = [7.570345, 47.523718]
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
  })
}
