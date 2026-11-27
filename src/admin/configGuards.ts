// The bounds a Station form holds a typed value to BEFORE it enters the draft – one table, by
// config path. ⚠️ The config is ONE document with an autosave, so a value the API refuses stops
// the save of every Station page at once; each bound here must therefore be the server's own.
// `configGuards.test` holds every entry against the bound in the generated schema
// (docs/openapi.json). A form reads its bound from here and never types one inline; a bound that
// lives only in a backend validator is a named exception in that test.

import { appConfig } from '../config/appConfig'
import { OFFLINE_RADIUS_M } from '../lib/deploymentConfig'
import { fillTemplate } from '../lib/format'
import { CONTACT_BOUNDS } from '../lib/workspace'
import type { ConfigPathTo } from './ConfigContext'

/**
 * How a number box checks what is typed.
 *
 * ⚠️ `nullable` is the schema's `| None`, NOT «the box may be empty». `doctrine.*` is nullable —
 * clearing it goes back to the shipped doctrine. `report.hoursRounding.stepMin` and the two
 * numbers beside it are plain `int` with a default, always populated by the GET projection:
 * backspacing «30» to type «60» wrote `null` into a field that has no null and wedged the whole
 * document for as long as the box was empty.
 */
export interface NumberGuard {
  /** `int` on the backend — 8.5 is an `int_from_float` error there, not a rounding */
  kind: 'int' | 'decimal'
  min?: number
  max?: number
  /** the schema's `gt` rather than `ge` (doctrine.cylinderLiters: gt=0, le=30) */
  exclusiveMin?: boolean
  /** the schema accepts `null` here, so an empty box is a value rather than a refusal */
  nullable?: boolean
}

/** A config path written with dots (`doctrine.alarmBar`), the key of the tables below… */
type Dotted<P> = P extends readonly [infer H extends string | number, ...infer R]
  ? R extends readonly [] ? `${H}` : `${H}.${Dotted<R>}`
  : never
/** …and back into the path tuple, so an entry's `path` must be its key. */
type Undotted<S extends string> = S extends `${infer H}.${infer R}` ? readonly [H, ...Undotted<R>] : readonly [S]

/** One number box: the path it writes and the bound it holds the typed value to. */
export type NumberField = NumberGuard & { path: ConfigPathTo<number> }

/** Every Doktrin number is `int | None` on the backend (schemas.py · DoctrineConfig), so an EMPTY
 *  box is a value — it goes back to the shipped doctrine — but «8.5» is not. */
const DOCTRINE_INT = { kind: 'int', nullable: true } as const

/** The number boxes of the Station pages. A form passes the whole entry, so a box cannot write
 *  one path under another path's bound. It may narrow a bound further at run time (the
 *  station's own Funkkanal range, the Alarmdruck above the Rückzug line), never widen it. */
export const NUMBER_GUARDS = {
  'map.offlineRadiusM': { path: ['map', 'offlineRadiusM'], kind: 'int', min: OFFLINE_RADIUS_M.min, max: OFFLINE_RADIUS_M.max, nullable: true },
  'doctrine.defaultFunkkanal': { path: ['doctrine', 'defaultFunkkanal'], ...DOCTRINE_INT },
  'doctrine.defaultFunkkanalEinfach': { path: ['doctrine', 'defaultFunkkanalEinfach'], ...DOCTRINE_INT },
  'doctrine.funkkanalMin': { path: ['doctrine', 'funkkanalMin'], ...DOCTRINE_INT },
  'doctrine.funkkanalMax': { path: ['doctrine', 'funkkanalMax'], ...DOCTRINE_INT },
  'doctrine.defaultPressureBar': { path: ['doctrine', 'defaultPressureBar'], ...DOCTRINE_INT },
  'doctrine.pressureStep': { path: ['doctrine', 'pressureStep'], ...DOCTRINE_INT },
  'doctrine.pressureMax': { path: ['doctrine', 'pressureMax'], ...DOCTRINE_INT },
  // 0 is a real choice here — «never ask» — so the box takes it, unlike the alarm lines
  'doctrine.entryPressureMin': { path: ['doctrine', 'entryPressureMin'], kind: 'int', min: 0, max: 300, nullable: true },
  // 0 is the public demo's «off» only; a station deployment narrows to ALARM_BAR_STATION_MIN
  'doctrine.alarmBar': { path: ['doctrine', 'alarmBar'], kind: 'int', min: 0, max: 300, nullable: true },
  // …and never above the Alarmdruck this station runs on (the form narrows `max`)
  'doctrine.alarmBarRueckzug': { path: ['doctrine', 'alarmBarRueckzug'], kind: 'int', min: 0, exclusiveMin: true, max: 300, nullable: true },
  // the station range of the contact clock (lib/workspace · CONTACT_BOUNDS, audit F02)
  'doctrine.contactIntervalMin': { path: ['doctrine', 'contactIntervalMin'], kind: 'int', ...CONTACT_BOUNDS.contactIntervalMin, nullable: true },
  'doctrine.contactGraceSec': { path: ['doctrine', 'contactGraceSec'], kind: 'int', ...CONTACT_BOUNDS.contactGraceSec, nullable: true },
  // A 0-litre cylinder is not a smaller cylinder, it is a division by zero in the estimate
  'doctrine.cylinderLiters': { path: ['doctrine', 'cylinderLiters'], kind: 'decimal', min: 0, exclusiveMin: true, max: 30, nullable: true },
  'doctrine.estConsumptionLPerMin': { path: ['doctrine', 'estConsumptionLPerMin'], kind: 'decimal', min: 0, exclusiveMin: true, max: 200, nullable: true },
  // `int = 25` on the backend – no null, so an emptied box is held back instead of being sent
  'doctrine.nearbyObjectWarnM': { path: ['doctrine', 'nearbyObjectWarnM'], kind: 'int', min: 0, max: 500 },
  'report.hoursRounding.stepMin': { path: ['report', 'hoursRounding', 'stepMin'], kind: 'int', min: 1, max: 480 },
  'report.hoursRounding.graceMin': { path: ['report', 'hoursRounding', 'graceMin'], kind: 'int', min: 0, max: 479 },
  'report.attendanceMergeGapMin': { path: ['report', 'attendanceMergeGapMin'], kind: 'int', min: 0, max: 240 },
  'alarms.autoArchiveDays': { path: ['alarms', 'autoArchiveDays'], kind: 'int', min: 0, max: 3650 },
  'alarms.staleIncidentDays': { path: ['alarms', 'staleIncidentDays'], kind: 'int', min: 0, max: 3650 },
  'alarms.captureWindowHours': { path: ['alarms', 'captureWindowHours'], kind: 'int', min: 1, max: 168 },
  'objectVisits.lockAfterHours': { path: ['objectVisits', 'lockAfterHours'], kind: 'int', min: 0, max: 8760, nullable: true },
} as const satisfies { [K in Dotted<ConfigPathTo<number>>]?: NumberGuard & { path: Undotted<K> } }

