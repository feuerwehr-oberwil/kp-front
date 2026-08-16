import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Validate a config document against the API's REAL schema.
 *
 * ⚠️ Every frontend suite mocks `apiPut` as `body => body`, so a test can watch a value reach the
 * PUT and still be watching a 422. Three separate controls wrote a document the API refuses —
 * `doctrine.auftragColors.<id>: null` into a `dict[str, str]`, `null` into the three plain-`int`
 * Rundung fields, `8.5` into an `int | None` — and every one of them was invisible for the same
 * reason: nothing in the browser tests knew what the backend accepts.
 *
 * So this reads `docs/openapi.json` — generated FROM `backend/app/schemas.py`, with a drift test
 * in CI keeping it honest — and checks the body against `DeploymentConfigIn`. It is deliberately
 * NOT a hand-written mirror of the constraints: a mirror is one more thing to forget.
 *
 * What it models is pydantic's LAX mode, which is what the endpoint runs:
 *   · `integer` refuses 8.5 (`int_from_float`) and refuses a bool
 *   · `null` is only a value where the schema says so (`anyOf: [{…}, {type: null}]`)
 *   · unknown properties PASS — every config model is `extra="ignore"`, so a `version` echoed
 *     back into the PUT body is not an error
 */

interface Schema {
  $ref?: string
  anyOf?: Schema[]
  allOf?: Schema[]
  type?: string
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: Schema | boolean
  items?: Schema
  enum?: unknown[]
  const?: unknown
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
}

/** The generated spec, found from the working directory upwards — `import.meta.url` is not a
 *  file URL under the jsdom environment these suites run in. */
function openapiPath(): string {
  let dir = process.cwd()
  for (let up = 0; up < 6; up++) {
    const candidate = resolve(dir, 'docs/openapi.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('docs/openapi.json not found — run `just openapi` (it is generated from schemas.py)')
}

const openapi = JSON.parse(readFileSync(openapiPath(), 'utf8')) as {
  components: { schemas: Record<string, Schema> }
}

const deref = (s: Schema): Schema =>
  s.$ref ? deref(openapi.components.schemas[s.$ref.replace('#/components/schemas/', '')]!) : s

/** `report.hoursRounding.stepMin` — the path as the operator's error line would name it. */
const at = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key))

/** Does `value` satisfy `schema`? Returns the violations, deepest first — empty means accepted. */
function check(value: unknown, raw: Schema, path = ''): string[] {
  const schema = deref(raw)

  if (schema.anyOf) {
    // A union passes if ANY branch does. Reported against the non-null branches, because
    // `X | None` failing is almost always «this may not be null» or «wrong shape», never both.
    const branches = schema.anyOf.map((b) => check(value, b, path))
    if (branches.some((errs) => errs.length === 0)) return []
    const nullable = schema.anyOf.some((b) => deref(b).type === 'null')
    if (value === null && !nullable) return [`${path}: null is not accepted here`]
    return branches.flat().slice(0, 3)
  }
  if (schema.allOf) return schema.allOf.flatMap((b) => check(value, b, path))

  const t = schema.type
  if (t === 'null') return value === null ? [] : [`${path}: expected null`]
  if (value === undefined) return [] // an absent optional key is not a value

  if (t === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: expected an integer, got ${JSON.stringify(value)}`]
    // ⚠️ pydantic refuses a fractional float for an `int` field (`int_from_float`) — it does not
    // round it. This is the whole of defect «Doktrin · step=any».
    if (!Number.isInteger(value)) return [`${path}: expected an integer, got ${value}`]
    return bounds(value, schema, path)
  }
  if (t === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: expected a number, got ${JSON.stringify(value)}`]
    return bounds(value, schema, path)
  }
  if (t === 'string') {
    if (typeof value !== 'string') return [`${path}: expected a string, got ${JSON.stringify(value)}`]
    if (schema.minLength != null && value.length < schema.minLength) return [`${path}: shorter than ${schema.minLength}`]
    if (schema.maxLength != null && value.length > schema.maxLength) return [`${path}: longer than ${schema.maxLength}`]
    return []
  }
  if (t === 'boolean') return typeof value === 'boolean' ? [] : [`${path}: expected a boolean, got ${JSON.stringify(value)}`]

  if (t === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected a list, got ${JSON.stringify(value)}`]
    if (schema.maxItems != null && value.length > schema.maxItems) return [`${path}: more than ${schema.maxItems} entries`]
    return schema.items ? value.flatMap((v, i) => check(v, schema.items!, at(path, i))) : []
  }

  if (t === 'object' || schema.properties) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path}: expected an object, got ${JSON.stringify(value)}`]
    }
    const obj = value as Record<string, unknown>
    const errs: string[] = []
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errs.push(`${at(path, key)}: required`)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errs.push(...check(obj[key], sub, at(path, key)))
    }
    // ⚠️ `additionalProperties` as a SCHEMA is a `dict[str, X]` — every value has to be an X, and
    // that is what `doctrine.auftragColors` is. As `false` it would forbid unknown keys, which no
    // config model does (`extra="ignore"`), so anything else here passes.
    const extra = schema.additionalProperties
    if (extra && typeof extra === 'object') {
      for (const [key, v] of Object.entries(obj)) {
        if (schema.properties?.[key]) continue
        errs.push(...check(v, extra, at(path, key)))
      }
    }
    return errs
  }
  return [] // an untyped schema accepts anything, the way pydantic's `Any` does
}

function bounds(n: number, s: Schema, path: string): string[] {
  if (s.minimum != null && n < s.minimum) return [`${path}: ${n} is below the minimum ${s.minimum}`]
  if (s.maximum != null && n > s.maximum) return [`${path}: ${n} is above the maximum ${s.maximum}`]
  if (s.exclusiveMinimum != null && n <= s.exclusiveMinimum) return [`${path}: ${n} must be greater than ${s.exclusiveMinimum}`]
  if (s.exclusiveMaximum != null && n >= s.exclusiveMaximum) return [`${path}: ${n} must be less than ${s.exclusiveMaximum}`]
  return []
}

/** Everything `PUT /api/config` would answer 422 for, as readable lines. Empty = accepted. */
export function configRejections(body: unknown): string[] {
  return check(body, { $ref: '#/components/schemas/DeploymentConfigIn' })
}

/** Fail the test if this document would 422 — and say which field and why, the way the endpoint
 *  would. ⚠️ `undefined` means the autosave never fired, which is a different (usually
 *  deliberate) outcome and is left to the caller to assert. */
export function expectAccepted(body: unknown): void {
  const errs = configRejections(body)
  if (errs.length) {
    throw new Error(`PUT /api/config would answer 422:\n  ${errs.join('\n  ')}`)
  }
}
