// Small cookie-backed UI preferences — remembers which surface (Lage / Plan) and
// which plan document the user was last on, so a reload returns them there.
// Cookie (not localStorage) by request; it's a tiny, non-sensitive, functional
// preference so it needs no consent banner.

import type { CaptionMode } from '../types'
import { isDaytime, type Coord } from './daylight'

const COOKIE = 'kp-front-prefs'
const MAX_AGE = 60 * 60 * 24 * 365 // 1 year

/** UI colour-scheme preference. 'auto' (the default) tracks local daylight so the app
 *  dims itself after dusk on its own; 'day'/'night' are explicit manual overrides. */
export type ThemeMode = 'auto' | 'day' | 'night'

/** Rail labelling: glyphs only, or the word stacked under each glyph. */
export type RailLabels = 'off' | 'short'

/** LEGACY: one global tactical-symbol size for BOTH surfaces. Superseded by the per-surface
 *  multipliers below (`symbolScaleMap` / `symbolScaleBoard`) — one size could not serve both:
 *  on a Modul-2/3 sheet even 'S' was still too big, on the map 'L' was already too big.
 *  Read only to migrate an older cookie (see symbolScales); never written any more. */
export type SymbolSize = 'S' | 'M' | 'L'

/** The two surfaces that size tactical symbols independently: the Lage map and the
 *  Plan/Modul boards. A personal legibility preference like `theme`, so it stays a DEVICE
 *  pref — the tablet at the Kommandoposten and the phone in a pocket want different sizes,
 *  and neither may impose one on the other through the synced workspace. */
export type SymbolSurface = 'map' | 'board'

/** Bounds of one Symbolgrösse slider (multipliers, 1 = the tuned default). */
export interface SymbolScaleRange { min: number; max: number; step: number; default: number }

