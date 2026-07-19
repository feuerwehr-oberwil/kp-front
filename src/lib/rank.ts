// Single source of truth for personnel ranks (Dienstgrade). The ordered rank list, labels,
// officer tiering, and free-text matching all resolve from per-station deployment config
// (roster.ranks), falling back to the in-code Swiss default so the app always has a usable
// list before/without config. Components must go through these helpers — never hard-code a
// rank list or officer check. Keep SWISS_DEFAULT_RANKS in sync with the backend default in
// backend/app/admin_config.py (EXAMPLE_CONFIG.roster.ranks).

import { getDeploymentConfig, type RankConfig } from './deploymentConfig'

export type RankTier = 'officer' | 'nco' | 'crew'

/** Generic Swiss militia fire-service ranks, most senior first. A station overrides this via
 *  deployment config (roster.ranks); exact membership is not load-bearing. */
export const SWISS_DEFAULT_RANKS: RankConfig[] = [
  { key: 'kdt', label: 'Kommandant', abbr: 'Kdt', tier: 'officer' },
  { key: 'maj', label: 'Major', abbr: 'Maj', tier: 'officer' },
  { key: 'hptm', label: 'Hauptmann', abbr: 'Hptm', tier: 'officer' },
  { key: 'oblt', label: 'Oberleutnant', abbr: 'Oblt', tier: 'officer' },
  { key: 'lt', label: 'Leutnant', abbr: 'Lt', tier: 'officer' },
  { key: 'fw', label: 'Feldweibel', abbr: 'Fw', tier: 'nco' },
  { key: 'wm', label: 'Wachtmeister', abbr: 'Wm', tier: 'nco' },
  { key: 'kpl', label: 'Korporal', abbr: 'Kpl', tier: 'nco' },
  { key: 'gfr', label: 'Gefreiter', abbr: 'Gfr', tier: 'crew' },
  { key: 'fwm', label: 'Feuerwehrmann', abbr: 'Fwm', tier: 'crew' },
]

/** The active rank list: per-station config override → in-code Swiss default. */
export function activeRanks(): RankConfig[] {
  const cfg = getDeploymentConfig().roster?.ranks
  return cfg && cfg.length ? cfg : SWISS_DEFAULT_RANKS
}

const byKey = (): Map<string, { rank: RankConfig; order: number }> => {
  const m = new Map<string, { rank: RankConfig; order: number }>()
  activeRanks().forEach((rank, order) => m.set(rank.key, { rank, order }))
  return m
}

/** Seniority order: index in the active list (most senior = 0). Unknown/absent → Infinity so
 *  the rankless sort last. */
export function rankOrder(key?: string): number {
  if (!key) return Infinity
  return byKey().get(key)?.order ?? Infinity
}

export function rankTier(key?: string): RankTier | undefined {
  return key ? byKey().get(key)?.rank.tier : undefined
}

export function isOfficer(key?: string): boolean {
  return rankTier(key) === 'officer'
}

/** Full label for a rank key ('' if unknown/absent). */
export function rankLabel(key?: string): string {
  return (key && byKey().get(key)?.rank.label) || ''
}

/** Short badge (abbr, falling back to label) for a rank key ('' if unknown/absent). */
export function rankAbbr(key?: string): string {
  const r = key ? byKey().get(key)?.rank : undefined
  return r ? r.abbr || r.label : ''
}

/** Lowercase, strip accents, collapse whitespace — mirrors backend normalize_name(). */
export function normalizeRank(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Map free-text (CSV cell / Divera field) onto a rank key by key/label/abbr, accent- and
 *  case-insensitively. Returns undefined when blank or unmatched. */
export function matchRank(text: string): string | undefined {
  const needle = normalizeRank(text || '')
  if (!needle) return undefined
  for (const r of activeRanks()) {
    if ([r.key, r.label, r.abbr].some((c) => c && normalizeRank(c) === needle)) return r.key
  }
  return undefined
}
