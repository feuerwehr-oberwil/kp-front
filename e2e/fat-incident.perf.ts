import { loadavg } from 'node:os'
import { gzipSync } from 'node:zlib'
import type { APIRequestContext, Page } from '@playwright/test'
import { FAT_PRESETS, fatIncident, type FatIncident, type FatPreset } from '../src/lib/fatIncident'
// the guarded `test` (e2e/guard.ts): a client error or a render storm on a fat incident fails the run
import { login, test } from './helpers'

// How a LARGE or LONG Einsatz behaves end to end — a measurement, not a check. It plays a fat
// incident (src/lib/fatIncident) into a real backend the way the crew would have built it up,
// then opens it in a CPU-throttled browser. Prints a report; asserts nothing beyond «it ran».
//
//   just fat-perf large        # throwaway Postgres + built app + this spec, then cleans up
//
// Needs an EMPTY deployment (it opens the incident it creates and expects no other one open).
// The CPU throttle only exists in Chromium, so the project runs there alone.

const PRESET = process.env.FAT_PRESET as FatPreset | undefined
/** how many of the incident's saves are actually sent — the rest are extrapolated (a 24 h Einsatz
 *  makes ~7 000 saves; sending them all would measure the disk, not the app) */
const SAMPLED_SAVES = Number(process.env.FAT_SAVES ?? 120)
/** tablet ≈ 4–6× slower than a dev laptop (Moto/iPad-class field devices) */
const CPU_THROTTLE = Number(process.env.FAT_CPU ?? 4)

test.skip(!PRESET, 'measurement only — run through `just fat-perf <preset>`')
if (PRESET && !(PRESET in FAT_PRESETS)) throw new Error(`FAT_PRESET: unknown preset «${PRESET}» (${Object.keys(FAT_PRESETS).join(', ')})`)
test.describe.configure({ mode: 'serial' })
test.setTimeout(30 * 60_000)

const ms = (n: number) => `${Math.round(n)} ms`
const kb = (n: number) => (n > 4 * 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN }
// eslint-disable-next-line no-console -- the report IS the output
const line = (s: string) => { console.log(s) }

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now()
  const v = await fn()
  return [v, performance.now() - t]
}

async function ok(res: Awaited<ReturnType<APIRequestContext['get']>>, what: string) {
  if (!res.ok() && res.status() !== 304) throw new Error(`${what}: HTTP ${res.status()} ${(await res.text()).slice(0, 300)}`)
  return res
}

let fat: FatIncident
let incidentId: string
/** the blob as the server phase left it — what the browser phase diffs the app's own saves against */
let handover: Record<string, unknown>

