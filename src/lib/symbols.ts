import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from './deploymentConfig'
import { formatSymbolName } from './format'
import type { CaptionMode, SymbolControl, SymbolProps } from '../types'

const presets = appConfig.symbols.presets

/** Deployment suggestion-list override for a given symbol+field — returns the configured
 *  list ONLY when it's non-empty; an empty/absent list falls through to the static preset.
 *  The data-driven `fleet.attributeLists` win; the legacy fixed fields are consulted as a
 *  fallback so pre-migration stored configs keep working (/api/config fleet.*). */
function fleetOptionsFor(name?: string, field?: string): string[] | undefined {
  const fleet = getDeploymentConfig().fleet
  if (!fleet || !name) return undefined
  // data-driven attribute lists take precedence
  const al = fleet.attributeLists?.find((a) => a.symbol === name && a.field === field)
  if (al && al.options.length) return al.options
  // legacy fixed fields (back-compat, only until the config is re-saved through the editor)
  let list: string[] | undefined
  if (name === 'VKF Fahrzeug' && field === 'title') list = fleet.vehicleTypes
  else if (name === 'VKF Luefter mobil' && field === 'Typ') list = fleet.luefterTypes
  else if (name === 'FW Kleinloeschgeraet' && field === 'Typ') list = fleet.kleinloeschTypes
  else if (name === 'VKF Bereich Feuerwehr' && field === 'Einheit') list = fleet.partner?.feuerwehr
  else if (name === 'VKF Bereich Sanitaet' && field === 'Einheit') list = fleet.partner?.sanitaet
  else if (name === 'VKF Bereich Polizei' && field === 'Einheit') list = fleet.partner?.polizei
  return list && list.length ? list : undefined
}

/** The curated preset for a symbol — exact name first, then its category. */
const presetFor = (name?: string, cat?: string) =>
  (name ? presets.byName[name] : undefined) ?? (cat ? presets.byCat[cat] : undefined)

/** Names of every directional symbol (preset lists 'rotation'). This is the ONE
 *  source for both the on-canvas drag-to-rotate handle (MapView / Whiteboard) and
 *  the editor's Drehung stepper, so the two can never drift apart. */
export const ROTATABLE: Set<string> = new Set(
  Object.entries(presets.byName)
    .filter(([, p]) => p.controls?.includes('rotation'))
    .map(([name]) => name),
)

/** Which of the three built-in steppers (rotation / count / floor) make sense for
 *  this symbol — the editor renders only these (intersected with what the surface
 *  supports). Unknown symbols fall back to all three (safe default). */
export function symbolControls(name?: string, cat?: string): Set<SymbolControl> {
  const p = presetFor(name, cat)
  return new Set<SymbolControl>(p ? p.controls ?? [] : ['rotation', 'count', 'floor'])
}

/** Seed the shared editable attributes for a freshly-placed FireGIS symbol —
 *  label (operational name), subtitle (category type-line) and the empty key/value
 *  detail rows from the per-symbol / per-category preset. Used by BOTH the Lage
 *  map and the Plan whiteboard placement paths, so a symbol carries the same
 *  structure wherever it is dropped (previously only the map seeded these).
 *
 *  The generic vehicle is special-cased: it is named by the user (like a GPS
 *  unit), so it drops in empty (no label / subtitle / fields) with rotation 0. */
export function seedSymbolProps(name: string, catalog: { name: string; cat: string }[]): SymbolProps {
  // the generic vehicle is user-named, so it drops in without a label/subtitle — but it
  // still seeds its preset fields (e.g. the Fahrer picker) like any other symbol.
  if (name === appConfig.symbols.vehicleName) {
    const tmpl = presets.byName[name]?.fields
    const fields = tmpl?.length ? Object.fromEntries(tmpl.map((k) => [k, ''])) : undefined
    return { symbol: name, label: '', rotation: 0, fields }
  }
  const cat = catalog.find((x) => x.name === name)?.cat
  const tmpl = presetFor(name, cat)?.fields
  const fields = tmpl?.length ? Object.fromEntries(tmpl.map((k) => [k, ''])) : undefined
  return { symbol: name, label: formatSymbolName(name), subtitle: cat, fields }
}

/** Combobox suggestions for a symbol's TITLE input (e.g. common vehicle types). Sourced ONLY
 *  from the deployment config (`fleet.attributeLists` title entry / legacy `vehicleTypes`) —
 *  there is no code-baked default list; an unconfigured title is free-text. */
export function symbolTitleOptions(name?: string, _cat?: string): string[] | undefined {
  return fleetOptionsFor(name, 'title')
}

/** The preset-seeded field keys for a symbol — these are protected from accidental deletion
 *  in the editor (e.g. the Kleinlöscher Typ row), since they belong to the symbol by doctrine. */
export function symbolPresetFieldKeys(name?: string, cat?: string): string[] {
  return presetFor(name, cat)?.fields ?? []
}

/** Per-field combobox suggestions for a symbol: the deployment-configured lists merged with the
 *  Mannschaft roster for the person-name fields (Name / Fahrer). There are NO code-baked default
 *  lists — an unconfigured field stays empty (free typing). Free typing is always allowed. */