/** The Alarmdruck minimum of a station deployment: 0 switches both pressure alarms off, which
 *  only the public demo may (the form uses the table's 0 there). */
export const ALARM_BAR_STATION_MIN = 1

/** The text boxes with a length limit (`.0.` = every row of a list). The box carries it as
 *  `maxLength`, so the browser holds what is typed or pasted to it; the editor's writer refuses a
 *  longer value that reaches the row another way (a chip, a derived Kennung). */
export const TEXT_MAX_LENGTH = {
  // the Karte's menu button label (schemas · SHORT_NAME_MAX)
  'identity.shortName': 8,
  // an Objektfarben rule's id, derived from its name (lib/karte/categories · CATEGORY_ID)…
  'map.objectCategories.0.id': 40,
  // …and each plan-module glob it matches, one per comma in the card's box
  'map.objectCategories.0.match.modules.0': 60,
  // a Rapport Formular link (ConfigSections · ReportLinksEditor)
  'report.links.0.title': 120,
  'report.links.0.url': 2048,
  'report.links.0.note': 200,
  // a Korrekturvorschlag field (ObjectVisitsView · ProposalFieldsEditor)
  'objectVisits.proposalFields.0.id': 64,
  'objectVisits.proposalFields.0.label': 120,
  // an Objektbesuche destination (objectVisits/folders · destinationValid)
  'objectVisits.destinations.0.id': 64,
  'objectVisits.destinations.0.siteUrl': 400,
  'objectVisits.destinations.0.library': 200,
  'objectVisits.destinations.0.root': 400,
  'objectVisits.destinations.0.objectFolder': 200,
  'objectVisits.destinations.0.visitFolder': 200,
  'objectVisits.destinations.0.locationFolder': 200,
} as const satisfies { [K in Dotted<ConfigPathTo<string>>]?: number }

/** Does `value` fit the bound of `field`? Absent counts as fitting – presence is the editor's
 *  own rule. Counted in code points, as pydantic counts: «🚒» is one character there and two
 *  UTF-16 units here, so `.length` would hold back a stored note the server accepted. */
export function fitsText(field: keyof typeof TEXT_MAX_LENGTH, value: string | null | undefined): boolean {
  return [...(value ?? '')].length <= TEXT_MAX_LENGTH[field]
}

/** The reason line under a row that its writer holds for a length: the first of `fields`
 *  (bound, the form's label for the box, the value the writer checks) past its bound, as
 *  «<label>: höchstens <n> Zeichen – …». Null when every value fits. `stored`: the values are a
 *  stored original the save keeps (useStoredRows · keptOriginals), which refuses every save of
 *  the config until it is shortened or deleted – the line says that, not «not saved like this». */
export function tooLongNote(
  fields: ReadonlyArray<readonly [field: keyof typeof TEXT_MAX_LENGTH, label: string, value: string | null | undefined]>,
  stored = false,
): string | null {
  const over = fields.find(([field, , value]) => !fitsText(field, value))
  const { textTooLong, textTooLongStored } = appConfig.copy.admin.common
  return over ? fillTemplate(stored ? textTooLongStored : textTooLong, { field: over[1], n: TEXT_MAX_LENGTH[over[0]] }) : null
}