test('server: build the incident up, save by save', async ({ page }) => {
  const opts = FAT_PRESETS[PRESET!]
  // ending NOW, so the Atemschutz clocks and open Pendenzen read as a live Einsatz, not one that
  // has been overdue for a week
  fat = fatIncident({ ...opts, start: new Date(Date.now() - opts.hours * 3_600_000).toISOString() })
  await login(page)
  // park the app: left open, it would pick the new incident up and save into it too, and this
  // phase measures ONE device's saves (the browser phase counts what the app writes by itself)
  await page.goto('about:blank')
  const api = page.request
  const created = await (await ok(await api.post('/api/incidents', {
    data: { title: `Fat incident · ${PRESET}`, type: 'Brand', lat: fat.options.center[1], lng: fat.options.center[0], started_at: fat.startedAt },
  }), 'create')).json()
  incidentId = created.id
  const base = `/api/incidents/${incidentId}`

  // A second device follows the incident the way every tablet does (long poll on the revision),
  // and a heartbeat asks the server for the cheapest thing it has: when a save stalls the event
  // loop, both notice.
  let stop = false
  let rev = 0
  const wakes: number[] = []
  const heartbeat: number[] = []
  const statuses: Record<string, number> = {}
  const follower = (async () => {
    let seen = 0
    while (!stop) {
      const res = await api.get(`${base}/workspace?since=${seen}&wait=1`, { timeout: 60_000 }).catch(() => null)
      const st = String(res?.status() ?? 'error')
      statuses[st] = (statuses[st] ?? 0) + 1
      if (res?.status() === 200) { seen = (await res.json()).workspace_rev; wakes.push(performance.now()) }
      // anything but a wake or a quiet 304 must not become a tight loop
      else if (res?.status() !== 304) await new Promise((r) => setTimeout(r, 250))
    }
  })()
  const beat = (async () => {
    while (!stop) {
      const [, t] = await timed(() => api.get('/health'))
      heartbeat.push(t)
      await new Promise((r) => setTimeout(r, 20))
    }
  })()

  const saveWindow = { from: Date.now(), to: 0 }
  const putMs: number[] = []
  const sizes: number[] = []
  /** what one snapshot of each save takes on disk — gzipped as app/audit · _encode_snapshot does */
  const stored: number[] = []
  const journalMs: number[] = []
  const wakeLag: number[] = []
  let journalSent = 0
  let eventsSent = 0
  const clientEvents = fat.events.filter((e) => e.op_type !== 'workspace.save' && e.op_type !== 'incident.create')
  // try/finally: a failed save must still end the two loops above — left running, they outlive
  // the test and keep hammering whatever backend answers on the port next
  try {
    for (let i = 1; i <= SAMPLED_SAVES; i++) {
      const f = i / SAMPLED_SAVES
      const until = new Date(Date.parse(fat.startedAt) + f * (Date.parse(fat.endedAt) - Date.parse(fat.startedAt))).toISOString()
      // the Verlauf and the audit chain grow alongside, in the batches an outbox would send
      const rows = fat.journal.slice(journalSent, fat.journal.findIndex((j) => j.at! > until) >>> 0)
      for (let k = 0; k < rows.length; k += 500) {
        const [, t] = await timed(async () => ok(await api.post(`${base}/journal`, { data: { entries: rows.slice(k, k + 500) } }), 'journal'))
        journalMs.push(t)
      }
      journalSent += rows.length
      const evs = clientEvents.slice(eventsSent, clientEvents.findIndex((e) => e.occurred_at > until) >>> 0)
      for (let k = 0; k < evs.length; k += 500) {
        await ok(await api.post(`${base}/events`, { data: { events: evs.slice(k, k + 500).map((e) => ({ op_type: e.op_type, occurred_at: e.occurred_at, payload: e.payload_json ?? {}, client_id: `fat-${e.seq}` })) } }), 'events')
      }
      eventsSent += evs.length
      const state = fat.stateAt(f)
      const body = JSON.stringify({ workspace: state, base_rev: rev })
      sizes.push(body.length)
      stored.push(gzipSync(JSON.stringify(state), { level: 6 }).length)
      const woke = wakes.length
      const [res, t] = await timed(async () => ok(await api.put(`${base}/workspace?slim=1`, { data: body, headers: { 'content-type': 'application/json' } }), 'save'))
      putMs.push(t)
      rev = (await res.json()).workspace_rev
      const sent = performance.now()
      while (wakes.length === woke && performance.now() - sent < 5_000) await new Promise((r) => setTimeout(r, 5))
      if (wakes.length > woke) wakeLag.push(wakes[wakes.length - 1] - sent)
    }
  } finally {
    stop = true
  }
  saveWindow.to = Date.now()
  await beat

  // the full save count the crew would have made, each one a snapshot of the blob as it stood
  const avg = stored.reduce((a, b) => a + b, 0) / stored.length
  const q = (xs: number[], from: number, to: number) => xs.slice(Math.floor(from * xs.length), Math.ceil(to * xs.length))
  line(`\n── ${PRESET} (×${fat.options.scale}, ${fat.options.hours} h) ─────────────────────────────`)
  // a shared machine skews every number below — a run under load is not comparable to one without
  line(`machine load           ${loadavg().map((x) => x.toFixed(1)).join(' / ')} (1/5/15 min)`)
  line(`blob at the end        ${kb(sizes[sizes.length - 1])}   ·  Verlauf ${fat.journal.length} rows  ·  ${fat.events.length} audit events`)
  line(`saves                  ${fat.saves} in the real incident, ${SAMPLED_SAVES} sent`)
  line(`snapshot storage       ≈ ${kb(avg * fat.saves)} for this incident (one gzipped blob per save — synthetic data compresses worse than real, so this is an upper bound)`)
  line(`save (PUT) p50/p95     first quarter ${ms(pct(q(putMs, 0, 0.25), 50))}/${ms(pct(q(putMs, 0, 0.25), 95))}  ·  last quarter ${ms(pct(q(putMs, 0.75, 1), 50))}/${ms(pct(q(putMs, 0.75, 1), 95))}`)
  line(`follower wake p50/p95  ${ms(pct(wakeLag, 50))}/${ms(pct(wakeLag, 95))}   (save answered → other device has the new blob)`)
  line(`heartbeat p50/p99/max  ${ms(pct(heartbeat, 50))}/${ms(pct(heartbeat, 99))}/${ms(Math.max(...heartbeat))}   (cheapest request while saves run — event-loop stalls)`)
  line(`journal append p95     ${ms(pct(journalMs, 95))}`)
  line(`follower answers       ${JSON.stringify(statuses)}  ·  heartbeats ${heartbeat.length}`)

  // what opening the incident costs a device joining late, and the Replay
  const reads: [string, string][] = [
    ['workspace (open)', `${base}/workspace`],
    ['journal (full)', `${base}/journal?since_seq=0`],
    ['events (Replay)', `${base}/events`],
    // snapshots carry the instant they were SAVED — here, while this test ran
    ['snapshot (scrub)', `${base}/snapshot?at=${encodeURIComponent(new Date((saveWindow.from + saveWindow.to) / 2).toISOString())}`],
  ]
  for (const [what, url] of reads) {
    const t: number[] = []
    let bytes = 0
    for (let k = 0; k < 5; k++) {
      const [res, d] = await timed(async () => ok(await api.get(url), what))
      bytes = (await res.body()).length
      t.push(d)
    }
    line(`read ${what.padEnd(18)} ${ms(pct(t, 50)).padStart(7)}   ${kb(bytes)}`)
  }
  await follower.catch(() => {})

  // The Trupps still in the field have «reported» only while the saves above ran; by the time the
  // browser opens they would all go überfällig at once, and every one of those status changes is
  // a full save of its own. Bring their last contact up to now, as the radio would have.
  const cur = await (await api.get(`${base}/workspace`)).json()
  const now = new Date().toISOString()
  cur.workspace.trupps = cur.workspace.trupps.map((t: { status: string }) => (t.status === 'aktiv' ? { ...t, lastContactTime: now, lastPressureTime: now } : t))
  await ok(await api.put(`${base}/workspace?slim=1`, { data: { workspace: cur.workspace, base_rev: cur.workspace_rev } }), 'contact refresh')
  handover = cur.workspace
})

