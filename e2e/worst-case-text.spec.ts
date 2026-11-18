import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { EINSATZ_RAIL, dismissFirstViewGebaeude, expect, login, openApp, test } from './helpers'

// Worst-case text never runs out of its box (design pass D, 18.11.2026). The other overflow checks
// look at the page's `scrollWidth` with demo names, so a name clipped INSIDE an `overflow: hidden`
// card – «Schönenberger-Vo…» under the clock, a ▸ cut off its chip, a title under the ✕ – passed
// them all. This seeds the longest REALISTIC strings through the API, the same boundary real data
// comes through, and checks at ELEMENT level on a phone (390) and the tablet (1180):
//   - the Trupp card: a crew name wider than its column wraps inside the card and never under the
//     clock; the «bei ‹Host›» chip and the Auftrag · Ziel chip stay in the card, the ▸ in its chip;
//   - the Anwesenheit: «Nachname Vorname» takes two lines before its «…» (one line cut the first name);
//   - the Einsatz menu: a 100-char ALL-CAPS title takes two lines, its Übung tag stays in the row;
//   - the context panel: «Angehörigensammelstelle» wraps at its seams, never under the ✕.
// Not covered here: the Checkliste runner head (its long title needs a station template) and the
// Rapport's fr/it key column (a locale switch) – both stay with the unit and visual checks.
//
// It opens an Übung of its own and archives it again afterwards. Red on db6e7c4d (before the
// design pass) for the crew line, the docked chip, the Anwesenheit and the launcher.
//
// ⚠️ OPT-IN (E2E_WORKFLOWS=1), chromium only: it writes an Einsatz – never against a station in use.

test.skip(!process.env.E2E_WORKFLOWS, 'workflow e2e is opt-in (E2E_WORKFLOWS=1): it opens an Einsatz — run it on a private stack')

/** The longest values that turn up in the field: Divera's ALL-CAPS Stichwort lines, double names,
 *  a Hydrant described by where it stands. Each is plausible, none is random filler. */
const WORST = {
  title: 'BRAND MEHRFAMILIENHAUS PERSONEN IN NOTLAGE RAUCHENTWICKLUNG TREPPENHAUS DACHGESCHOSS HINTERHAUS 3OG',
  leader: 'Schönenberger-Vonlanthen Jean-Christophe',
  crew: ['Wiśniewska-Kowalczyk Aleksandra', 'Bartholomew-Fitzgerald Maximilian'],
  host: 'Hydrant Hauptstrasse gegenüber Gemeindeverwaltung Oberdorf',
  ziel: 'Dachgeschoss Westflügel, Wohnung 4.12 hinter der Brandschutztür',
  people: ['Schönenberger-Vonlanthen Jean-Christophe', 'Schönenberger-Vonlanthen Anna-Barbara'],
} as const
const CENTER: [number, number] = [7.570345, 47.523718]
/** the chips' `title`s: seed data in copy · atemschutz `dockedAt` («bei «{host}»») and the
 *  Auftrag · Ziel line – what the copy guard (e2eSelectors.test) cannot read as one literal */
const DOCKED_TITLE = `bei «${WORST.host}»`
const AUFTRAG_TITLE = `Löschen · ${WORST.ziel}`

/** An Übung carrying every worst case at once: one Trupp inside with the long crew, Ziel and a
 *  marker docked to an Angehörigensammelstelle named like a real Hydrant spot, two present people
 *  who differ only in their first names. */
