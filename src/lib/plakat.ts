import { newId } from './ids'
import type {
  BoardAnno, PlakatData, PlakatMassnahme, PlakatMittel, PlakatProblem, PlakatPunkt, PlakatTrend, PlakatVerbindung,
} from '../types'

/**
 * «Erstes Plakat (FKS)» — the «Erste Führung» A3 poster as a Tafel Vorlage (08.10.2026).
 *
 * ⚠️ ONE board anno of kind `plakat` on the Tafel, carrying every field (`BoardAnno.plakat`). That
 * is the whole persistence story, on purpose: the anno rides the board's own write path
 * (useBoardDoc · add / patchCommit), so inserting it is one ↶ step, every field edit is one ↶ step,
 * and it syncs, survives a reload and works offline exactly like a note on the same sheet. It has
 * no x/y/pts, so nothing positional (lasso, bake onto the Karte, projection, print overlay) ever
 * sees it. A merge is per object, so two devices editing the poster at once keep the later write.
 *
 * Pre-filled only from what the app already holds: the header from the Einsatz, the vehicles in
 * «Mittel», the wind as a SUGGESTION under «Spezialprobleme» (its tag says «Wetter»), and the FKS
 * Absprachepunkte as unticked rows. Everything else starts empty.
 */

/** The Tafel's plan id — the one sheet the Plakat lives on. */
export const TAFEL_ID = 'tafel'

export const PLAKAT_PROBLEM_SECTIONS = ['front', 'ordnung', 'sanitaet', 'spezial'] as const
export type PlakatProblemSection = typeof PLAKAT_PROBLEM_SECTIONS[number]
export type PlakatListKey = PlakatProblemSection | 'massnahmen' | 'mittel' | 'verbindungen' | 'absprachen'
export type PlakatRowOf<K extends PlakatListKey> = PlakatData[K][number]

/** What the Einsatz already knows, handed in by the workspace (no new integrations). */
export interface PlakatSeed {
  title: string
  address?: string | null
  /** «11:24» — already formatted by the caller */
  alarm?: string | null
  einsatzleiter?: string | null
  /** «Wind aus W 14 km/h» — already worded by the caller, absent without a reading */
  wind?: string | null
  /** vehicle names known to the Einsatz (Fahrzeugzeiten, vehicles on the Karte); deduplicated here */
  vehicles?: readonly string[]
}

const row = (prefix: string) => newId(prefix)

/** A fresh poster. `absprachen` = the FKS Absprachepunkte (copy), `weatherTag` = the tag the wind row wears. */
export function newPlakat(seed: PlakatSeed, absprachen: readonly string[], weatherTag: string): PlakatData {
  const seen = new Set<string>()
  const vehicles = (seed.vehicles ?? []).map((v) => v.trim()).filter((v) => {
    const k = v.toLowerCase()
    if (!v || seen.has(k)) return false
    seen.add(k)
    return true
  })
  return {
    v: 1,
    title: seed.title.trim(),
    address: seed.address?.trim() ?? '',
    alarm: seed.alarm?.trim() ?? '',
    el: seed.einsatzleiter?.trim() ?? '',
    front: [],
    ordnung: [],
    sanitaet: [],
    spezial: seed.wind?.trim() ? [{ id: row('pp'), text: seed.wind.trim(), note: weatherTag, trend: 'same' }] : [],
    massnahmen: [],
    mittel: vehicles.map((formation) => ({ id: row('pm'), formation, pers: '', wo: '' })),
    verbindungen: [],
    absprachen: absprachen.map((text) => ({ id: row('pa'), text })),
  }
}

const LISTS: readonly PlakatListKey[] = [...PLAKAT_PROBLEM_SECTIONS, 'massnahmen', 'mittel', 'verbindungen', 'absprachen']
const isRow = (r: unknown) => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string'

/** The shape gate for a synced poster (lib/workspace · isBoardAnno): every list an array of rows
 *  with an id, every header field a string. What fails is dropped, never rendered half. */
export function isPlakatData(v: unknown): v is PlakatData {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return (['title', 'address', 'alarm', 'el'] as const).every((k) => typeof d[k] === 'string')
    && LISTS.every((k) => Array.isArray(d[k]) && (d[k] as unknown[]).every(isRow))
}

/** The anno that carries a poster. */
export const plakatAnno = (data: PlakatData): BoardAnno => ({ id: newId('pk'), kind: 'plakat', plakat: data })

/** The poster on a sheet, if any (one per sheet — the Vorlage card only offers it on an empty one). */
export const findPlakat = (annos: readonly BoardAnno[]): (BoardAnno & { plakat: PlakatData }) | undefined =>
  annos.find((a): a is BoardAnno & { plakat: PlakatData } => a.kind === 'plakat' && !!a.plakat)

