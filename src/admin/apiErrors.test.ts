import { describe, expect, it } from 'vitest'
import { ApiError, apiPut } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { apiErrorText, describeApiError } from './apiErrors'

// The one shaping every admin view's failed save, delete, upload and import goes through.

const E = appConfig.copy.errors

/** The error a real `apiPut` throws when fetch answers so – the whole lib/api shaping included. */
async function failing(answer: () => Promise<Response>): Promise<unknown> {
  const real = globalThis.fetch
  globalThis.fetch = answer
  try {
    return await apiPut('/api/config', {}).catch((x: unknown) => x)
  } finally {
    globalThis.fetch = real
  }
}

describe('describeApiError', () => {
  it('names the refused fields of a 422 in German, never the Pydantic sentence', () => {
    const e = new ApiError(422, 'map.defaultView.center: Input should be a valid list')
    e.fields = [
      { path: 'map.defaultView.center', msg: 'Input should be a valid list', kind: 'list_type', input: { 0: 8.1 } },
      { path: 'report.links.2.title', msg: 'String should have at most 120 characters', kind: 'string_too_long' },
    ]
    const A = appConfig.copy.admin
    const said = describeApiError(e, 'Speichern fehlgeschlagen')
    expect(said.message).toBe(fillTemplate(A.autosave.rejected, {
      fields: `${A.map.centerField} (${A.nav.karte.title}) · ${A.report.groupLinks} (${A.nav.rapport.title})`,
    }))
    expect(said.message).not.toMatch(/Input should|String should/)
    expect(said.hint).toBeUndefined()
    // a body that is not the config document is named by the words of its own form
    const roster = new ApiError(422, 'display_name: String should have at least 1 character')
    roster.fields = [{ path: 'display_name', msg: 'String should have at least 1 character', kind: 'string_too_short' }]
    expect(apiErrorText(roster, undefined, { display_name: A.roster.colName }))
      .toBe(fillTemplate(A.autosave.rejected, { fields: A.roster.colName }))
  })

  it('keeps the hint that belongs to a refusal', async () => {
    // a 428 with no words of its own: «Seite veraltet» and what to do about it
    const e = await failing(() => Promise.resolve(new Response('', { status: 428 })))
    expect(describeApiError(e, 'Speichern fehlgeschlagen')).toEqual({ message: E.httpStale, hint: E.httpStaleHint })
    expect(apiErrorText(e)).toBe(`${E.httpStale} ${E.httpStaleHint}`)
  })

  // Sweep 25.11.2026: offline, every admin line ended in the field app's «Gespeicherte Einsätze
  // bleiben offline verfügbar.»
  it.each([
    ['no network', () => Promise.reject(new TypeError('Failed to fetch')), E.serverUnreachable, E.serverUnreachableHint],
    ['our timeout', () => Promise.reject(new DOMException('signal timed out', 'TimeoutError')), E.serverTimeout, E.serverTimeoutHint],
    ['a proxy\'s 503', () => Promise.resolve(new Response('<html>', { status: 503 })), E.httpGateway, E.httpGatewayHint],
  ])('%s: says why, without the field app\'s hint – which the field app still gets', async (_, answer, reason, fieldHint) => {
    const e = await failing(answer)
    expect(apiErrorText(e, 'Speichern fehlgeschlagen')).toBe(reason)
    expect(describeApiError(e).hint).toBeUndefined()
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).hint).toBe(fieldHint)
  })

  it('falls back to the view\'s own sentence for anything that is no ApiError', () => {
    expect(describeApiError(new TypeError('x is undefined'), 'Hochladen fehlgeschlagen')).toEqual({ message: 'Hochladen fehlgeschlagen' })
    expect(apiErrorText(new Error('boom'))).toBe(appConfig.copy.admin.common2.unknownError)
  })
})
