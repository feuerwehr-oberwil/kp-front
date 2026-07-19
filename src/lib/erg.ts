import raw from '../data/erg.json'

/**
 * ERG 2024 response data (bundled, offline-first — no live API at 3am). Compiled by
 * tools/gen_erg.py from the public-domain PHMSA guidebook (see tools/erg-source/README.md
 * for provenance + verification). Everything here is a Planungshilfe with a visible source
 * label in the UI — the official guide pages stay one deep-link away.
 */

export interface ErgLargeSpill { li?: string; ld?: string; ln?: string }

export interface ErgTihRow {
  /** distinguishing label when a UN number carries several Table-1 rows */
  n?: string
  /** small spill: initial isolation, protective distance day / night (metric) */
  si?: string
  pd?: string
  pn?: string
  /** large spill: distances, or 'T3' (six common gases → ERG Table 3 by container/wind) */
  l?: ErgLargeSpill | 'T3'
}

export interface ErgEntry {
  /** orange-pages guide number */
  g?: number
  /** polymerization hazard ('P' guide suffix in the yellow pages) */
  p?: boolean
  /** Table-1 rows — present iff the material is TIH/PIH */
  tih?: ErgTihRow[]
}

interface ErgData { version: string; un: Record<string, ErgEntry> }

const data = raw as unknown as ErgData

export const ERG_VERSION = data.version

/** normalises '1017', 'UN 1017', '1017.0' → the dataset key */
export function lookupErg(un: string): ErgEntry | null {
  const key = un.replace(/\D/g, '')
  if (!key) return null
  return data.un[key] ?? null
}

/** a material is TIH/PIH (toxic-inhalation hazard) iff it appears in Table 1 */
export const isTih = (e: ErgEntry | null): boolean => !!e?.tih?.length
