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

/** Global tactical-symbol size on both surfaces (map + plan). A personal legibility
 *  preference like `theme` — the symbol size band (lib/mapView · symPx) and the plan
 *  base size are multiplied by this. Default 'M'. */
export type SymbolSize = 'S' | 'M' | 'L'

export interface Prefs {
  mode?: 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel'
  activePlanId?: string
  /** last active incident id, so a reload reopens it */
  incidentId?: string
  /** LEGACY: the manually-picked Einsatzobjekt now lives in the synced workspace blob
   *  (Saved.pickedObjectId), per incident + shared across devices. Kept only so deriveInitial
   *  can one-time import an in-flight cookie pick on upgrade; cleared at boot afterwards. */
  pickedObject?: { incidentId: string; objectId: string }
  /** UI colour scheme — see ThemeMode. Default 'auto' (daylight-driven). */
  theme?: ThemeMode
  /** global tactical-symbol size — see SymbolSize. Default 'M'. */
  symbolSize?: SymbolSize
  /** on-canvas symbol captions (metadata printed under each glyph) — a personal legibility
   *  preference like `symbolSize`. Default falls to appConfig.symbols.captionDefault ('auto'). */
  symbolCaptions?: CaptionMode
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
  /** Einsatzleiter-Ansicht: tactical editing locked on this device (journal capture and
   *  read-only symbol details stay live). Unset = follow the login's server-side default
   *  (AuthUser.el_view_default); an explicit toggle here overrides it. Editors only. */
  elView?: boolean
  /** what the top Einsatzuhr shows — tap it to cycle. Default 'elapsed' (running duration). */
  clockMode?: 'elapsed' | 'now' | 'start'
}

/** The multiplier the S/M/L preference applies to every tactical symbol's size on
 *  both surfaces. M (1×) is the tuned default; S/L step it ±. */
export const symbolMul = (size: SymbolSize | undefined): number =>
  size === 'S' ? 0.8 : size === 'L' ? 1.3 : 1

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
}

/** Resolve a ThemeMode to the concrete scheme to apply: explicit modes pass through,
 *  'auto' (and any legacy/absent value) resolves from daylight at `coord` (or the
 *  brigade region when no incident coordinate is known yet). */
export function resolveTheme(mode: ThemeMode | undefined, coord: Coord | null, now: Date): 'day' | 'night' {
  if (mode === 'day' || mode === 'night') return mode
  return isDaytime(coord, now) ? 'day' : 'night'
}
