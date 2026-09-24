import { request as apiRequest, type APIRequestContext, type Page } from '@playwright/test'
import { test, expect, expectNoClientErrors, login, type ClientErrorReport } from './helpers'

// The field scenario of the Feueralarm-Übung on 23.09.2026 (post-mortem root cause A, process
// follow-up #2): a Leitung coupled to a vehicle that is STANDING STILL and sending GPS, a Trupp
// on the Karte, time passing with the fleet reporting, and then a tap on the Trupp. That shape —
// and only that shape — ran the live-GPS pass into a render loop on every device, and the tap
// threw React #185 and took the Karte down «stürzt wiederholt ab». No test fed vehicle
// positions, so nothing had ever run it before the field did.
//
// Two runs: one device, then three devices on ONE login (the Übung's real shape — one editor
// account on the iPad, the Android and the iPhone, every one of them running the GPS pass, and
// their saves meeting in 409s and merges). The three each place a Trupp at the same moment, and
// every Trupp has to be on every device and on the server afterwards: the edit lost in a
// re-merge (#204) is the bug that would show here.
//
// The vehicle is the backend's fake fleet (`POST /api/traccar/fake`, TRACCAR_FAKE=1 plus the
// ALARM_WEBHOOK_SECRET — CI's Image job sets both through e2e/compose.e2e.yml). It serves the
// same `/api/traccar/positions` the Fahrzeuge layer polls in the field; injected once, a vehicle
// stays exactly where it was put, which is the Übung's TLF parked at the Einsatzort. The spec
// re-reports it every few seconds as a parked Traccar device does (same fix, new timestamp).
//
// ⚠️ chromium only. The loop and #185 live in our React code (lib/useGpsFollow, the store's
// writers, TwinTeamPill's bar placement), not in anything an engine does differently, and the
// three-device run is the expensive half of this suite's runtime. WebKit keeps running the smoke,
// under the same client-error guard (helpers.ts).
//
// It WRITES: it opens its own Übung (an incident with a coordinate, so the Karte frames the
// vehicle), and archives it again at the end. Never against a shared demo (skipped there — the
// demo refuses a new incident anyway) and never against a station in use.

const FLEET_SECRET = process.env.E2E_FLEET_SECRET
const PIN = process.env.E2E_PIN || '000000'
/** the Einsatzort — any real coordinate; the Karte frames it, the vehicle stands ~45 m east */
const SITE = { lat: 47.5137, lng: 7.5559 }
const TLF = { name: 'TLF', lat: SITE.lat, lng: SITE.lng + 0.0006, speed: 0, course: 90 }
/** process follow-up #2: «wait ≥ 20 s with the fleet reporting» — longer than one feed poll (15 s) */
const REPORTING_MS = 22_000
/** lib/useRenderStorm's window (2 s) and a second for the report to leave */
const STORM_SETTLE_MS = 3_000
/** where each device drops its Trupp: below the vehicle and the Leitung, apart from each other */
const TRUPP_SPOTS = [{ dx: -260, dy: 200 }, { dx: -80, dy: 200 }, { dx: 100, dy: 200 }]

test.skip(!FLEET_SECRET && !process.env.CI, 'field scenario needs a fake fleet: TRACCAR_FAKE=1 on the server and E2E_FLEET_SECRET = its ALARM_WEBHOOK_SECRET')

/** A station-side API session of its own (the same login the devices use), for the setup the
 *  scenario needs before any device opens: the Übung itself, and the vehicle feed. */
async function stationApi(baseURL: string): Promise<APIRequestContext> {
  const api = await apiRequest.newContext({ baseURL })
  const roster = await (await api.get('/api/auth/roster')).json()
  expect(roster.length, 'the seeded roster is empty').toBeGreaterThan(0)
  const r = await api.post('/api/auth/login', { data: { user_id: roster[0].id, pin: PIN } })
  expect(r.ok(), `station login: HTTP ${r.status()}`).toBeTruthy()
  return api
}

async function reportFleet(api: APIRequestContext) {
  const r = await api.post('/api/traccar/fake', { headers: { 'X-Webhook-Secret': FLEET_SECRET ?? '' }, data: [TLF] })
  expect(r.ok(), `POST /api/traccar/fake: HTTP ${r.status()} ${await r.text()} — is TRACCAR_FAKE=1 set on the server, and E2E_FLEET_SECRET its ALARM_WEBHOOK_SECRET?`).toBeTruthy()
}

/** Log a device in and land it on THIS Übung's Karte. The Übung is handed over the way the
 *  device itself remembers its last Einsatz (the prefs cookie, lib/prefs), so a stack with other
 *  open incidents cannot put the device somewhere else. */
