import { request as apiRequest, type APIRequestContext, type Page } from '@playwright/test'
import { test, expect, login } from './helpers'
import { buildingAlreadyRead, remember, retire, seedIncident, signIn, type Seeded } from './perf/harness'

// The live follow after a save (18.10.2026, found building #394): every save woke the SAVING
// device's own long poll (`GET …/workspace?since=&wait=1`), which then downloaded the whole blob
// this device had just sent (~38 KB gzipped on the busiest Einsatz on record) and threw it away —
// on every edit, on every surface. The poll now says which device is asking (`writer=`), the saves
// say which device wrote (`X-Workspace-Writer`), and a revision range that holds only this
// device's own saves is answered 304 + `X-Workspace-Rev` (api/incidents · get_workspace).
//
// The same loop carries every OTHER device's change — a Funkkontakt, an Atemschutznotfall — so
// this spec holds both halves on the real stack: the saving device downloads nothing of its own,
// and a second device on the SAME login (the field's shape: one account on three tablets) still
// gets every change of the other one, also when the two save at the same moment.
//
// ⚠️ OPT-IN (E2E_WORKFLOWS=1), chromium only: it seeds and writes an Einsatz of its own (archived
// again afterwards). Never against a shared demo or a station in use.

test.skip(!process.env.E2E_WORKFLOWS, 'live-follow e2e is opt-in (E2E_WORKFLOWS=1): it writes an Einsatz — run it on a private stack')
test.describe.configure({ retries: 0 })
test.setTimeout(3 * 60_000)

/** how long another device's change may take to show — the long poll answers within the commit;
 *  this bound only has to cover a save debounce (600 ms), a 409 merge and a loaded box */
const PROMPT_MS = 5_000

let seeded: Seeded
let station: APIRequestContext

test.beforeEach(async ({ baseURL, browserName }) => {
  test.skip(browserName !== 'chromium', 'live-follow e2e runs on chromium only')
  station = await apiRequest.newContext({ baseURL })
  const config = await station.get('/api/config')
  test.skip(config.ok() && (await config.json()).identity?.demoMode === true, 'writes an Einsatz — never against a shared demo')
  await signIn(station)
  seeded = await seedIncident(station, `Live-Follow · ${Date.now().toString(36)}`)
})

test.afterEach(async () => {
  if (seeded) await retire(station, seeded.id)
  await station?.dispose()
})

/** what came back on the workspace's live follow: every `?since=` read, with its status and the
 *  size of the body it carried. (`response`, not `requestfinished`: Chromium never reports the
 *  transfer sizes of a bodyless 304, and waiting for them dropped every 304 from the count.) */
function watchFollow(page: Page, incidentId: string) {
  const seen: { status: number; bytes: number; own: boolean; at: number }[] = []
  page.on('response', async (res) => {
    const url = new URL(res.url())
    if (res.request().method() !== 'GET' || url.pathname !== `/api/incidents/${incidentId}/workspace` || !url.searchParams.has('since')) return
    const at = Date.now()
    const bytes = res.status() === 200 ? (await res.body().catch(() => Buffer.alloc(0))).length : 0
    seen.push({ status: res.status(), bytes, own: res.headers()['x-workspace-rev'] !== undefined, at })
  })
  return { since: (from: number) => seen.filter((x) => x.at >= from) }
}

async function openOnTrupps(page: Page, baseURL: string) {
  await remember(page.context(), baseURL, seeded.id)
  await buildingAlreadyRead(page.context(), seeded)
  await login(page)
  await expect(page.locator('.ip-switch-btn'), 'the device opened another Einsatz').toContainText(seeded.title)
  await page.locator('nav.navrail').getByRole('button', { name: 'Trupps', exact: true }).click()
  await expect(page.locator('.app')).toHaveClass(/\bmode-atemschutz\b/)
}

const kontakt = (page: Page) => page.getByRole('button', { name: 'Kontakt', exact: true })
/** a Trupp's card: the innermost element holding its name and a «Kontakt» */
const card = (page: Page, name: string) =>
  page.locator('div').filter({ has: page.getByText(name, { exact: true }) }).filter({ has: kontakt(page) }).last()
/** the card's contact clock started again from 0:00 — the Kontakt is on this device's screen */
const contactFresh = (page: Page, name: string) => card(page, name).getByText(/^0:0\d$/).first()

/** the server's copy, read by the station session (nothing a device holds) */
async function serverTrupps(): Promise<{ id: string; name: string; lastContactTime?: string; notfallAt?: string }[]> {
  const res = await station.get(`/api/incidents/${seeded.id}/workspace`)
  return (await res.json()).workspace.trupps
}