async function seed(api: APIRequestContext): Promise<string> {
  const created = await api.post('/api/incidents', { data: { title: WORST.title, is_exercise: true, lat: CENTER[1], lng: CENTER[0] } })
  expect(created.status(), `creating the Übung: ${await created.text()}`).toBe(201)
  const id = (await created.json() as { id: string }).id
  const now = Date.now()
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()
  const host = { id: 'wc-host', kind: 'symbol', layer: 'taktisch', coord: CENTER, symbol: 'ZS Angehoerigensammelstelle', label: WORST.host }
  const team = { id: 'wc-team', kind: 'team', layer: 'taktisch', coord: CENTER, label: WORST.leader, truppId: 'wc-tr', dockedTo: host.id }
  const trupp = {
    id: 'wc-tr', no: 1, order: 1, name: WORST.leader, members: [...WORST.crew], auftrag: 'loeschen', ziel: WORST.ziel, funkkanal: 11,
    entryPressureBar: 300, entryTime: iso(8), lastContactTime: iso(1), lastPressureBar: 270, lastPressureTime: iso(1), lowestBar: 270,
    readings: [{ t: iso(8), bar: 300, kind: 'entry' }, { t: iso(1), bar: 270, kind: 'pressure' }], status: 'aktiv', entityId: team.id,
  }
  const attendance = Object.fromEntries(WORST.people.map((name, i) => [`wc-p${i}`, {
    status: 'present', checkedInAt: iso(20), displayNameSnapshot: name, intervals: [{ from: iso(20) }],
  }]))
  const cur = await (await api.get(`/api/incidents/${id}/workspace`)).json() as { workspace?: Record<string, unknown>; workspace_rev?: number }
  const entities = [host, team]
  const workspace = { ...cur.workspace, entities, objects: entities.map((entity) => ({ id: entity.id, entity })), trupps: [trupp], attendance }
  const put = await api.put(`/api/incidents/${id}/workspace`, { data: { workspace, base_rev: cur.workspace_rev ?? 0 } })
  expect(put.ok(), `seeding the workspace: ${put.status()}`).toBe(true)
  return id
}

type Box = { x: number; y: number; width: number; height: number }
const inside = (inner: Box, outer: Box) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1
  && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1

async function boxOf(el: Locator, what: string): Promise<Box> {
  const box = await el.boundingBox()
  if (!box) throw new Error(`${what} is not on screen`)
  return box
}

/** Every box of `parts` stands inside `container` – its text clipped by nothing. */
async function expectInside(parts: Locator, container: Locator, what: string) {
  const outer = await boxOf(container, what)
  const n = await parts.count()
  expect(n, `${what}: something to check`).toBeGreaterThan(0)
  for (let i = 0; i < n; i++) {
    const box = await boxOf(parts.nth(i), `${what} ${i + 1}`)
    expect(inside(box, outer), `${what} ${i + 1} stands inside its box: ${JSON.stringify(box)} in ${JSON.stringify(outer)}`).toBe(true)
  }
}

/** The element shows ALL of its text: nothing scrolled out sideways, nor below its last line. */
async function expectWhole(el: Locator, what: string) {
  const m = await el.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }))
  expect(m.sw, `${what}: no text past its right edge`).toBeLessThanOrEqual(m.cw + 1)
  expect(m.sh, `${what}: no line cut off below`).toBeLessThanOrEqual(m.ch + 1)
}

/** Open the Einsatz the cookie names, and put its first-view Gebäude card away. */
async function openEinsatz(page: Page) {
  await openApp(page, '/')
  await expect(page.locator(EINSATZ_RAIL)).toBeVisible()
  await dismissFirstViewGebaeude(page)
}

/** A clamped name uses BOTH of its lines before its «…» and never runs out sideways – the one-line
 *  ellipsis kept «Schönenberger-Vonl…» and cut the first name, which tells two of them apart. */
async function expectTwoLines(el: Locator, what: string) {
  const m = await el.evaluate((e) => {
    const cs = getComputedStyle(e)
    return { sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, lh: parseFloat(cs.lineHeight) || 1.2 * parseFloat(cs.fontSize) }
  })
  expect(m.sw, `${what}: no text past its right edge`).toBeLessThanOrEqual(m.cw + 1)
  if (m.sh > m.ch + 1) expect(m.ch, `${what}: two lines before the «…»`).toBeGreaterThanOrEqual(1.8 * m.lh)
}

/** Pick a surface on the rail. On a phone the Anwesenheit sits behind the «Rapport» tile, the
 *  group's door: a second tap on it offers the group's pages (as touch.spec does). */
async function go(page: Page, name: string) {
  const rail = page.locator(EINSATZ_RAIL)
  const direct = rail.getByRole('button', { name, exact: true })
  if (await direct.isVisible()) return direct.click()
  const group = rail.getByRole('button', { name: /^Rapport(?: ·|$)/ })
  await group.click()
  const heading = page.getByRole('heading', { name, exact: true })
  if (await heading.waitFor({ timeout: 3000 }).then(() => true, () => false)) return
  await group.click()
  await page.getByRole('dialog').getByRole('option', { name: new RegExp(`^${name}`) }).click()
  await expect(heading).toBeVisible()
}

