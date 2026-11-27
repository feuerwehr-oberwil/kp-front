import { useRef } from 'react'
import { useConfig } from './ConfigContext'

/** Per row object an editor wrote or holds: the stored original it stands for. Keyed by identity
 *  and kept outside the editor, so it outlives a remount (another Station section and back): the
 *  draft keeps the very objects the editor wrote, and the editor finds their originals again. */
const origins = new WeakMap<object, object>()
/** The originals whose repair the server has saved. */
const retired = new WeakSet<object>()

/**
 * What a list editor saves (Korrekturvorschlag fields, Formulare & Links, Objektfarben).
 * `writable` is the editor's own filter: the rows the server takes. A row it leaves out is held
 * back – a row being typed – unless the SERVER delivered it so: the server serves a stored row
 * past a bound as stored, and such a row stays in the save exactly as stored, also while the
 * admin's edit of it does not fit. An edit of another row therefore never drops it; the server
 * refuses the save instead (the autosave badge) until the admin fixes it.
 *
 * Only deleting the row, or a fitting edit of it that the server has SAVED, takes the stored
 * original out. Until that save is acknowledged, an edit that stops fitting again falls back to
 * the original; after it, the row is an ordinary one and a half-typed edit of it is held back.
 *
 * Stored = a row of `stored` (the list in the draft) when the first edit begins that `writable`
 * leaves out and `overCap` finds past a length bound; the editor never writes such a row itself,
 * so it came from the server. A stored row refused for another reason (a blank label the server
 * kept) is left out as before: keeping it could refuse a save the server takes. Pass every
 * row an edit replaces through `edited(before, after)`, which carries its stored original along,
 * and write `saved(rows, clean)`: `clean` shapes a written row (a trim), never a stored original.
 * `isStored(row)` tells the editor's warning which of its rows stands for such an original.
 */
export function useStoredRows<T extends object>(
  stored: readonly T[],
  writable: (rows: readonly T[]) => readonly T[],
  overCap: (row: T) => boolean,
) {
  const { save, dirty } = useConfig()
  const held = useRef<ReadonlySet<T> | null>(null)
  const heldIn = (list: readonly T[]): ReadonlySet<T> => {
    const ok = writable(list)
    return new Set(list.filter((r) => !ok.includes(r) && overCap(r)))
  }
  const heldRows = () => (held.current ??= heldIn(stored))
  const original = (row: T, heldNow: ReadonlySet<T> = heldRows()): T | undefined => {
    const o = heldNow.has(row) ? row : (origins.get(row) as T | undefined)
    return o && !retired.has(o) ? o : undefined
  }
  // before the first edit the held rows are not fixed yet: a render reads them from the draft
  // as it is, so a config that arrives after the first render still counts
  let heldPreview: ReadonlySet<T> | undefined
  /** Before each write: if the server took a save of the draft as it is now, every repair in that
   *  draft is stored, and its original retires. Checked here, at the next write, the only place
   *  where it matters. */
  const retire = () => {
    if (save.kind !== 'ok' || dirty) return
    for (const r of stored) {
      const o = origins.get(r)
      if (o) retired.add(o)
    }
  }

  return {
    /** Does `row` stand for a stored original past a bound – the row whose length refuses every
     *  save of the config, not only its own? The editor's warning says so. */
    isStored: (row: T): boolean =>
      original(row, held.current ?? (heldPreview ??= heldIn(stored))) !== undefined,
    edited: (before: T, after: T): T => {
      retire()
      const o = original(before)
      if (o) origins.set(after, o)
      return after
    },
    saved: (rows: readonly T[], clean: (row: T) => T = (row) => row): T[] => {
      retire()
      const ok = writable(rows)
      return rows.flatMap((r) => {
        const o = original(r)
        if (ok.includes(r)) {
          const out = clean(r)
          if (o) origins.set(out, o)
          return [out]
        }
        return o ? [o] : []
      })
    },
  }
}