export function symbolFieldOptions(name: string | undefined, cat: string | undefined, roster: string[]): Record<string, string[]> {
  const p = presetFor(name, cat)
  const rosterSet = new Set<string>(appConfig.symbols.rosterFields)
  const out: Record<string, string[]> = {}
  // every detail field of the symbol is a key, so a configured (attributeLists or legacy fixed)
  // list applies; plus any extra field a deployment attaches a list to.
  for (const f of p?.fields ?? []) out[f] = []
  for (const a of getDeploymentConfig().fleet?.attributeLists ?? []) {
    if (a.symbol === name && a.field !== 'title') out[a.field] ??= []
  }
  // deployment lists fill the matched field (when non-empty). Roster fields are SKIPPED here:
  // they are person-name pickers and are filled with the Mannschaft below — mixing a category
  // list into them would conflate "who" with "what" (a real reported bug: an Offizier function
  // list bled into the member-name dropdown). Use a separate field.
  for (const key of Object.keys(out)) {
    if (rosterSet.has(key)) continue
    const override = fleetOptionsFor(name, key)
    if (override) out[key] = override
  }
  // Roster fields → Mannschaft names ONLY (not merged with any configured list).
  for (const key of rosterSet) {
    out[key] = roster
  }
  return out
}

// ─── on-canvas captions: a symbol's metadata printed under its glyph ────────────────
// Mirrors the line-label idea (a Drawing's `label` at its midpoint) for symbols: instead of
// free text, the caption is DERIVED from the symbol's own detail fields, so an operator reads
// "CO₂" under a Kleinlöscher without opening its dashboard (recognition over recall). Shown on
// BOTH surfaces via TacticalSymbol; the Lage map additionally zoom-gates it (captionMinZoom).

/** The detail field that identifies a symbol at a glance — the preset's declared `caption`,
 *  else its first field. Undefined for a fields-less symbol (then only a custom label captions). */
function captionPrimaryKey(name?: string): string | undefined {
  const p = name ? presets.byName[name] : undefined
  return p?.caption ?? p?.fields?.[0]
}

/** A label worth printing: operator-entered text, NOT the auto-formatted symbol name (which the
 *  glyph already conveys). The user-named vehicle's title ("TLF 1") passes; a plain "Hydrant"
 *  does not. */
function customLabel(props: SymbolProps): string | undefined {
  const l = props.label?.trim()
  if (!l) return undefined
  if (props.symbol && l === formatSymbolName(props.symbol)) return undefined
  return l
}

/** The text to print under a symbol's glyph, or null when there's nothing worth showing.
 *  Value-only (the glyph implies the key). `globalMode` is the device default; a symbol's own
 *  `caption` overrides it. 'auto' = the one discriminating value; 'all' = every filled detail
 *  (newline-separated). Pure — the renderer adds the zoom gate. */
export function symbolCaptionText(props: SymbolProps, globalMode: CaptionMode): string | null {
  const mode = props.caption ?? globalMode
  if (mode === 'off') return null
  const fields = props.fields ?? {}
  const order = (props.symbol ? presets.byName[props.symbol]?.fields : undefined) ?? Object.keys(fields)
  const filled = order.map((k) => fields[k]?.trim()).filter((v): v is string => !!v)
  const label = customLabel(props)
  if (mode === 'all') {
    // 'all' = EVERYTHING the operator typed on this symbol: the preset detail fields (in canonical
    // order) PLUS any custom key/value rows they added PLUS the free-text notes — not just the
    // pre-defined preset fields. Value-only (the glyph implies the keys), de-duplicated.
    const extraKeys = Object.keys(fields).filter((k) => !order.includes(k))
    const allFilled = [...order, ...extraKeys].map((k) => fields[k]?.trim()).filter((v): v is string => !!v)
    const notes = props.notes?.trim()
    const seen = new Set<string>()
    const lines = [label, ...allFilled, notes].filter((v): v is string => !!v && !seen.has(v) && !!seen.add(v))
    return lines.length ? lines.join('\n') : null
  }
  // 'auto': the primary discriminating value, else the first filled field, else a custom label
  const primaryKey = captionPrimaryKey(props.symbol)
  const primary = primaryKey ? fields[primaryKey]?.trim() : undefined
  return primary || filled[0] || label || null
}

// ─── admin: the configurable symbol/field catalog ──────────────────────────────────
// The Fahrzeuge-&-Geräte viewer browses EVERY library symbol and shows each one's attributes. A
// symbol's attributes are its special 'title' (only the user-titled vehicle) plus each preset
// detail field, flagged for roster (person-name) fields which are auto-filled from the Mannschaft.
// Suggestion lists are NOT code-baked — they come from the deployment config; an unconfigured
// field is free-text.

export interface ConfigurableField {
  key: string
  /** person-name field (Name / Fahrer): filled from the Mannschaft, not config-listable here */
  roster: boolean
}

/** Every attribute a symbol exposes, in display order: the vehicle's special 'title' (only the
 *  user-titled vehicle) then each preset detail field. Returns [] for a label-only symbol. */
export function symbolConfigurableFields(name?: string, cat?: string): ConfigurableField[] {
  const p = presetFor(name, cat)
  const rosterSet = new Set<string>(appConfig.symbols.rosterFields)
  const out: ConfigurableField[] = []
  if (name === appConfig.symbols.vehicleName) out.push({ key: 'title', roster: false })
  for (const f of p?.fields ?? []) out.push({ key: f, roster: rosterSet.has(f) })
  return out
}
