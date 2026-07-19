// Deployment-config resolution layer (Phase 1.B · T1.5).
//
// A single kp-front build serves many fire-brigade deployments. The static `appConfig`
// (src/config/appConfig.ts) carries the sensible defaults; each deployment can OVERRIDE
// a curated subset of them at runtime via the backend's PUBLIC `GET /api/config` endpoint
// (no auth, like /api/auth/roster). This module fetches that override blob once at boot,
// caches it for offline, and exposes a synchronous accessor that read sites consult BEFORE
// falling back to appConfig.
//
// Contract (camelCase, every field optional/possibly-empty — a fresh deployment returns
// mostly-empty objects). This type mirrors the backend response exactly; keep in sync.

export interface DeploymentAssets {
  logo?: string | null
  iconPng192?: string | null
  iconPng512?: string | null
  favicon?: string | null
}

export interface DeploymentIdentity {
  appName?: string | null
  locale?: string | null
  accentColor?: string | null
  assets?: DeploymentAssets | null
  helpIntro?: string | null
  kommandant?: string | null // pre-fills the rapport's Kommandant signature line
  demoMode?: boolean | null
  demoNote?: string | null
}

export interface DeploymentDefaultView {
  center?: [number, number] | null // [lon, lat] WGS84
  centerLv95?: [number, number] | null // [E, N] LV95
  zoom?: number | null
}

export interface DeploymentGeocoder {
  defaultLocality?: string | null
  bboxLv95?: string | null
}

export interface DeploymentExternalLink {
  label?: string | null
  /** URL template; supports {E}/{N} (LV95 easting/northing) and {lng}/{lat} (WGS84). */
  urlTemplate?: string | null
}

export interface DeploymentMap {
  defaultView?: DeploymentDefaultView | null
  geocoder?: DeploymentGeocoder | null
  externalLinks?: DeploymentExternalLink[] | null
}

export interface DeploymentReferenceLayer {
  id?: string
  group?: string
  label?: string
  icon?: string
  kind?: 'wms' | 'wmts' | 'geojson'
  tiles?: string[] | null
  geojson?: unknown | null
  vectorKind?: string | null
  symbol?: string | null
  color?: string | null
  nightColor?: string | null
  opacity?: number | null
  maxzoom?: number | null
  attribution?: string | null
  /** Einsatz categories (German `kategorien` values) that auto-show this layer when an
   *  incident of that category is created / re-categorized */
  autoActivate?: string[] | null
}

export interface DeploymentPartner {
  feuerwehr?: string[]
  sanitaet?: string[]
  polizei?: string[]
  chemiewehr?: string[]
  zivilschutz?: string[]
}

/** One data-driven suggestion list: the options offered for a given symbol's field
 *  (combobox prefill — free typing always stays possible). `field === 'title'` targets
 *  the symbol's TITLE input; any other key targets that detail row. This replaces the old
 *  fixed vehicleTypes/luefterTypes/… fields so a deployment can attach a list to ANY
 *  symbol field, not just the six the app once hardcoded. */
export interface FleetAttributeList {
  symbol: string
  field: string
  options: string[]
}

/** One station vehicle for the Alarmierungs-/Ausrückzeiten grid (rapport form, paper
 *  Erfassungsblatt, milestone matching). `id` = the sender's device name (Traccar). */
export interface FleetVehicle {
  id: string
  label: string
  winfapAlias?: string | null
}

export interface DeploymentFleet {
  /** station vehicles for the Zeiten grid — empty/absent hides every vehicle-times surface */
  vehicles?: FleetVehicle[]
  /** Data-driven per-symbol suggestion lists (the editable surface going forward). */
  attributeLists?: FleetAttributeList[]
  // ── legacy fixed lists (pre-attributeLists) — still read as a fallback so existing
  // stored configs keep working; the admin editor migrates them into attributeLists on
  // first edit. Don't add new code paths against these. ──
  vehicleTypes?: string[]
  luefterTypes?: string[]
  kleinloeschTypes?: string[]
  partner?: DeploymentPartner | null
}