export interface Prefs {
  mode?: 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel' | 'rapport'
  activePlanId?: string
  /** last active incident id, so a reload reopens it */
  incidentId?: string
  /** when `incidentId` was chosen BY HAND (epoch ms). A boot auto-open does not stamp it, so it
   *  answers exactly one question: had the operator already decided, at the time this alarm
   *  arrived? An alarm older than that decision must not override it (lib/incidentAlerts ·
   *  pickBootIncident). */
  incidentChosenAt?: number
  /** LEGACY: the manually-picked Einsatzobjekt now lives in the synced workspace blob
   *  (Saved.pickedObjectId), per incident + shared across devices. Kept only so deriveInitial
   *  can one-time import an in-flight cookie pick on upgrade; cleared at boot afterwards. */
  pickedObject?: { incidentId: string; objectId: string }
  /** REMOVED — the Anwesenheit tab now lives in sessionStorage, stamped with the incident (see
   *  AnwesenheitView · TAB_KEY). Coming back to your tab across a reload is worth keeping; a
   *  choice made last week deciding where a fresh launch lands is not, and it must not follow
   *  you into the next Einsatz. Left documented rather than silently dropped: a stale cookie
   *  from an older build may still carry the field, and it is simply ignored. */
  /** hours of axis the Zeitplan shows at once (the Zeitraum control) */
  zeitplanHorizonH?: number
  /** UI colour scheme — see ThemeMode. Default 'auto' (daylight-driven). */
  theme?: ThemeMode
  /** LEGACY global tactical-symbol size — see SymbolSize. Kept (and never deleted) so a cookie
   *  written by an older build still resolves to the size its owner picked, and so rolling that
   *  build back finds what it wrote. Migration is lazy: see symbolScales. */
  symbolSize?: SymbolSize
  /** tactical-symbol size on the Lage map — a multiplier on the symPx band (lib/mapView · symPx).
   *  Absent → migrated from `symbolSize`, else 1. See SYMBOL_SCALE for the band. */
  symbolScaleMap?: number
  /** tactical-symbol size on the Plan/Modul boards — a multiplier on the plan symbol base
   *  (components/Whiteboard · symBase). Absent → migrated from `symbolSize`, else 1. */
  symbolScaleBoard?: number
  /** on-canvas symbol captions (metadata printed under each glyph) — a personal legibility
   *  preference like `symbolSize`. Default falls to appConfig.symbols.captionDefault ('auto'). */
  symbolCaptions?: CaptionMode
  /** Words under the glyphs in both rails. Off by default — the icons ARE the rail for anybody who
   *  uses this app regularly, and the labels cost 10px of map for good.
   *  ⚠️ Not the same thing as the rails' expand chevron: that one widens the rail and puts the word
   *  BESIDE the glyph, and it is a transient state (nothing remembers it). This is a device
   *  preference and stacks the word UNDER the glyph, which is what a first-timer needs on a rail
   *  of seven surfaces and nine tools with no words at all. Default 'off'. */
  railLabels?: RailLabels
  /** radius (metres) of the box cached around the incident by "Alles für offline laden".
   *  Device pref — each device decides how much to store. Default 1200. */
  offlineRadiusM?: number
  /** keep the screen awake (Screen Wake Lock) while an incident is open. Default true — a
   *  command tablet at the scene must not dim mid-operation — but a personal device idling in the
   *  background may prefer to let the screen sleep, so it's a per-device toggle. */
  keepScreenOn?: boolean
  /** last Verwaltung (admin) section id, so reopening /admin returns to the same page.
   *  Kept loose (string) so prefs.ts doesn't depend on the admin's SectionId union. */
  adminSection?: string
  /** Führungsansicht: tactical editing locked on this device (journal capture and
   *  read-only symbol details stay live). Unset = follow the login's server-side default
   *  (AuthUser.el_view_default); an explicit toggle here overrides it. Editors only. */
  elView?: boolean
  /** what the top Einsatzuhr shows — tap it to cycle. Default 'elapsed' (running duration). */
  clockMode?: 'elapsed' | 'now' | 'start'
  /** How the Atemschutz board is ordered. Default 'manuell' — «wie gesetzt», the hand-set order,
   *  so a card keeps its slot and «Trupp 2 is the second one» stays true for the whole Einsatz.
   *  A device pref because it is a way of LOOKING at the board; the hand-set order itself is
   *  synced (Trupp.order), so «wie gesetzt» shows the same thing on every device.
   *  ⚠️ Whatever is chosen, an überfälliger Trupp still floats to the top — a card that can hide
   *  off-screen is the one failure mode this screen exists to prevent. */
  atemschutzOrder?: 'dringlichkeit' | 'manuell' | 'auftrag' | 'name'
  /** Standort teilen — this device's standing PERMISSION to use its position for it, plus
   *  who it reports as. A DEVICE preference by design: it is the phone's owner deciding about
   *  their own phone, so it must not ride the synced workspace where another editor could
   *  flip it.
   *
   *  Deliberately NOT "currently sharing". Sharing is an act, switched on per Einsatz from the
   *  compass menu and off again when that Einsatz ends — so nobody's phone starts broadcasting
   *  because of something they agreed to months ago. */
  sharePosition?: SharePositionPref
  /** Georeferenz twin layers that have been switched OFF on this device, keyed by their Ebenen
   *  row id (lib/georefTwins · twinPlanLayerId / TWIN_MAP_*). Absent or `true` = shown, which is
   *  the default: a georeference exists because somebody deliberately made one, and seeing both
   *  pictures at once is what they made it for.
   *
   *  A DEVICE pref, exactly like the map's own layer visibility — that rides the workspace blob
   *  but `mergeWorkspace` keeps `layerState` local, so «which layers am I looking at» has never
   *  been something one device imposes on another. Same rule, kept in the same place a twin row
   *  can actually reach: the plan ids are per object and would have no home in the fixed
   *  `LayerDef` list `layerState` is reconciled against (lib/workspace · deriveInitial). */
  twinLayers?: Record<string, boolean>
  /** Transparency (0..100) of opt-in georeferenced plan rasters on the Lage map. */
  twinLayerOpacity?: Record<string, number>
}

export interface SharePositionPref {
  /** the device may use its position for this. false = revoked (or never granted). */
  allowed: boolean
  /** roster person id this device reports as — the name its holder picked */
  personId?: string
  /** display name at the time of picking; shown in the UI so the control can say who you would
   *  be sharing as without waiting for the roster to load */
  displayName?: string
  /** the Einsatz whose holder confirmed «das bin ich» on this device. The name above is
   *  remembered for convenience, the CONFIRMATION is not: a device only reports under a name
   *  for the Einsatz it was confirmed for, so the shared Tablet cannot carry the last
   *  Einsatz's name into the next one. Persisted (not session state) so re-opening the same
   *  Einsatz does not ask again. */
  confirmedIncidentId?: string
  /** opaque random id for this device, so the backend can tell two phones apart (and refuse
   *  a second one claiming a name that is actively sharing). Never a device fingerprint. */
  deviceId?: string
}

/** Bounds for the two Symbolgrösse sliders.
 *
 *  Derived from the S/M/L multipliers they replace (S 0.6 · M 1 · L 1.3), so nothing anyone had
 *  set becomes unreachable and 1 — the tuned default — stays the exact midpoint of both sliders.
 *
 *  The two bands differ on purpose, because the surfaces are not the same problem:
 *   • Karte: a symbol sits on a house and competes with the map under it. 'L' (1.3) was already
 *     at the edge of too big, so the ceiling only goes a touch past it and the floor keeps the
 *     old 'S'.
 *   • Module: a Modul-2/3 sheet is a whole floor on one page. Even 'S' (0.6) was still a symbol
 *     you place two of before they touch — the complaint this rework exists for — so the floor
 *     drops well below it, and the ceiling rises to match for a Modul-1 Übersicht read from
 *     across the room.
 *
 *  0.05 steps: fine enough that the slider feels continuous under a thumb, coarse enough that
 *  two devices set «by eye» land on the same number. */
