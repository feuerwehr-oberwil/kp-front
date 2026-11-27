import { useEffect, useRef } from 'react'
import { useConfig } from './ConfigContext'

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
 */
export function useStoredRows<T extends object>(
  stored: readonly T[],
  writable: (rows: readonly T[]) => readonly T[],
  overCap: (row: T) => boolean,
) {
  const { save, dirty } = useConfig()
  const held = useRef<ReadonlySet<T> | null>(null)
  const origin = useRef(new WeakMap<T, T>())
  /** stored original → the last fitting version written for it, as the draft holds it (JSON) */
  const written = useRef(new Map<T, string>())
  const retired = useRef(new Set<T>())
  const heldRows = () => {
    if (!held.current) {
      const ok = writable(stored)
      held.current = new Set(stored.filter((r) => !ok.includes(r) && overCap(r)))
    }
    return held.current
  }
  const original = (row: T) => {
    const o = heldRows().has(row) ? row : origin.current.get(row)
    return o && !retired.current.has(o) ? o : undefined
  }

  // A save the server took with the draft as it is now: every repair it carries is stored.
  useEffect(() => {
    if (save.kind !== 'ok' || dirty) return
    const now = new Set(stored.map((r) => JSON.stringify(r)))
    for (const [o, json] of written.current) {
      if (now.has(json)) { retired.current.add(o); written.current.delete(o) }
    }
  }, [save, dirty, stored])

  return {
    edited: (before: T, after: T): T => {
      const o = original(before)
      if (o) origin.current.set(after, o)
      return after
    },
    saved: (rows: readonly T[], clean: (row: T) => T = (row) => row): T[] => {
      const ok = writable(rows)
      return rows.flatMap((r) => {
        const o = original(r)
        if (ok.includes(r)) {
          const out = clean(r)
          if (o) written.current.set(o, JSON.stringify(out))
          return [out]
        }
        return o ? [o] : []
      })
    },
  }
}