async function openOnKarte(page: Page, incident: { id: string; title: string }, baseURL: string) {
  await page.context().addCookies([{
    name: 'kp-front-prefs', url: baseURL,
    value: encodeURIComponent(JSON.stringify({ incidentId: incident.id, incidentChosenAt: Date.now() })),
  }])
  await login(page)
  await expect(page.locator('nav.navrail')).toBeVisible()
  await expect(page.locator('.ip-switch-btn'), 'the device opened another Einsatz').toContainText(incident.title)
  await page.getByRole('button', { name: 'Karte', exact: true }).click()
  await expect(page.locator('canvas.maplibregl-canvas').first()).toBeVisible()
}

/** the live vehicle on the Fahrzeuge layer, by its baked-in name */
const vehicleMarker = (page: Page) => page.locator('.maplibregl-marker').filter({ has: page.locator('.marker svg text', { hasText: TLF.name }) })

async function centreOf(page: Page, loc: ReturnType<Page['locator']>) {
  const b = await loc.boundingBox()
  if (!b) throw new Error('marker has no box')
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Draw a Leitung that STARTS on the vehicle: a press on a live vehicle in the line tool couples
 *  the line's start to it at once (MapView · the line-start exception), `guarded` at the spot. */
async function drawCoupledLeitung(page: Page) {
  const v = await centreOf(page, vehicleMarker(page))
  await page.keyboard.press('l')
  await page.mouse.move(v.x, v.y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(v.x - i * 15, v.y + 60 + (i % 2) * 4)
  await page.mouse.up()
  await page.keyboard.press('Escape')
}

/** Place a «Neuer Trupp» with the Trupp tool at `spot` (relative to the vehicle), and let go of it. */
async function placeTrupp(page: Page, spot: { dx: number; dy: number }) {
  const v = await centreOf(page, vehicleMarker(page))
  await page.keyboard.press('t')
  await page.mouse.click(v.x + spot.dx, v.y + spot.dy)
  await page.getByRole('button', { name: 'Neuer Trupp' }).click()
  // placing selects it; the tap later has to be a real one on an unselected marker
  await expect(page.locator('.wb-pill-acts')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.wb-pill-acts')).toHaveCount(0)
}

const truppDots = (page: Page) => page.locator('.maplibregl-marker .team-dot')

/** Tap the Trupp marker nearest `spot` — the one this device placed — where a finger would: on
 *  its dot (the marker's pad takes the press, not the dot itself). */
async function tapTrupp(page: Page, spot: { dx: number; dy: number }) {
  const v = await centreOf(page, vehicleMarker(page))
  const want = { x: v.x + spot.dx, y: v.y + spot.dy }
  let best: { x: number; y: number } | null = null
  for (const d of await truppDots(page).all()) {
    const c = await centreOf(page, d)
    if (!best || Math.hypot(c.x - want.x, c.y - want.y) < Math.hypot(best.x - want.x, best.y - want.y)) best = c
  }
  if (!best) throw new Error('no Trupp marker on the Karte')
  await page.mouse.click(best.x, best.y)
}

async function expectKarteStands(page: Page, where: string) {
  await expect(page.locator('.sb-wrap'), `${where}: the Karte crashed (SurfaceBoundary card)`).toHaveCount(0)
  await expect(page.locator('canvas.maplibregl-canvas').first(), `${where}: the Karte is gone`).toBeVisible()
}

interface ServerView { lines: { gps?: { state: string } }[]; trupps: number }
async function serverView(api: APIRequestContext, incidentId: string): Promise<ServerView> {
  // `workspace` is null until the first save reaches the server
  const ws = (await (await api.get(`/api/incidents/${incidentId}/workspace`)).json()).workspace
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stored workspace, read loosely
  const objects: any[] = ws?.objects ?? []
  return {
    lines: objects.filter((o) => o.drawing?.kind === 'line').map((o) => ({ gps: o.drawing.startAttachment?.gps })),
    trupps: objects.filter((o) => o.entity?.kind === 'team').length,
  }
}

/**
 * The scenario on `devices` (1 or 3 browser contexts, one login): device 1 couples the Leitung,
 * every device places a Trupp at the same moment, the fleet reports for REPORTING_MS, and then
 * every device taps its Trupp.
 */
async function runFieldScenario(devices: Page[], baseURL: string, clientErrors: ClientErrorReport[]) {
  const api = await stationApi(baseURL)
  const title = `E2E Feldszenario ${devices.length}× ${Date.now()}`
  const created = await api.post('/api/incidents', { data: { title, lat: SITE.lat, lng: SITE.lng, is_exercise: true } })
  expect(created.status(), `POST /api/incidents: ${await created.text()}`).toBe(201)
  const incident = { id: (await created.json()).id as string, title }
  try {
    await reportFleet(api)
    // every device polls the feed; count what reaches each one (the pass runs on every answer)
    const polls = devices.map(() => 0)
    devices.forEach((p, i) => p.on('response', (r) => { if (r.url().endsWith('/api/traccar/positions') && r.ok()) polls[i]++ }))

    for (const page of devices) await openOnKarte(page, incident, baseURL)
    for (const page of devices) await expect(vehicleMarker(page), 'the fake TLF never reached the Karte').toBeVisible()

    // 1 · the coupling — a Leitung from the parked TLF, on device 1
    await drawCoupledLeitung(devices[0])
    await expect.poll(async () => (await serverView(api, incident.id)).lines.map((l) => l.gps?.state),
      { message: 'the Leitung never reached the server coupled (startAttachment.gps guarded)' }).toEqual(['guarded'])
    // the storm detector calls a storm at 200 commits inside 2 s (lib/useRenderStorm): give a loop
    // the coupling started that long to be reported, so it fails HERE and not at a later step
    await devices[0].waitForTimeout(STORM_SETTLE_MS)
    expectNoClientErrors(clientErrors, 'after coupling the Leitung')

    // 2 · every device drops a Trupp, all at once — their saves meet on the server
    await Promise.all(devices.map((page, i) => placeTrupp(page, TRUPP_SPOTS[i])))

    // 3 · time passes with the TLF standing and reporting — the loop needed nothing more
    const until = Date.now() + REPORTING_MS
    while (Date.now() < until) {
      await devices[0].waitForTimeout(Math.min(5_000, until - Date.now()))
      await reportFleet(api)
    }
    polls.forEach((n, i) => expect(n, `device ${i + 1} saw fewer than two feed answers — the fleet was not reporting`).toBeGreaterThanOrEqual(2))
    expectNoClientErrors(clientErrors, 'while the fleet reported')

    // 4 · the tap that crashed the Karte on 23.09.2026
    for (const [i, page] of devices.entries()) {
      await tapTrupp(page, TRUPP_SPOTS[i])
      await expect(page.locator('.wb-pill-acts'), `device ${i + 1}: tapping the Trupp opened no card`).toBeVisible()
      await expectKarteStands(page, `device ${i + 1} after tapping the Trupp`)
    }

    // 5 · every device's Trupp survived the merges — on the server and on every device
    await expect.poll(async () => (await serverView(api, incident.id)).trupps,
      { message: 'the server lost a Trupp placed on another device', timeout: 30_000 }).toBe(devices.length)
    for (const [i, page] of devices.entries()) {
      await page.keyboard.press('Escape')
      await expect(truppDots(page), `device ${i + 1} does not show every device's Trupp`).toHaveCount(devices.length, { timeout: 30_000 })
    }
    // …and the coupling is still the operator's: guarded, not paused (the TLF never moved)
    expect((await serverView(api, incident.id)).lines.map((l) => l.gps?.state)).toEqual(['guarded'])
    for (const [i, page] of devices.entries()) await expectKarteStands(page, `device ${i + 1} at the end`)
    expectNoClientErrors(clientErrors, 'at the end of the scenario')
  } finally {
    await api.patch(`/api/incidents/${incident.id}`, { data: { is_archived: true } }).catch(() => undefined)
    await api.delete('/api/traccar/fake', { headers: { 'X-Webhook-Secret': FLEET_SECRET ?? '' } }).catch(() => undefined)
    await api.dispose()
  }
}

test.describe('field scenario · live GPS, a coupled Leitung, a tapped Trupp', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium only — see the note at the top')
    const config = await page.request.get('/api/config')
    test.skip(config.ok() && (await config.json()).identity?.demoMode === true, 'writes an Übung — never against a shared demo')
  })

  test('one device', async ({ page, baseURL, clientErrors }) => {
    test.setTimeout(120_000)
    await runFieldScenario([page], baseURL!, clientErrors)
    await page.screenshot({ path: test.info().outputPath('field-scenario-1-device.png') })
  })

  test('three devices on one login', async ({ page, openDevice, baseURL, clientErrors }) => {
    test.setTimeout(180_000)
    const devices = [page, await openDevice('device 2'), await openDevice('device 3')]
    await runFieldScenario(devices, baseURL!, clientErrors)
    for (const [i, d] of devices.entries()) await d.screenshot({ path: test.info().outputPath(`field-scenario-3-devices-${i + 1}.png`) })
  })
})