/** Map a legacy fixed-field fleet config onto the data-driven attributeLists shape, so the
 *  admin editor and the symbol resolver see one uniform representation. Empty lists are
 *  dropped. Returns [] for an absent/empty fleet. */
export function legacyFleetToAttributeLists(fleet: DeploymentFleet | null | undefined): FleetAttributeList[] {
  if (!fleet) return []
  const out: FleetAttributeList[] = []
  const push = (symbol: string, field: string, options: string[] | undefined) => {
    if (options && options.length) out.push({ symbol, field, options })
  }
  push('VKF Fahrzeug', 'title', fleet.vehicleTypes)
  push('VKF Luefter mobil', 'Typ', fleet.luefterTypes)
  push('FW Kleinloeschgeraet', 'Typ', fleet.kleinloeschTypes)
  push('VKF Bereich Feuerwehr', 'Einheit', fleet.partner?.feuerwehr)
  push('VKF Bereich Sanitaet', 'Einheit', fleet.partner?.sanitaet)
  push('VKF Bereich Polizei', 'Einheit', fleet.partner?.polizei)
  return out
}

export interface DeploymentDoctrine {
  defaultFunkkanal?: number | null
  funkkanalMin?: number | null
  funkkanalMax?: number | null
  mindestBar?: number | null
  contactIntervalMin?: number | null
  contactGraceSec?: number | null
  defaultPressureBar?: number | null
  pressureStep?: number | null
  pressureMax?: number | null
}

/** One Dienstgrad in the station's ordered rank list. Mirrors backend `RankConfig`. Position
 *  in `DeploymentRoster.ranks` is the seniority order (most senior first). */
export interface RankConfig {
  key: string
  label: string
  abbr?: string
  tier?: 'officer' | 'nco' | 'crew'
}

export interface DeploymentRoster {
  source?: 'manual' | 'divera' | null
  /** Ordered ranks, most senior first. Empty/absent → the in-code Swiss default in rank.ts. */
  ranks?: RankConfig[]
}

/** One entry of the station-wide Mittel (material) catalogue: a material that crews routinely
 *  use up and want billed/reported (`Stk` Lüfter, `l` Schaummittel, `Sack` Bindemittel …).
 *  `unit` is the default unit the entry seeds with (still editable per incident). */
export interface DeploymentMittelStock {
  /** source id (matches a DeploymentMittelSource.id) where this many are normally carried */
  source: string
  qty: number
}

export interface DeploymentMittelItem {
  id: string
  label: string
  unit?: string
  /** grouping bucket for the picker + Bestand view (e.g. "Ölwehr", "Geräte"); free string */
  category?: string
  /** standard load-out per source (the station's nominal stock + where it lives). Drives the
   *  used/available readout and the Bestand overview. Sources omitted ⇒ none there. Optional. */
  stock?: DeploymentMittelStock[]
  /** tactical-symbol pack name this material corresponds to (e.g. "VKF Luefter mobil") —
   *  placing that symbol on Lage/Plan offers logging the material. Without it, a loose
   *  label↔symbol-name token match still applies (see lib/mittel · materialForSymbol). */
  symbol?: string
  /** true = consumable (used up → Nachschub list); false/absent = equipment that must come
   *  back (gets the per-line Retablierung status: zurück / vor Ort / defekt). */
  verbrauchbar?: boolean
}

/** One configured source a material can be drawn from (vehicle / depot / …). Optional on every
 *  Mittel entry; the picker offers exactly this list. Mirrors backend `MittelSource`. */
export interface DeploymentMittelSource {
  id: string
  label: string
}

export interface DeploymentMittel {
  /** station catalogue offered first in the `+ Mittel` picker */
  catalogue?: DeploymentMittelItem[]
  /** sources (vehicles/depot/…) offered when attributing a material to where it came from */
  sources?: DeploymentMittelSource[]
  /** common unit suggestions for custom («Anderes Mittel») entries; free text always allowed */
  units?: string[]
}

export interface DeploymentIntegrations {
  // env-derived flags — named *Configured (NOT *Enabled)
  diveraConfigured?: boolean
  traccarConfigured?: boolean
  /** STT engine reachable (env stt_base_url) — gates the player's Transkribieren button */
  sttConfigured?: boolean
  personnel?: ProviderCapability
  alarms?: ProviderCapability
  vehicles?: ProviderCapability
  providers?: ProviderRegistration[]
}

