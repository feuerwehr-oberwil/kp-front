import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Trupp } from '../types'

/**
 * A Trupp's status words exist twice: the union on `Trupp.status` and `schemas.TruppStatus`, which
 * the push sweep reads to decide whether a crew is in the field. This holds the two equal — the
 * backend side through the enum it emits into `docs/openapi.json` (`just openapi`).
 */

// every member of the union and nothing else: `satisfies` refuses an extra word, `exhaustive` a
// missing one — so the list below IS the union, checked by tsc
const STATUSES = ['angemeldet', 'aktiv', 'rueckzug', 'ueberfaellig', 'raus'] as const satisfies readonly Trupp['status'][]
const exhaustive: [Exclude<Trupp['status'], (typeof STATUSES)[number]>] extends [never] ? true : never = true

interface OpenApi {
  components: { schemas: { TruppsPut: { properties: { trupps: { items: { properties: { status: { enum: string[] } } } } } } } }
}

describe('Trupp status', () => {
  it('has the same words on the client as in the API contract', () => {
    const spec = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/openapi.json'), 'utf8')) as OpenApi
    const served = spec.components.schemas.TruppsPut.properties.trupps.items.properties.status.enum
    expect(exhaustive).toBe(true)
    expect([...served].sort()).toEqual([...STATUSES].sort())
  })
})
