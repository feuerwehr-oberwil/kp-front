import { test as base, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

// ── The client-error guard (24.09.2026) ─────────────────────────────────────────────────────
// Every spec imports `test` from ./helpers (which re-exports this one), never from
// '@playwright/test' — eslint enforces it — and so every spec fails when the app reports a
// client error or a render storm, even if everything it asserts still holds. On 23.09.2026 the
// Karte of every device sat in a render loop for hours, and the only witness was
// `POST /api/diag/client-error` (lib/reportError, fed by the ErrorBoundary, the window handlers,
// MapView's map errors and lib/useRenderStorm): it lands in the server log and never failed a
// build. Now it fails the test that caused it, with the payload attached.
//
// Two signals, because either can be the one that got out: the report request itself (every
// kind — render, error, unhandledrejection, surface-recrash, render-storm), and the console /
// uncaught-error line of the loop itself (React #185, «Maximum update depth exceeded»), which
// is there even when the report is still waiting for lib/reportError's budget.
//
// A test that provokes a report ON PURPOSE names it, report by report, with
// `test.use({ expectedClientErrors: [/^error: Failed to fetch$/] })` — matched against
// «kind: message» of the report body. Nothing else is excused. A crash is never excused, whatever
// the list says: not the kinds render / surface-recrash / render-storm, and not the console /
// uncaught line of a render loop. There is deliberately no switch that turns the guard off.

export interface ClientErrorReport {
  /** which browser context («device») saw it — `device 1` is the test's own `page` */
  device: string
  source: 'client-error' | 'console' | 'pageerror'
  at: string
  /** the report body as sent (JSON), or the console / error text */
  detail: string
}

interface ClientErrorSink {
  /** what fails the test */
  reports: ClientErrorReport[]
  /** what the test said it would provoke (attached, never failing) */
  expected: ClientErrorReport[]
  allow: readonly RegExp[]
}

const CLIENT_ERROR_PATH = '/api/diag/client-error'
/** the loop's own words: React's minified #185 (prod build), its dev text, and the storm beacon */
const LOOP_SIGNS = /Minified React error #185|Maximum update depth exceeded|render storm/i

/** report kinds that ARE a crash — never excused by `expectedClientErrors` */
const NEVER_EXCUSED = new Set(['render', 'surface-recrash', 'render-storm'])

/** «kind: message» of a report body, for `expectedClientErrors` — '' if it is not one, or if
 *  its kind can never be excused */
function kindAndMessage(body: string): string {
  try {
    const r = JSON.parse(body) as { kind?: unknown; message?: unknown }
    return NEVER_EXCUSED.has(`${r.kind}`) ? '' : `${r.kind}: ${r.message}`
  } catch { return '' }
}

/** Start collecting every client error `context` reports. */
function guardClientErrors(context: BrowserContext, device: string, sink: ClientErrorSink) {
  const push = (source: ClientErrorReport['source'], detail: string) => {
    const report = { device, source, at: new Date().toISOString(), detail: detail.slice(0, 4000) }
    const said = source === 'client-error' ? kindAndMessage(detail) : ''
    const excused = said !== '' && sink.allow.some((re) => re.test(said))
    if (excused) sink.expected.push(report)
    else sink.reports.push(report)
  }
  const watch = (page: Page) => {
    page.on('console', (msg) => { if (msg.type() === 'error' && LOOP_SIGNS.test(msg.text())) push('console', msg.text()) })
    page.on('pageerror', (err) => { if (LOOP_SIGNS.test(err.message)) push('pageerror', `${err.message}\n${err.stack ?? ''}`) })
  }
  context.pages().forEach(watch)
  context.on('page', watch)
  // context-level, so a request the service worker forwards is seen too
  context.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === CLIENT_ERROR_PATH) push('client-error', req.postData() ?? '')
  })
}

/** Mid-test form of the guard, for a spec that wants the failure AT the step that caused it. */
export function expectNoClientErrors(reports: ClientErrorReport[], where: string) {
  expect(reports, `${where}: the app reported a client error or render storm`).toEqual([])
}

async function settleClientErrors(sink: ClientErrorSink, testInfo: TestInfo) {
  if (sink.expected.length) {
    await testInfo.attach('client-errors-expected.json', { body: JSON.stringify(sink.expected, null, 2), contentType: 'application/json' })
  }
  if (!sink.reports.length) return
  await testInfo.attach('client-errors.json', { body: JSON.stringify(sink.reports, null, 2), contentType: 'application/json' })
  const first = sink.reports[0]
  throw new Error(
    `The app reported ${sink.reports.length} client error(s) / render storm(s) during this test ` +
    `(attachment client-errors.json; the server log has them as kpfront.clienterror). ` +
    `First, on ${first.device} via ${first.source}: ${first.detail.slice(0, 600)}`,
  )
}

interface GuardOptions {
  /** reports this test provokes on purpose, as /«kind: message»/ — see the note at the top */
  expectedClientErrors: RegExp[]
}

interface GuardFixtures {
  clientErrorSink: ClientErrorSink
  /** every unexcused client error any context of this test reported, so far */
  clientErrors: ClientErrorReport[]
  /** A further browser context — another device on the SAME station — guarded like `page`,
   *  with the project's base URL and viewport, and closed at the end. (Playwright's own
   *  failure screenshot covers its pages too.) */
  openDevice: (name: string) => Promise<Page>
}

export const test = base.extend<GuardOptions & GuardFixtures>({
  expectedClientErrors: [[], { option: true }],
  // auto: it runs for every test of every spec, whether the test asks for it or not
  clientErrorSink: [async ({ context, expectedClientErrors }, use, testInfo) => {
    const sink: ClientErrorSink = { reports: [], expected: [], allow: expectedClientErrors }
    guardClientErrors(context, 'device 1', sink)
    await use(sink)
    await settleClientErrors(sink, testInfo)
  }, { auto: true }],
  clientErrors: async ({ clientErrorSink }, use) => { await use(clientErrorSink.reports) },
  openDevice: async ({ browser, baseURL, viewport, clientErrorSink }, use) => {
    const opened: BrowserContext[] = []
    await use(async (name) => {
      const context = await browser.newContext({ baseURL, viewport })
      guardClientErrors(context, name, clientErrorSink)
      opened.push(context)
      return context.newPage()
    })
    for (const context of opened) await context.close()
  },
})

export { expect }