export interface ProviderCapability {
  provider?: string | null
  configured: boolean
  capabilities: string[]
}

export interface ProviderRegistration {
  provider: string
  domain: 'personnel' | 'alarms' | 'vehicles'
  configured: boolean
  active: boolean
  capabilities: string[]
}

/** Display label for a provider slug ('divera' → 'Divera'); the slug stays the wire format. */
export const providerLabel = (slug: string): string =>
  slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : slug

/** One configurable Objektplan module: its tile display + the importer's parsing rule.
 *  Mirrors backend `ModuleConfig`. The frontend uses only the display fields. */
export interface DeploymentModule {
  id: string
  code?: string
  title?: string
  subtitle?: string
  orientation?: 'portrait' | 'landscape'
  order?: number
  icon?: string
  match?: string | null
  combinedWith?: string[] | null
  family?: boolean
  /** render this module's PDF as a plain viewer (no drawing) — on a family it applies to all
   *  its sub-slots (e.g. all Modul 5 - PV documentation sheets) */
  viewer?: boolean
}

/** The national default Objektplan module catalogue — mirrors the backend's
 *  `DEFAULT_CONFIG['modules']` in `app/admin_config.py`. A deployment that doesn't override
 *  `modules` runs on exactly these, so the admin viewer shows them as the in-force catalogue
 *  ("die mitgelieferten Standard-Module") rather than an empty "nothing configured" state.
 *  Keep in sync with the backend list. */
export const DEFAULT_MODULES: DeploymentModule[] = [
  { id: 'modul1', code: 'M1', title: 'Übersicht', order: 1, orientation: 'portrait', match: String.raw`modul\s*1(?!\s*[-–/]\s*\d)` },
  { id: 'modul2', code: 'M2', title: 'Umgebung', order: 2, match: String.raw`modul\s*2(?!\s*[-–/]\s*\d)` },
  { id: 'modul3', code: 'M3', title: 'Objektplan', order: 3, match: String.raw`modul\s*3(?!\s*[-–/]\s*\d)` },
  { id: 'modul2-3', code: '2/3', title: 'Umgebung & Objekt', order: 4, match: String.raw`modul\s*2\s*[-–/]\s*3`, combinedWith: ['modul2', 'modul3'] },
  { id: 'modul6', code: 'M6', title: 'Gebäudepläne', order: 6, orientation: 'portrait', match: String.raw`modul\s*6` },
  { id: 'modul5', code: 'M5', title: 'Spezialpläne', order: 5, family: true, match: String.raw`modul\s*5(?:\s*[-–—]\s*([0-9A-Za-zÄÖÜäöü]+))?` },
  { id: 'modul4', code: 'M4', title: 'Spezialplan', order: 7, match: String.raw`modul\s*4` },
]

export interface DeploymentConfig {
  identity?: DeploymentIdentity
  map?: DeploymentMap
  referenceLayers?: DeploymentReferenceLayer[]
  modules?: DeploymentModule[]
  fleet?: DeploymentFleet
  doctrine?: DeploymentDoctrine
  roster?: DeploymentRoster
  mittel?: DeploymentMittel
  /** journal composer: station Textbausteine (quick phrases); empty → app defaults */
  journal?: { quickPhrases?: string[] | null }
  /** station alarm groups for the Alarmierungs-/Ausrückzeiten grid — empty hides it */
  alarms?: { groups?: AlarmGroup[] | null }
  /** Einsatzrapport form presets (Partnerorganisationen checkbox row) */
  report?: { partnerOrgs?: string[] | null }
  integrations?: DeploymentIntegrations
}

export interface AlarmGroup {
  id: string
  label: string
  /** display hint on paper/form ('Rot', 'Grün', …) */
  color?: string | null
  winfapAlias?: string | null
  /** marks the day-duty group (drives the derived Tagespikett flag) */
  tagespikett?: boolean
}

