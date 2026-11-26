import { describe, expect, it } from 'vitest'
import { CATEGORY_COLOR, CATEGORY_ID } from '../lib/karte/categories'
import { ALARM_BAR_STATION_MIN, NUMBER_GUARDS, TEXT_MAX_LENGTH, fitsText, type NumberGuard } from './configGuards'
import { fieldSchema } from './configSchema.test-utils'

// Each bound a Station form checks must be the server's own: a form that accepts what the API
// refuses stops the autosave of the whole config. The server's side is the generated contract
// (docs/openapi.json, kept equal to the backend by a pytest).

type GuardedPath = keyof typeof NUMBER_GUARDS
type Bounds = Pick<NumberGuard, 'min' | 'max' | 'exclusiveMin'>

/** A bound that does not reach docs/openapi.json: where it lives instead, and what it is there.
 *  The form must hold exactly that, and the schema must still have none (so the exception lapses
 *  the day the bound moves into the schema). */
const NOT_IN_SCHEMA: Partial<Record<GuardedPath, Bounds & { where: string }>> = {
  'doctrine.entryPressureMin': { where: 'backend/app/schemas.py · DoctrineConfig._pressure_lines_stay_in_range', min: 0, max: 300 },
  // DeploymentConfigIn also refuses 0 outside the demo; the form narrows the minimum to 1 there
  'doctrine.alarmBar': { where: 'backend/app/schemas.py · DoctrineConfig._pressure_lines_stay_in_range', min: 0, max: 300 },
  'doctrine.alarmBarRueckzug': { where: 'backend/app/schemas.py · DoctrineConfig._pressure_lines_stay_in_range', min: 0, exclusiveMin: true, max: 300 },
  'doctrine.contactIntervalMin': { where: 'backend/app/alarm_validation.py · CONTACT_INTERVAL_MIN (DoctrineConfig._pressure_lines_stay_in_range)', min: 1, max: 30 },
  'doctrine.contactGraceSec': { where: 'backend/app/alarm_validation.py · CONTACT_GRACE_SEC (DoctrineConfig._pressure_lines_stay_in_range)', min: 0, max: 300 },
}
/** A ceiling only the form has – stricter than the API (`ge=0` only), so it never stops the
 *  autosave. The schema must still have no maximum there. */
const FORM_ONLY_MAX: Partial<Record<GuardedPath, { why: string; max: number }>> = {
  'alarms.autoArchiveDays': { why: 'a typo guard: ten years is no archive delay', max: 3650 },
  'alarms.staleIncidentDays': { why: 'a typo guard: ten years is no stale delay', max: 3650 },
}

/** A guard as the comparison sees it: the flags as `true` or absent. */
const shape = (g: NumberGuard) => ({
  kind: g.kind, min: g.min, max: g.max, exclusiveMin: g.exclusiveMin || undefined, nullable: g.nullable || undefined,
})

describe('Station form bounds match docs/openapi.json', () => {
  it.each(Object.entries(NUMBER_GUARDS))('%s', (path, guard: NumberGuard) => {
    const { schema, nullable } = fieldSchema(path)
    const fromSchema: ReturnType<typeof shape> = {
      kind: schema.type === 'integer' ? 'int' : 'decimal',
      min: schema.exclusiveMinimum ?? schema.minimum,
      max: schema.maximum,
      exclusiveMin: schema.exclusiveMinimum !== undefined || undefined,
      nullable: nullable || undefined,
    }
    expect(schema.exclusiveMaximum, `${path}: the form has no exclusive maximum`).toBeUndefined()
    const elsewhere = NOT_IN_SCHEMA[path as GuardedPath]
    if (elsewhere) {
      expect({ min: fromSchema.min, max: fromSchema.max }, `${path} now has a bound in the schema – drop the exception`)
        .toEqual({ min: undefined, max: undefined })
      const { where: _where, ...bounds } = elsewhere
      expect(shape(guard)).toEqual(shape({ kind: fromSchema.kind, nullable: fromSchema.nullable, ...bounds }))
      return
    }
    const formOnly = FORM_ONLY_MAX[path as GuardedPath]
    if (formOnly) {
      expect(fromSchema.max, `${path} now has a maximum in the schema – drop the exception`).toBeUndefined()
      fromSchema.max = formOnly.max
    }
    expect(shape(guard)).toEqual(fromSchema)
  })

  it.each(Object.entries(TEXT_MAX_LENGTH))('%s', (path, maxLength) => {
    expect(fieldSchema(path).schema.maxLength).toBe(maxLength)
  })

  it('map.objectCategories.0.color', () => {
    expect(CATEGORY_COLOR.source).toBe(fieldSchema('map.objectCategories.0.color').schema.pattern)
  })

  it('counts a text bound in code points, as pydantic does', () => {
    expect(fitsText('report.links.0.note', '🚒'.repeat(200))).toBe(true)
    expect(fitsText('report.links.0.note', '🚒'.repeat(201))).toBe(false)
  })

  it('map.objectCategories.0.id', () => {
    expect(CATEGORY_ID.source).toBe(fieldSchema('map.objectCategories.0.id').schema.pattern)
  })

  // Not in the schema: backend/app/schemas.py · DeploymentConfigIn._zero_alarmdruck_is_demo_only
  // refuses an Alarmdruck of 0 unless `identity.demoMode`.
  it('doctrine.alarmBar outside the demo', () => {
    expect(ALARM_BAR_STATION_MIN).toBe(1)
  })
})
