import { request as apiRequest, type APIRequestContext, type Page } from '@playwright/test'
import { test, expect, expectNoClientErrors, login, PIN, type ClientErrorReport } from './helpers'

// The field scenario of the Feueralarm-Übung on 23.09.2026 (post-mortem root cause A, process
// follow-up #2): a Leitung coupled to a vehicle that is STANDING STILL and sending GPS, a Trupp
// on the Karte, time passing with the fleet reporting, and then a tap on the Trupp. That shape —
// and only that shape — ran the live-GPS pass into a render loop on every device, and the tap
// threw React #185 and took the Karte down «stürzt wiederholt ab». No test fed vehicle
// positions, so nothing had ever run it before the field did.
//
// Two runs: one device, then three devices on ONE login (the Übung's real shape — one editor
// account on the iPad, the Android and the iPhone, every one of them running the GPS pass, and
// their saves meeting in 409s and merges). The three place their Trupps concurrently, and every
// Trupp has to be on every device and on the server afterwards: the edit lost in a re-merge
// (#204) is the bug that would show here. A third test pins a known bug by asserting today's
// behaviour: three devices that tap «Neuer Trupp» at the same moment (see the note there).
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
// under the same client-error guard (guard.ts).
//
// ⚠️ No retries here. The loop the scenario exists for was intermittent in the field; a retry
// that passes would file a sometimes-crash as «flaky», and CI stays green.
//
// It WRITES: it opens its own Übung (an incident with a coordinate, so the Karte frames the
// vehicle), and archives it again after the test. Never against a shared demo (skipped there —
// the demo refuses a new incident anyway) and never against a station in use.

const FLEET_SECRET = process.env.E2E_FLEET_SECRET
/** the Einsatzort: the demo incident's neutral centre (src/data/demoIncident.ts, the Swiss
 *  geographic centre). The Karte frames it; the vehicle stands ~46 m east. */
const SITE = { lat: 46.8182, lng: 8.2275 }
const TLF = { name: 'TLF', lat: SITE.lat, lng: SITE.lng + 0.0006, speed: 0, course: 90 }
/** process follow-up #2: «wait ≥ 20 s with the fleet reporting» — longer than one feed poll (15 s) */
const REPORTING_MS = 22_000
/** lib/useRenderStorm's window (2 s) and a second for the report to leave */
const STORM_SETTLE_MS = 3_000
/** how long a save or a feed answer may take to show up — generous: a busy CI runner or dev box */
const SYNC_MS = 30_000
/** where each device drops its Trupp: below the vehicle and the Leitung, apart from each other */
const TRUPP_SPOTS = [{ dx: -260, dy: 200 }, { dx: -80, dy: 200 }, { dx: 100, dy: 200 }]