import { apiGet } from './api'
import { idbGet, idbSet } from './idb'
import { wgs84ToLV95, lv95ToWgs84 } from './geo'
import { appConfig } from '../config/appConfig'
import type { LayerDef, PlanDocument } from '../types'

const CACHE_KEY = 'kp-front-deployment-config'

// Module-level resolved singleton. Read sites call getDeploymentConfig() which returns
// this — it stays {} until loadDeploymentConfig() resolves at boot (before first render),
// so an early read is always safe (every field is optional → callers fall back to appConfig).
let resolved: DeploymentConfig = {}

function readCache(): Promise<DeploymentConfig | null> {
  return idbGet<DeploymentConfig>(CACHE_KEY).then((v) => (v && typeof v === 'object' ? v : null))
}

/**
 * Fetch the deployment override blob from the PUBLIC `/api/config`, cache it for offline,
 * and store it in the module singleton. NEVER throws — a failed fetch (offline, server down,
 * misconfigured) must never white-screen the app; it simply means unbranded appConfig
 * defaults. On a network error we fall back to the last cached value if present, else `{}`.
 */
export async function loadDeploymentConfig(): Promise<DeploymentConfig> {
  try {
    const cfg = await apiGet<DeploymentConfig>('/api/config')
    resolved = cfg && typeof cfg === 'object' ? cfg : {}
    void idbSet(CACHE_KEY, resolved) // durable copy for offline boot; in-memory singleton is enough this session
    return resolved
  } catch {
    // network / server failure — fall back to the cached value (offline tablets), else empty
    resolved = (await readCache()) ?? {}
    return resolved
  }
}

/** Synchronous accessor returning the resolved singleton ({} until loadDeploymentConfig
 *  resolves). The PRIMARY read path — config resolves before first render, so read sites
 *  do `getDeploymentConfig().X ?? appConfig.X`. */
export function getDeploymentConfig(): DeploymentConfig {
  return resolved
}

/**
 * Atemschutz doctrine numbers, resolved deployment override → appConfig national default.
 * THE read path for every doctrine number — read sites must not consult `appConfig.atemschutz`
 * directly for these (that skips the station's config). Call inside a component/function, not
 * at module level: a module-level capture would freeze the pre-boot empty config.
 */
export function atemschutzDoctrine() {
  const d = resolved.doctrine ?? {}
  const a = appConfig.atemschutz
  return {
    pressureStep: d.pressureStep ?? a.pressureStep,
    pressureMax: d.pressureMax ?? a.pressureMax,
    defaultPressureBar: d.defaultPressureBar ?? a.defaultPressureBar,
    mindestBar: d.mindestBar ?? a.mindestBar,
    contactIntervalMin: d.contactIntervalMin ?? a.contactIntervalMin,
    contactGraceSec: d.contactGraceSec ?? a.contactGraceSec,
    defaultFunkkanal: d.defaultFunkkanal ?? a.defaultFunkkanal,
    funkkanalMin: d.funkkanalMin ?? a.funkkanalMin,
    funkkanalMax: d.funkkanalMax ?? a.funkkanalMax,
  }
}

/**
 * The station's display name for brand lockups (login, boot splash, empty state).
 * Falls back to the product name when a deployment hasn't set its identity, so every
 * surface reads the same wordmark — never the code-default `appConfig.appName`.
 */
export function deploymentName(): string {
  return resolved.identity?.appName ?? 'KP Front'
}

/**
 * Compact-address display: strip a locality (the deployment's own town) from an address.
 * In a single-town deployment every list row repeats «Oberwil (BL), …» — pure noise; an
 * OUT-of-town address keeps its town and thereby stands out. Handles both source formats:
 * the Divera prefix («Oberwil (BL), Grenzweg 1») and the swisstopo suffix
 * («Grenzweg 3, 4104 Oberwil»). Pure — the config-bound wrapper is shortAddress below.
 */