for (const device of [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'tablet', viewport: { width: 1180, height: 820 }, hasTouch: true },
] as const) {
  test.describe(`worst-case text on the ${device.name}`, () => {
    const { name: _name, ...use } = device
    test.use({ ...use, serviceWorkers: 'block' })
    let incidentId = ''

    test.beforeEach(async ({ page, context, browserName }) => {
      test.skip(browserName !== 'chromium', 'runs on chromium only')
      const config = await page.request.get('/api/config')
      test.skip(config.ok() && (await config.json()).identity?.demoMode === true, 'opens Einsätze — never against a shared demo')
      await login(page)
      incidentId = await seed(page.request)
      // remembered as the Einsatz picked by hand (lib/prefs), so the open lands in it
      await context.addCookies([{
        name: 'kp-front-prefs', url: new URL(page.url()).origin,
        value: encodeURIComponent(JSON.stringify({ incidentId, incidentChosenAt: Date.now() })),
      }])
    })

    test.afterEach(async ({ page }) => {
      if (incidentId) await page.request.patch(`/api/incidents/${incidentId}`, { data: { is_archived: true } })
      incidentId = ''
    })

    test(`the Trupp card keeps a long crew, host and Ziel inside it (${device.name})`, async ({ page }) => {
      await openEinsatz(page)
      await go(page, 'Trupps')
      const card = page.locator('[class*="trowCard"]').filter({ hasText: WORST.crew[0] })
      // the phone's closed row shows no crew: open it by its name
      if (!await card.isVisible()) await page.getByText(WORST.leader, { exact: true }).filter({ visible: true }).first().click()
      await expect(card).toBeVisible()
      await expectInside(card.locator('[class*="crewName"]'), card, 'a crew name')
      const clock = card.locator('[class*="trowClockVal"]').first()
      if (await clock.isVisible()) {
        const c = await boxOf(clock, 'the clock')
        for (const n of await card.locator('[class*="crewName"]').all()) {
          expect(overlaps(await boxOf(n, 'a crew name'), c), 'a crew name never runs under the clock').toBe(false)
        }
      }
      const docked = card.getByTitle(DOCKED_TITLE)
      await expectInside(docked, card, 'the «bei ‹Host›» chip')
      await expectInside(docked.locator(':scope > svg'), docked, 'the ▸ of the «bei ‹Host›» chip')
      await expectInside(card.getByTitle(AUFTRAG_TITLE), card, 'the Auftrag · Ziel chip')
    })

    test(`the Anwesenheit gives «Nachname Vorname» two lines (${device.name})`, async ({ page }) => {
      await openEinsatz(page)
      await go(page, 'Anwesenheit')
      for (const who of WORST.people) {
        const name = page.locator('[class*="name"]').getByText(who, { exact: true }).filter({ visible: true }).first()
        await expect(name).toBeVisible()
        await expectTwoLines(name, who)
      }
    })

    test(`the Einsatz menu gives a long title two lines and keeps the Übung tag (${device.name})`, async ({ page }) => {
      // by its route: the Karte home, whose menu lists the open Einsätze (AppMenuRows)
      await openApp(page, '/karte')
      await page.locator('[data-karte-menu]').click()
      const row = page.locator('.ip-menu-row').filter({ hasText: WORST.title }).first()
      await expect(row).toBeVisible()
      const title = row.locator('.ip-menu-title')
      await expectTwoLines(title, 'the Einsatz title')
      await expectInside(row.locator('.ip-badge'), row, 'the Übung tag')
    })

    test(`the context panel breaks a long compound before the ✕ (${device.name})`, async ({ page }) => {
      await openEinsatz(page)
      await go(page, 'Karte')
      // the host's glyph: the top-centre of its marker (its caption hangs under it)
      const marker = await boxOf(page.locator('.maplibregl-marker > .marker').filter({ hasText: 'Gemeindeverwaltung' }).first(), 'the host marker')
      const head = page.locator('.ctx-head').filter({ hasText: /Angehörigen/ })
      await page.mouse.click(marker.x + marker.width / 2, marker.y + 18)
      // a first-view Gebäude card that opened late is a layer: it takes the first tap
      if (!await head.waitFor({ timeout: 2500 }).then(() => true, () => false)) await page.mouse.click(marker.x + marker.width / 2, marker.y + 18)
      await expect(head).toBeVisible()
      const title = head.locator('.ctx-title-ro')
      await expectWhole(title, 'the panel title')
      const t = await boxOf(title, 'the panel title')
      expect(overlaps(t, await boxOf(head.locator('.ctx-x'), 'the ✕')), 'the title never runs under the ✕').toBe(false)
    })
  })
}
