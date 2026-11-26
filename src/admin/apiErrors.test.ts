import { describe, expect, it } from 'vitest'
import { ApiError, apiPut } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { apiErrorText, describeApiError } from './apiErrors'

// The one shaping every admin view's failed save, delete, upload and import goes through.

const E = appConfig.copy.errors

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

  it('keeps the server\'s message and the hint that came with it', () => {
    const e = new ApiError(503, E.httpGateway)
    e.hint = E.httpGatewayHint
    expect(describeApiError(e, 'Speichern fehlgeschlagen')).toEqual({ message: E.httpGateway, hint: E.httpGatewayHint })
    expect(apiErrorText(e)).toBe(`${E.httpGateway} ${E.httpGatewayHint}`)
  })

  it('says «not reachable» with its instruction when the request never got an answer', async () => {
    const real = globalThis.fetch
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'))
    try {
      const e = await apiPut('/api/members/1', {}).catch((x: unknown) => x)
      expect(apiErrorText(e, 'Speichern fehlgeschlagen')).toBe(`${E.serverUnreachable} ${E.serverUnreachableHint}`)
    } finally {
      globalThis.fetch = real
    }
  })

  it('falls back to the view\'s own sentence for anything that is no ApiError', () => {
    expect(describeApiError(new TypeError('x is undefined'), 'Hochladen fehlgeschlagen')).toEqual({ message: 'Hochladen fehlgeschlagen' })
    expect(apiErrorText(new Error('boom'))).toBe(appConfig.copy.admin.common2.unknownError)
  })
})