export function stripLocality(address: string, locality: string | null | undefined): string {
  // locality config is free-form («4104 Oberwil BL», «Oberwil (BL)») — reduce to the town
  // name by dropping PLZ + canton tokens
  const town = (locality ?? '')
    .replace(/\([A-Z]{2}\)/g, '')
    .split(/[\s,]+/)
    .filter((t) => t && !/^\d{4,5}$/.test(t) && !/^[A-Z]{2}$/.test(t))
    .join(' ')
    .trim()
  if (!town) return address
  const t = town.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stripped = address
    .replace(new RegExp(`^${t}(\\s*\\([A-Z]{2}\\)|\\s+[A-Z]{2})?\\s*,\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*,?\\s*(\\d{4,5}\\s+)?${t}(\\s*\\([A-Z]{2}\\)|\\s+[A-Z]{2})?\\s*$`, 'i'), '')
    .trim()
  return stripped || address
}

/**
 * stripLocality against the deployment's configured home town (map.geocoder.defaultLocality).
 * For compact LIST rows and banners only — Einsatzdaten, Rapport, and the ReviewBanner's
 * address check keep the full address (formal record / verification surfaces).
 */
export function shortAddress(address: string | null | undefined): string | null {
  if (!address) return null
  return stripLocality(address, resolved.map?.geocoder?.defaultLocality)
}

/** True on demo deployments — drives the persistent DEMO ribbon. Off for real stations. */
export function isDemoMode(): boolean {
  return resolved.identity?.demoMode === true
}

/** Optional demo note (e.g. login credentials / reset cadence), shown on the login screen. */
export function demoNote(): string | null {
  const n = resolved.identity?.demoNote
  return n && n.trim() ? n : null
}

/**
 * The station's brand logo for the brand lockups (login, empty state). Falls back to the
 * bundled favicon when a deployment hasn't uploaded one, so every surface shows the same mark.
 */
export function deploymentLogo(): string {
  return resolved.identity?.assets?.logo ?? '/favicon.svg'
}

/**
 * The station's default map centre as WGS84 `[lng, lat]`, or null if unconfigured. Prefers
 * the WGS84 `center`; else converts LV95 `centerLv95` (the backend rejects both set). Used to
 * anchor surfaces that open without an incident yet — e.g. the intake map-picker — on the
 * brigade's own area instead of a neutral country-centroid fallback.
 */
export function deploymentDefaultCenter(): [number, number] | null {
  const dv = resolved.map?.defaultView
  if (dv?.center) return dv.center
  if (dv?.centerLv95) return lv95ToWgs84(dv.centerLv95[0], dv.centerLv95[1]) as [number, number]
  return null
}

/**
 * The per-station reference layers (hydrants, Leitungskataster, canton WMS, …) as renderable
 * `LayerDef`s, derived from the deployment config. These are STATION DATA — they live in the
 * config/reference store, never bundled in the repo — so `deriveInitial` appends them to the
 * built-in app layers (base maps + operational Lage layers). All start hidden; the operator
 * toggles them in the Ebenen panel. Empty when no station has loaded any (fresh OSS deploy).
 *
 * Two shapes (`kind`): a `geojson` layer carries a same-origin `geojson` URL (the reference
 * store, e.g. `/api/reference/geo:hydrant`, written by `admin_geodata load`); a `wms`/`wmts`
 * layer carries raster `tiles` template(s). Entries missing their required source are skipped.
 */
export function referenceLayersFromConfig(): LayerDef[] {
  return mapReferenceLayers(resolved.referenceLayers)
}

/** The station's configured Objektplan module tiles → `PlanDocument[]` (display only), sorted by
 *  `order`. Empty when `modules` is unconfigured (caller keeps the bundled catalog). Generative
 *  families (`family`) are skipped — their tiles are synthesized data-driven from the backend. */
export function modulesFromConfig(): PlanDocument[] {
  const mods = resolved.modules
  if (!Array.isArray(mods) || mods.length === 0) return []
  return mods
    .filter((m) => m.id && !m.family)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((m) => ({
      id: m.id,
      code: m.code ?? m.id,
      title: m.title ?? '',
      subtitle: m.subtitle ?? '',
      imageUrl: '',
      orientation: m.orientation ?? 'landscape',
      ...(m.icon ? { icon: m.icon } : {}),
      ...(m.viewer ? { viewer: true } : {}),
    }))
}