// ------------------------------------------------------------------------------------------------

/** Collect main-thread long tasks and frame times from the first byte on. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __fat: { long: number[]; frames: number[]; recording: boolean } }
    w.__fat = { long: [], frames: [], recording: false }
    new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__fat.long.push(e.duration) }).observe({ type: 'longtask', buffered: true })
    let last = performance.now()
    const tick = (now: number) => { if (w.__fat.recording) w.__fat.frames.push(now - last); last = now; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
}
const fatState = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __fat: { long: number[]; frames: number[]; recording: boolean } }
  const out = { long: [...w.__fat.long], frames: [...w.__fat.frames] }
  w.__fat.long = []; w.__fat.frames = []
  return out
})
const longSummary = (long: number[]) => `${long.length} long tasks, ${ms(long.reduce((a, b) => a + b, 0))} blocked, worst ${ms(Math.max(0, ...long))}`

test('browser: open it on a throttled tablet', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CPU throttling is a Chromium feature')
  test.skip(!incidentId, 'the server phase did not run')
  await instrument(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })

  // every full-blob PUT the app sends by itself — opening an incident should not have to write it
  const appSaves: number[] = []
  // …and WHAT each one changed, top-level key by key against the blob before it
  let before = handover
  const changed: Record<string, number> = {}
  // (the body itself is a gzip STREAM, which Playwright cannot read — so diff what the server stored)
  let diffs = Promise.resolve()
  page.on('requestfinished', (r) => {
    if (r.method() !== 'PUT' || !/\/workspace(\?|$)/.test(r.url())) return
    appSaves.push(performance.now())
    diffs = diffs.then(async () => {
      const ws = (await (await page.request.get(`/api/incidents/${incidentId}/workspace`)).json()).workspace as Record<string, unknown>
      for (const k of new Set([...Object.keys(before), ...Object.keys(ws)])) {
        if (JSON.stringify(before[k]) !== JSON.stringify(ws[k])) changed[k] = (changed[k] ?? 0) + 1
      }
      before = ws
    })
  })
  const t0 = performance.now()
  await login(page)
  await page.locator('nav.navrail').waitFor({ state: 'visible', timeout: 120_000 })
  const shell = performance.now() - t0
  // «ready» = the Karte has put its symbols up (DOM markers, one per entity)
  const want = fat.workspace.entities.length
  await page.waitForFunction((n) => document.querySelectorAll('.maplibregl-marker').length >= n * 0.8, want, { timeout: 180_000, polling: 250 }).catch(() => {})
  const ready = performance.now() - t0
  const markers = await page.locator('.maplibregl-marker').count()
  const open = await fatState(page)
  line(`\nbrowser (CPU ×${CPU_THROTTLE}) — ${want} Karte objects, ${markers} DOM markers on screen`)
  line(`open → shell           ${ms(shell)}`)
  line(`open → Karte drawn     ${ms(ready)}   ·  ${longSummary(open.long)}`)

  // pan the Karte for two seconds, the way a finger does, and read the frame times
  // grab the map where it is bare: on a full Karte the middle of the screen is a marker, and a
  // drag that starts on one moves the symbol (an edit, and a save) instead of the map
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!
  const bare = await page.evaluate(({ x, y, w, h }) => {
    const canvas = document.querySelector('.maplibregl-canvas')
    for (let r = 0; r < 0.45; r += 0.02) {
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 12) {
        const px = x + w / 2 + Math.cos(a) * r * w
        const py = y + h / 2 + Math.sin(a) * r * h
        if (document.elementFromPoint(px, py) === canvas) return { px, py }
      }
    }
    return null
  }, { x: box.x, y: box.y, w: box.width, h: box.height })
  const cx = bare?.px ?? box.x + box.width / 2
  const cy = bare?.py ?? box.y + box.height / 2
  await page.evaluate(() => { (window as unknown as { __fat: { recording: boolean } }).__fat.recording = true })
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 0; i < 60; i++) { await page.mouse.move(cx + Math.sin(i / 6) * 250, cy + Math.cos(i / 8) * 150); await page.waitForTimeout(16) }
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.evaluate(() => { (window as unknown as { __fat: { recording: boolean } }).__fat.recording = false })
  const pan = await fatState(page)
  line(`pan: frame p50/p95/max ${ms(pct(pan.frames, 50))}/${ms(pct(pan.frames, 95))}/${ms(Math.max(...pan.frames))}  ·  ${longSummary(pan.long)}`)

  // another device saves: how long until this one shows it
  const api = page.request
  const base = `/api/incidents/${incidentId}`
  const label = `Fremdgerät ${Date.now().toString(36)}`
  const note = { id: `remote-${Date.now()}`, kind: 'note', layer: 'markup', coord: fat.options.center, label }
  const savedOnOpen = appSaves.length
  await diffs
  let t1: number
  // the open app may be saving too: on a 409, read again and retry, as a device's outbox would
  for (let attempt = 0; ; attempt++) {
    const cur = await (await api.get(`${base}/workspace`)).json()
    const ws = cur.workspace
    ws.entities = [...ws.entities, note]
    ws.objects = [...(ws.objects ?? []), { id: note.id, entity: note }]
    t1 = performance.now()
    const res = await api.put(`${base}/workspace?slim=1`, { data: { workspace: ws, base_rev: cur.workspace_rev } })
    if (res.status() !== 409 || attempt >= 5) { await ok(res, 'remote save'); break }
  }
  await page.getByText(label).first().waitFor({ state: 'attached', timeout: 60_000 })
  const remote = await fatState(page)
  line(`saves sent by the app  ${savedOnOpen}   (full-blob PUTs while it was only opened and panned)  ·  changed: ${JSON.stringify(changed)}`)
  line(`remote save → visible  ${ms(performance.now() - t1)}   ·  ${longSummary(remote.long)}`)

  // the Verlauf: the whole journal as one list
  await page.screenshot({ path: test.info().outputPath('karte.png') })
  const verlauf = page.getByText('Verlauf', { exact: true })
  if (await verlauf.count()) {
    const t2 = performance.now()
    await verlauf.first().click()
    // the drawer pages its rows (Journal · PAGE_ROWS), so «open» is the head plus the first page
    await page.locator('.journal-drawer .journal-title').waitFor({ state: 'visible', timeout: 60_000 })
    const shown = performance.now() - t2
    await page.waitForTimeout(500)
    const v = await fatState(page)
    line(`open Verlauf           ${ms(shown)}   ·  ${longSummary(v.long)}`)
  }
  line('')
})