export const SYMBOL_SCALE: Record<SymbolSurface, SymbolScaleRange> = {
  map: { min: 0.6, max: 1.4, step: 0.05, default: 1 },
  // 0.2 is deliberately two thirds of the previous floor: on dense Modul sheets 0.3 still
  // made neighbouring FKS glyphs overlap before their anchors were meaningfully distinct.
  board: { min: 0.2, max: 1.8, step: 0.05, default: 1 },
}

/** Snap a multiplier onto its surface's slider band. Anything unusable — a hand-edited cookie,
 *  a value from a build with different bounds — falls back to that surface's default rather
 *  than rendering symbols at 0× or 40×. */
export const clampSymbolScale = (surface: SymbolSurface, n: number | undefined): number => {
  const r = SYMBOL_SCALE[surface]
  if (typeof n !== 'number' || !Number.isFinite(n)) return r.default
  const snapped = Math.round(n / r.step) * r.step
  // …and back off the binary-float dust 0.05 steps leave behind (0.7000000000000001)
  return Math.min(r.max, Math.max(r.min, Math.round(snapped * 100) / 100))
}

/** LEGACY S/M/L → multiplier, for migration only (see symbolScales).
 *  ⚠️ S is 0.6, not the 0.8 it was until 17.08. */
export const legacySymbolMul = (size: SymbolSize | undefined): number =>
  size === 'S' ? 0.6 : size === 'L' ? 1.3 : 1

/** The multipliers this device sizes tactical symbols with, per surface.
 *
 *  Migration is LAZY and LOSSLESS: a cookie that still carries only the old global `symbolSize`
 *  resolves to that size's multiplier on BOTH surfaces, so a device keeps exactly the size it
 *  had until somebody moves a slider. Nothing rewrites the cookie to achieve it and the old key
 *  is never deleted — a rolled-back build still finds what it wrote. */
export function symbolScales(p: Prefs): Record<SymbolSurface, number> {
  const legacy = p.symbolSize ? legacySymbolMul(p.symbolSize) : undefined
  return {
    map: clampSymbolScale('map', p.symbolScaleMap ?? legacy),
    board: clampSymbolScale('board', p.symbolScaleBoard ?? legacy),
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null
}

export function loadPrefs(): Prefs {
  try {
    const raw = readCookie(COOKIE)
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

export function savePrefs(prefs: Prefs) {
  try {
    const value = encodeURIComponent(JSON.stringify(prefs))
    document.cookie = `${COOKIE}=${value}; path=/; max-age=${MAX_AGE}; samesite=lax`
  } catch { /* ignore */ }
}

// theme-color for the browser/PWA chrome, matched to each scheme's app background.
// Day mirrors the original index.html value; night uses the dark canvas backdrop.
const THEME_COLOR: Record<'day' | 'night', string> = {
  day: '#eef3f7',
  night: '#0d1118',
}

/**
 * Apply a colour scheme: flips the `<html data-theme>` attribute (CSS tokens key
 * off it) and updates `<meta name="theme-color">` so the system browser bar matches.
 * Pure DOM side-effects — does not persist; callers persist via savePrefs.
 */
export function applyTheme(theme: 'day' | 'night') {
  if (theme === 'night') document.documentElement.dataset.theme = 'night'
  else delete document.documentElement.dataset.theme // 'day' is the default :root
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', THEME_COLOR[theme])
  // Leave the resolved scheme where the next cold start can read it synchronously: the inline
  // boot script in index.html paints the splash before any of this module exists, and 'auto'
  // (the default) needs a daylight computation it cannot do. localStorage, not the prefs cookie,
  // because this is a derived boot hint rather than a user preference — and because the boot
  // script must read it without parsing JSON. Best-effort: private mode may refuse.
  try { localStorage.setItem('kp.theme.boot', theme) } catch { /* boot falls back to the OS */ }
}

/** Resolve a ThemeMode to the concrete scheme to apply: explicit modes pass through,
 *  'auto' (and any legacy/absent value) resolves from daylight at `coord` (or the
 *  brigade region when no incident coordinate is known yet). */
export function resolveTheme(mode: ThemeMode | undefined, coord: Coord | null, now: Date): 'day' | 'night' {
  if (mode === 'day' || mode === 'night') return mode
  return isDaytime(coord, now) ? 'day' : 'night'
}