/** Whether a resolved plan slot is viewer-only (plain PDF, no drawing). Checks the exact module
 *  config, else a `family` module whose id is the slot's prefix (modul5 → modul5-pv). False when
 *  unconfigured. */
export function moduleViewer(id: string): boolean {
  const mods = resolved.modules
  if (!Array.isArray(mods)) return false
  const exact = mods.find((m) => m.id === id && !m.family)
  if (exact) return !!exact.viewer
  const family = mods.find((m) => m.family && (id === m.id || id.startsWith(`${m.id}-`)))
  return !!family?.viewer
}

/** Pure mapper (exported for tests): `DeploymentReferenceLayer[]` → `LayerDef[]`, skipping
 *  entries that lack an id or their required source (geojson URL / tile templates). */
export function mapReferenceLayers(refs: DeploymentReferenceLayer[] | undefined): LayerDef[] {
  if (!Array.isArray(refs)) return []
  return refs.flatMap((r): LayerDef[] => {
    if (!r || !r.id) return []
    const common = {
      id: r.id,
      group: r.group ?? 'Referenz',
      label: r.label ?? r.id,
      icon: r.icon ?? 'map',
      base: false,
      visible: false,
      opacity: r.opacity ?? 100,
      maxzoom: r.maxzoom ?? undefined,
      attribution: r.attribution ?? undefined,
      autoActivate: Array.isArray(r.autoActivate) && r.autoActivate.length ? r.autoActivate : undefined,
    }
    if (r.kind === 'geojson') {
      // Only a string (a same-origin URL) is renderable here; an inline object isn't supported.
      if (typeof r.geojson !== 'string' || !r.geojson) return []
      return [{
        ...common,
        geojson: r.geojson,
        vectorKind: r.vectorKind === 'point' ? 'point' : 'line',
        symbol: r.symbol ?? undefined,
        color: r.color ?? undefined,
        nightColor: r.nightColor ?? undefined,
      }]
    }
    // wms / wmts → raster overlay; needs at least one tile template
    if (Array.isArray(r.tiles) && r.tiles.length > 0) {
      return [{ ...common, tiles: r.tiles }]
    }
    return []
  })
}

/**
 * Apply the deployment's branding at boot (called once in main.tsx after loadDeploymentConfig).
 * Sets the document title and the --accent CSS custom property.
 *
 * --accent defaults to the brigade red (var(--red)) and currently drives only the
 * brand-identity surface (the login/splash pulse). The semantic palette (warn/danger
 * --red, selection --blue) is intentionally NOT brand-driven; broadening --accent into a
 * full brandable palette is a deliberate later (admin/branding) task, not Phase 1.
 */
export function applyDeploymentBranding(cfg: DeploymentConfig): void {
  const appName = cfg.identity?.appName
  if (appName) document.title = appName
  const accent = cfg.identity?.accentColor
  if (accent) document.documentElement.style.setProperty('--accent', accent)

  // Runtime favicon: point the document's <link rel="icon"> at the uploaded asset
  // (creating the link if the page has none). Null-safe — an unset favicon leaves the
  // build-time default in place.
  const favicon = cfg.identity?.assets?.favicon
  if (favicon) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = favicon
  }
}

/**
 * Station-supplied external map deep-links for the given incident coords (Datenquellen panel).
 * Each config entry's `urlTemplate` is filled with {E}/{N} (LV95) and {lng}/{lat} (WGS84).
 * Returns [] when no links are configured — so a generic deployment shows none.
 */
export function externalMapLinks(lng: number, lat: number): { label: string; href: string }[] {
  const links = resolved.map?.externalLinks
  if (!Array.isArray(links) || links.length === 0) return []
  const [e, n] = wgs84ToLV95(lng, lat)
  const fill = (t: string) =>
    t.replaceAll('{E}', e.toFixed(2)).replaceAll('{N}', n.toFixed(2))
      .replaceAll('{lng}', String(lng)).replaceAll('{lat}', String(lat))
  return links
    .filter((l): l is { label: string; urlTemplate: string } => !!l?.label && !!l?.urlTemplate)
    .map((l) => ({ label: l.label, href: fill(l.urlTemplate) }))
}