/** ➚ → = → ➘ → (none) → ➚ — one tap per step, the order the poster reads them. */
export function nextTrend(t: PlakatTrend | undefined): PlakatTrend | undefined {
  return t === undefined ? 'up' : t === 'up' ? 'same' : t === 'same' ? 'down' : undefined
}

/** The row's text fields — what decides whether a row is empty (a tick or a trend alone is not content). */
const TEXT: { [K in PlakatListKey]: (keyof PlakatRowOf<K>)[] } = {
  front: ['text', 'note'], ordnung: ['text', 'note'], sanitaet: ['text', 'note'], spezial: ['text', 'note'],
  massnahmen: ['was', 'wer', 'wann'],
  mittel: ['formation', 'pers', 'wo'],
  verbindungen: ['funktion', 'kanal', 'ruf'],
  absprachen: ['text'],
}
export const rowIsEmpty = <K extends PlakatListKey>(key: K, r: PlakatRowOf<K>): boolean =>
  TEXT[key].every((f) => !String((r as unknown as Record<string, unknown>)[f as string] ?? '').trim())

/** An empty row of a list — the trailing «new» row the form always offers. */
export function blankRow<K extends PlakatListKey>(key: K, id: string): PlakatRowOf<K> {
  switch (key) {
    case 'massnahmen': return { id, was: '', wer: '', wann: '' } satisfies PlakatMassnahme as PlakatRowOf<K>
    case 'mittel': return { id, formation: '', pers: '', wo: '' } satisfies PlakatMittel as PlakatRowOf<K>
    case 'verbindungen': return { id, funktion: '', kanal: '', ruf: '' } satisfies PlakatVerbindung as PlakatRowOf<K>
    case 'absprachen': return { id, text: '' } satisfies PlakatPunkt as PlakatRowOf<K>
    default: return { id, text: '' } satisfies PlakatProblem as PlakatRowOf<K>
  }
}

/**
 * Write one row: patch it when it exists, append it when it is the trailing new row, and drop it
 * when the patch left it without any text. Returns the SAME object when nothing changed, so the
 * caller can skip a no-op undo step.
 */
export function putRow<K extends PlakatListKey>(d: PlakatData, key: K, id: string, patch: Partial<PlakatRowOf<K>>): PlakatData {
  const list = d[key] as PlakatRowOf<K>[]
  const i = list.findIndex((r) => r.id === id)
  const before = i >= 0 ? list[i] : blankRow(key, id)
  const after = { ...before, ...patch } as PlakatRowOf<K>
  const same = Object.keys(after).every((k) => (after as unknown as Record<string, unknown>)[k] === (before as unknown as Record<string, unknown>)[k])
  if (same && i >= 0) return d
  const empty = rowIsEmpty(key, after)
  if (i < 0) return empty ? d : { ...d, [key]: [...list, after] }
  return { ...d, [key]: empty ? list.filter((r) => r.id !== id) : list.map((r) => (r.id === id ? after : r)) }
}

/** Anything written by a hand, beyond what the Vorlage put there itself? (asks before removing) */
export function plakatHasContent(d: PlakatData): boolean {
  if (d.front.length || d.ordnung.length || d.sanitaet.length || d.massnahmen.length || d.verbindungen.length) return true
  if (d.spezial.some((r) => !r.note) || d.spezial.length > 1) return true
  return d.absprachen.some((r) => r.done) || d.mittel.some((r) => r.pers.trim() || r.wo.trim())
}

/** The poster for the printed Rapport (backend · report_pdf · PlakatIn): only rows with text. */
export function plakatForPdf(d: PlakatData, arrows: Record<PlakatTrend, string>): Record<string, unknown> {
  const probs = (rs: PlakatProblem[]) => rs.map((r) => ({ text: r.text, note: r.note ?? '', trend: r.trend ? arrows[r.trend] : '' }))
  return {
    title: d.title, address: d.address, alarm: d.alarm, einsatzleiter: d.el,
    front: probs(d.front), ordnung: probs(d.ordnung), sanitaet: probs(d.sanitaet), spezial: probs(d.spezial),
    massnahmen: d.massnahmen.map((r) => ({ was: r.was, wer: r.wer, wann: r.wann, done: !!r.done })),
    mittel: d.mittel.map((r) => ({ formation: r.formation, pers: r.pers, wo: r.wo })),
    verbindungen: d.verbindungen.map((r) => ({ funktion: r.funktion, kanal: r.kanal, ruf: r.ruf })),
    absprachen: d.absprachen.map((r) => ({ text: r.text, done: !!r.done })),
  }
}