test.skip(!FLEET_SECRET && !process.env.CI, 'field scenario needs a fake fleet: TRACCAR_FAKE=1 on the server and E2E_FLEET_SECRET = its ALARM_WEBHOOK_SECRET')
test.describe.configure({ retries: 0 })

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
async function openOnKarte(page: Page, incident: Ubung, baseURL: string) {
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

async function centreOf(loc: ReturnType<Page['locator']>) {
  const b = await loc.boundingBox()
  if (!b) throw new Error('no box')
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/**
 * The vehicle's centre once the Karte is FRAMED, not merely still. «Still» also holds for a moment
 * before the first resize/framing lands. Framed means: the TLF stands east of the Einsatzort pin
 * on the same row at about its 46 m (≈170 px at the Karte's opening zoom; a wide band, so another
 * default zoom does not break it), and two reads 300 ms apart agree. `centred` also requires the
 * pin at the canvas centre, which is the opening view. It is asked for only before the first
 * press: once a Linie is drawn, the Karte may pan away from it (measured: 18 px), and the relation
 * pin ↔ TLF is what still holds.
 */
async function framedVehicle(page: Page, { centred = false } = {}) {
  let last = { x: NaN, y: NaN }
  let seen = ''
  const until = Date.now() + SYNC_MS
  while (Date.now() < until) {
    const canvas = await centreOf(page.locator('canvas.maplibregl-canvas').first())
    const pin = await centreOf(page.locator('.maplibregl-marker:has(.map-incident)'))
    const tlf = await centreOf(vehicleMarker(page))
    const dx = tlf.x - pin.x
    const beside = Math.abs(tlf.y - pin.y) <= 3 && dx >= 100 && dx <= 260
    const atCentre = !centred || Math.hypot(pin.x - canvas.x, pin.y - canvas.y) <= 3
    const still = Math.abs(tlf.x - last.x) < 1 && Math.abs(tlf.y - last.y) < 1
    if (beside && atCentre && still) return tlf
    last = tlf
    seen = `pin ${Math.round(pin.x)},${Math.round(pin.y)} · canvas centre ${Math.round(canvas.x)},${Math.round(canvas.y)} · TLF ${Math.round(tlf.x)},${Math.round(tlf.y)}`
    await page.waitForTimeout(300)
  }
  throw new Error(`the Karte never framed the Einsatzort with the TLF beside it (last read: ${seen})`)
}

/** Draw a Leitung that STARTS on the vehicle: a press on a live vehicle in the line tool couples
 *  the line's start to it at once (MapView · the line-start exception), `guarded` at the spot. */
async function drawCoupledLeitung(page: Page) {
  const v = await framedVehicle(page, { centred: true })
  await page.keyboard.press('l')
  await page.mouse.move(v.x, v.y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(v.x - i * 15, v.y + 60 + (i % 2) * 4)
  await page.mouse.up()
  await page.keyboard.press('Escape')
}

/** Open the Trupp tool's «Welcher Trupp?» picker at `spot` (relative to the vehicle). */
async function openTruppPicker(page: Page, spot: { dx: number; dy: number }) {
  const v = await framedVehicle(page)
  await page.keyboard.press('t')
  await page.mouse.click(v.x + spot.dx, v.y + spot.dy)
  await expect(page.getByRole('button', { name: 'Neuer Trupp' })).toBeVisible()
}

/** Place a «Neuer Trupp» at `spot`, and let go of it. */
async function placeTrupp(page: Page, spot: { dx: number; dy: number }) {
  await openTruppPicker(page, spot)
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
  const v = await framedVehicle(page)
  const want = { x: v.x + spot.dx, y: v.y + spot.dy }
  let best: { x: number; y: number } | null = null
  for (const d of await truppDots(page).all()) {
    const c = await centreOf(d)
    if (!best || Math.hypot(c.x - want.x, c.y - want.y) < Math.hypot(best.x - want.x, best.y - want.y)) best = c
  }
  if (!best) throw new Error('no Trupp marker on the Karte')
  await page.mouse.click(best.x, best.y)
}

async function expectKarteStands(page: Page, where: string) {
  await expect(page.locator('.sb-wrap'), `${where}: the Karte crashed (SurfaceBoundary card)`).toHaveCount(0)
  await expect(page.locator('canvas.maplibregl-canvas').first(), `${where}: the Karte is gone`).toBeVisible()
}

interface ServerView { lines: { gps?: { state: string } }[]; trupps: number; truppNames: string[] }
async function serverView(api: APIRequestContext, incidentId: string): Promise<ServerView> {
  // `workspace` is null until the first save reaches the server
  const ws = (await (await api.get(`/api/incidents/${incidentId}/workspace`)).json()).workspace
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stored workspace, read loosely
  const objects: any[] = ws?.objects ?? []
  return {
    lines: objects.filter((o) => o.drawing?.kind === 'line').map((o) => ({ gps: o.drawing.startAttachment?.gps })),
    trupps: objects.filter((o) => o.entity?.kind === 'team').length,
    truppNames: objects.filter((o) => o.entity?.kind === 'team').map((o) => o.entity.label).sort(),
  }
}

interface Ubung { id: string; title: string }
/** the Übungen this test opened — archived in afterEach, once the test's screenshots are taken */
const opened: Ubung[] = []

/** Open an Übung of our own with the TLF parked beside it. */
async function openUbung(api: APIRequestContext, label: string): Promise<Ubung> {
  const title = `E2E Feldszenario ${label} ${Date.now()}`
  const created = await api.post('/api/incidents', { data: { title, lat: SITE.lat, lng: SITE.lng, is_exercise: true } })
  expect(created.status(), `POST /api/incidents: ${await created.text()}`).toBe(201)
  const incident = { id: (await created.json()).id as string, title }
  opened.push(incident)
  await reportFleet(api)
  return incident
}

/**
 * The scenario on `devices` (1 or 3 browser contexts, one login): device 1 couples the Leitung,
 * every device places a Trupp (concurrently), the fleet reports for REPORTING_MS, and then every
 * device taps its Trupp.
 */
async function runFieldScenario(devices: Page[], baseURL: string, clientErrors: ClientErrorReport[]) {
  const api = await stationApi(baseURL)
  try {
    const incident = await openUbung(api, `${devices.length}×`)
    // every device polls the feed; count what reaches each one (the pass runs on every answer)
    const polls = devices.map(() => 0)
    devices.forEach((p, i) => p.on('response', (r) => { if (r.url().endsWith('/api/traccar/positions') && r.ok()) polls[i]++ }))

    for (const page of devices) await openOnKarte(page, incident, baseURL)
    // the first feed answer comes with the Karte's mount; a loaded box took longer than 15 s
    for (const page of devices) await expect(vehicleMarker(page), 'the fake TLF never reached the Karte').toBeVisible({ timeout: SYNC_MS })

    // 1 · the coupling — a Leitung from the parked TLF, on device 1
    await drawCoupledLeitung(devices[0])
    await expect.poll(async () => (await serverView(api, incident.id)).lines.map((l) => l.gps?.state),
      { message: 'the Leitung never reached the server coupled (startAttachment.gps guarded)', timeout: SYNC_MS }).toEqual(['guarded'])
    // the storm detector calls a storm at 200 commits inside 2 s (lib/useRenderStorm): give a loop
    // the coupling started that long to be reported, so it fails HERE and not at a later step
    await devices[0].waitForTimeout(STORM_SETTLE_MS)
    expectNoClientErrors(clientErrors, 'after coupling the Leitung')

    // 2 · every device drops a Trupp, concurrently — their saves meet on the server
    await Promise.all(devices.map((page, i) => placeTrupp(page, TRUPP_SPOTS[i])))

    // 3 · time passes with the TLF standing and reporting — the loop needed nothing more. The
    // feed answers are counted from HERE: at least one per device inside the window (poll 15 s).
    polls.fill(0)
    const until = Date.now() + REPORTING_MS
    while (Date.now() < until) {
      await devices[0].waitForTimeout(Math.min(5_000, until - Date.now()))
      await reportFleet(api)
    }
    // one round is due every 15 s, but a slow round on a loaded runner can push the answer past
    // the window: wait for it rather than call a slow box a silent fleet
    for (const [i] of devices.entries()) {
      await expect.poll(() => polls[i], { message: `device ${i + 1} got no feed answer since the window opened — the fleet was not reporting`, timeout: SYNC_MS }).toBeGreaterThanOrEqual(1)
    }
    expectNoClientErrors(clientErrors, 'while the fleet reported')

    // 4 · the tap that crashed the Karte on 23.09.2026
    for (const [i, page] of devices.entries()) {
      await tapTrupp(page, TRUPP_SPOTS[i])
      await expect(page.locator('.wb-pill-acts'), `device ${i + 1}: tapping the Trupp opened no card`).toBeVisible()
      await expectKarteStands(page, `device ${i + 1} after tapping the Trupp`)
    }
    // the tap is the exact moment the Übung crashed: give a storm it started time to be reported
    await devices[0].waitForTimeout(STORM_SETTLE_MS)
    expectNoClientErrors(clientErrors, 'after tapping the Trupps')

    // 5 · every device's Trupp survived the merges — on the server and on every device
    await expect.poll(async () => (await serverView(api, incident.id)).trupps,
      { message: 'the server lost a Trupp placed on another device', timeout: SYNC_MS }).toBe(devices.length)
    for (const [i, page] of devices.entries()) {
      await page.keyboard.press('Escape')
      await expect(truppDots(page), `device ${i + 1} does not show every device's Trupp`).toHaveCount(devices.length, { timeout: SYNC_MS })
    }
    // …and the coupling is still the operator's: guarded, not paused (the TLF never moved)
    expect((await serverView(api, incident.id)).lines.map((l) => l.gps?.state)).toEqual(['guarded'])
    for (const [i, page] of devices.entries()) await expectKarteStands(page, `device ${i + 1} at the end`)
    expectNoClientErrors(clientErrors, 'at the end of the scenario')
  } finally {
    await api.dispose()
  }
}

test.describe('field scenario · live GPS, a coupled Leitung, a tapped Trupp', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium only — see the note at the top')
    const config = await page.request.get('/api/config')
    test.skip(config.ok() && (await config.json()).identity?.demoMode === true, 'writes an Übung — never against a shared demo')
  })

  // After the test (its screenshots are taken by then): archive what it opened and park no fleet.
  // A refused archive is a soft failure, so it is never silent.
  test.afterEach(async ({ baseURL }) => {
    if (!opened.length) return
    const api = await stationApi(baseURL!)
    try {
      for (const incident of opened.splice(0)) {
        const r = await api.patch(`/api/incidents/${incident.id}`, { data: { is_archived: true } })
        expect.soft(r.ok(), `archiving the Übung «${incident.title}»: HTTP ${r.status()}`).toBeTruthy()
      }
      await api.delete('/api/traccar/fake', { headers: { 'X-Webhook-Secret': FLEET_SECRET ?? '' } })
    } finally {
      await api.dispose()
    }
  })

  test('one device', async ({ page, baseURL, clientErrors }) => {
    test.setTimeout(180_000)
    await runFieldScenario([page], baseURL!, clientErrors)
    await page.screenshot({ path: test.info().outputPath('field-scenario-1-device.png') })
  })

  test('three devices on one login', async ({ page, openDevice, baseURL, clientErrors }) => {
    test.setTimeout(300_000)
    const devices = [page, await openDevice('device 2'), await openDevice('device 3')]
    await runFieldScenario(devices, baseURL!, clientErrors)
    for (const [i, d] of devices.entries()) await d.screenshot({ path: test.info().outputPath(`field-scenario-3-devices-${i + 1}.png`) })
  })

  // ⚠️ KNOWN BUG, pinned by asserting TODAY's behaviour (24.09.2026). Three devices that tap «Neuer
  // Trupp» at the same moment all name it «Trupp 1»: each draws the next number from ITS OWN view
  // of the Einsatz before the others' saves arrive (lib/placedTrupps · nextTeamName), and the
  // merge keeps all three. docs/trupp-naming.md §1 says two things on one Einsatz are never both
  // «Trupp 1»; its «Out of scope» accepts the same race only for devices that are OFFLINE. The
  // assertion below fails the day the numbering is fixed — then flip it to `.toBe(3)`. A crash is
  // never mistaken for the bug: the guard and the check before it stay red on their own.
  test('three devices tapping «Neuer Trupp» at the same moment (known bug: same number)', async ({ page, openDevice, baseURL, clientErrors }) => {
    test.setTimeout(180_000)
    const devices = [page, await openDevice('device 2'), await openDevice('device 3')]
    const api = await stationApi(baseURL!)
    try {
      const incident = await openUbung(api, 'Namen')
      for (const d of devices) await openOnKarte(d, incident, baseURL!)
      for (const d of devices) await expect(vehicleMarker(d), 'the fake TLF never reached the Karte').toBeVisible({ timeout: SYNC_MS })
      // every device up to the «Welcher Trupp?» picker first, then all three taps at once
      await Promise.all(devices.map((d, i) => openTruppPicker(d, TRUPP_SPOTS[i])))
      await Promise.all(devices.map((d) => d.getByRole('button', { name: 'Neuer Trupp' }).click()))
      await expect.poll(async () => (await serverView(api, incident.id)).trupps, { timeout: SYNC_MS }).toBe(devices.length)
      await page.waitForTimeout(STORM_SETTLE_MS) // lib/useRenderStorm needs its 2 s window
      expectNoClientErrors(clientErrors, 'placing three Trupps at once')
      const names = (await serverView(api, incident.id)).truppNames
      expect(new Set(names).size,
        `KNOWN BUG — when this fails the numbering was fixed: change to toBe(3). Names now: ${names.join(', ')}`).toBeLessThan(3)
    } finally {
      await api.dispose()
    }
  })
})
