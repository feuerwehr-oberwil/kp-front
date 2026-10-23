// A small per-incident value in Web Storage: what THIS DEVICE remembers about one Einsatz
// (lib/layerPrefs, lib/floorPrefs, lib/captureDraft's text drafts).
//
// The rule every user shares: one incident's value lives under its own key and never answers for
// another, and the store is best-effort throughout. A device with storage disabled, over quota or
// in private mode, or a stored value that is corrupt or foreign, reads as «never said» — the
// caller's default — and a write that fails is dropped. A preference or a draft must never stop
// the app; nothing here is operational state (that lives in IndexedDB, lib/idb).
//
// ⚠️ The key and the stored JSON are each user's on-device format: devices in the field hold them,
// so a change to either is a migration, not a refactor.

/** The three Web Storage methods a store touches — `localStorage`, `sessionStorage`, or a test's
 *  map. */
export interface PrefStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface IncidentPrefStore<T> {
  /** The stored value, or `undefined` when there is none, it cannot be read, or `parse` refused it. */
  read(incidentId: string): T | undefined
  /** Store `value` as JSON under this incident's key. */
  write(incidentId: string, value: Readonly<T>): void
  /** Forget this incident's value. */
  clear(incidentId: string): void
}

/**
 * A typed store over one key per incident. `parse` gets the JSON-parsed stored value and returns
 * it as a `T`, or `undefined` for anything it does not recognise. `storage` is read on every call
 * (and inside the guard), so a missing `localStorage` is a miss, not a crash; it defaults to
 * `localStorage`.
 *
 *   const store = incidentPrefStore({ key: (id) => `kp.floors.hidden.${id}`, parse: numbers })
 *   store.write('inc1', [2]); store.read('inc1') // → [2]; store.read('inc2') // → undefined
 */
export function incidentPrefStore<T>({ key, parse, storage = () => localStorage }: {
  key: (incidentId: string) => string
  parse: (stored: unknown) => T | undefined
  storage?: () => PrefStorage
}): IncidentPrefStore<T> {
  return {
    read(incidentId) {
      try {
        const raw = storage().getItem(key(incidentId))
        return raw ? parse(JSON.parse(raw)) : undefined
      } catch { return undefined }
    },
    write(incidentId, value) {
      try { storage().setItem(key(incidentId), JSON.stringify(value)) } catch { /* best-effort */ }
    },
    clear(incidentId) {
      try { storage().removeItem(key(incidentId)) } catch { /* best-effort */ }
    },
  }
}
