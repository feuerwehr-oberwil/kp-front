import { createStaticDataset } from './staticData'

/**
 * ERG 2024 response data (shipped with the app, offline-first — no live API at 3am).
 * Compiled by tools/gen_erg.py from the public-domain PHMSA guidebook (see
 * tools/erg-source/README.md for provenance + verification). Everything here is a
 * Planungshilfe with a visible source label in the UI — the official guide pages stay one
 * deep-link away.
 *
 * The data rides as a static asset (public/erg.json, service-worker-precached) loaded via
 * lib/staticData like the ADR table (lib/unHazard): lookups miss until the boot prefetch
 * lands, and surfaces re-render on arrival through lib/useHazardData.
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

export interface ErgData { version: string; un: Record<string, ErgEntry> }

const ds = createStaticDataset<ErgData>('erg.json')

/** Kick (or await) the dataset load — boot prefetch and the print path call this. */
export async function ensureErg(): Promise<void> { await ds.ensure() }
/** For lib/useHazardData (useSyncExternalStore). */
export const subscribeErg = ds.subscribe
export const ergVersion = ds.version
/** Tests only: inject the dataset synchronously instead of fetching. */
export function __setErgData(data: ErgData): void { ds.set(data) }

/** The guidebook edition for the source label (e.g. "2024"); '' until the data lands. */
export function ergVersionLabel(): string {
  return ds.get()?.version ?? ''
}

/** normalises '1017', 'UN 1017', '1017.0' → the dataset key.
 *  Null for unknown numbers — and while the dataset is still loading. */
export function lookupErg(un: string): ErgEntry | null {
  const key = un.replace(/\D/g, '')
  if (!key) return null
  return ds.get()?.un[key] ?? null
}