test('a device downloads nothing of its own saves on the live follow', async ({ page, baseURL }) => {
  await openOnTrupps(page, baseURL!)
  const follow = watchFollow(page, seeded.id)
  await page.waitForTimeout(2_000) // the opening's own traffic
  const from = Date.now()
  const saves: string[] = []
  page.on('requestfinished', (req) => { if (req.method() === 'PUT' && /\/workspace(\/trupps)?$/.test(new URL(req.url()).pathname)) saves.push(req.url()) })
  for (const name of seeded.trupps) {
    await card(page, name).getByRole('button', { name: 'Kontakt', exact: true }).click()
    await expect(contactFresh(page, name)).toBeVisible()
    await page.waitForTimeout(2_500) // the radio exchange with the next Trupp: every Kontakt is its own save
  }
  await page.waitForTimeout(3_000)
  expect(saves.length, 'no Kontakt reached the server').toBeGreaterThanOrEqual(seeded.trupps.length)
  const pulls = follow.since(from).filter((x) => x.status === 200)
  expect(pulls.map((x) => `200 · ${x.bytes} B`), 'the live follow downloaded this device\'s own saves').toEqual([])
  // …and it still follows: every save woke the parked poll, which was told «only your own saves»
  // (304 + X-Workspace-Rev) and parked again at the new revision
  const own = follow.since(from).filter((x) => x.status === 304 && x.own)
  expect(own.length, 'the parked poll was not answered «own saves» after each save').toBeGreaterThanOrEqual(seeded.trupps.length)
})

test('two devices on one login: each gets the other\'s Kontakt and Notfall promptly, also saving at the same moment', async ({ page, openDevice, baseURL }) => {
  const a = page
  const b = await openDevice('device B')
  await openOnTrupps(a, baseURL!)
  await openOnTrupps(b, baseURL!)
  const followA = watchFollow(a, seeded.id)
  await a.waitForTimeout(2_000)
  const [t1, t2, t3] = seeded.trupps

  // 1 · B's Kontakt reaches A, with A idle and parked
  let at = Date.now()
  await card(b, t1).getByRole('button', { name: 'Kontakt', exact: true }).click()
  await expect(contactFresh(a, t1), 'A never showed B\'s Kontakt').toBeVisible({ timeout: PROMPT_MS })
  test.info().annotations.push({ type: 'timing', description: `[live-follow] B's Kontakt on A after ${Date.now() - at} ms` })
  expect(followA.since(at).some((x) => x.status === 200 && x.bytes > 0), 'A got B\'s Kontakt, but not through its live follow').toBe(true)
  await a.waitForTimeout(3_000) // let A's and B's clocks run past 0:09, so the next «fresh» is a new one

  // 2 · the race: A and B tap at the same moment, on different Trupps — both saves land (one of
  //     them through a 409 merge) and both devices show both
  at = Date.now()
  await Promise.all([
    card(a, t2).getByRole('button', { name: 'Kontakt', exact: true }).click(),
    card(b, t3).getByRole('button', { name: 'Kontakt', exact: true }).click(),
  ])
  await expect(contactFresh(a, t3), 'A lost B\'s Kontakt made at the same moment as its own').toBeVisible({ timeout: PROMPT_MS })
  await expect(contactFresh(b, t2), 'B lost A\'s Kontakt made at the same moment as its own').toBeVisible({ timeout: PROMPT_MS })
  test.info().annotations.push({ type: 'timing', description: `[live-follow] simultaneous Kontakte on both devices after ${Date.now() - at} ms` })
  await expect.poll(async () => {
    const tr = await serverTrupps()
    return [t2, t3].every((n) => Date.parse(tr.find((t) => t.name === n)?.lastContactTime ?? '') >= at - 1_000)
  }, { message: 'the server lost one of the two simultaneous Kontakte', timeout: PROMPT_MS }).toBe(true)

  // 3 · an Atemschutznotfall raised elsewhere (the Atemschutz-Link's route) the moment after A's own
  //     save landed — the change that comes in between A's save and its poll's re-arm
  await a.waitForTimeout(3_000)
  const ownSave = a.waitForResponse((r) => r.request().method() === 'PUT' && /\/workspace(\/trupps)?$/.test(new URL(r.url()).pathname) && r.ok(), { timeout: 15_000 })
  // t2: A's own last Kontakt (a Trupp another device confirmed seconds ago asks «Kontakt schon
  // bestätigt» first — which is the dedupe working on the Kontakt A got from B)
  await card(a, t2).getByRole('button', { name: 'Kontakt', exact: true }).click()
  const saved = await (await ownSave).json()
  at = Date.now()
  const before = await (await station.get(`/api/incidents/${seeded.id}/workspace`)).json()
  const raised = before.workspace.trupps.map((t: { name: string }) => (t.name === t3 ? { ...t, notfallAt: new Date().toISOString() } : t))
  const put = await station.put(`/api/incidents/${seeded.id}/workspace/trupps`, { data: { trupps: raised, base_rev: before.workspace_rev } })
  expect(put.ok(), `Notfall PUT: HTTP ${put.status()} ${await put.text()}`).toBeTruthy()
  expect(before.workspace_rev, 'the Notfall was not the next revision after A\'s own save').toBe(saved.workspace_rev)
  for (const device of [a, b]) {
    await expect(card(device, t3).getByText(/^Notfall seit /).first(), 'a device never showed the Notfall raised elsewhere').toBeVisible({ timeout: PROMPT_MS })
  }
  test.info().annotations.push({ type: 'timing', description: `[live-follow] Notfall on both devices after ${Date.now() - at} ms` })
})
