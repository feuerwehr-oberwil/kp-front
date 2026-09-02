// A least-recently-used cache of promised values, bounded by BYTES rather than by count.
//
// Written for the baked plan bitmaps (components/PdfViewport). A count cap says nothing about
// memory when one entry is a 640 px preview (~2 MB) and the next a stitched A4 plan at 3840 px on
// an iPad (~83 MB): twelve of the latter is close to a gigabyte, allocated in the background,
// and the tab is jetsammed before the Plan tab was ever opened. Sizing by what each entry
// actually weighs keeps the same cache honest on a phone (small budget) and a tablet (larger).

interface Entry<T> { promise: Promise<T>; bytes: number }

/**
 * `budget()` is read at every eviction, so a caller can answer it from the live viewport
 * (a phone gets less than a tablet); `sizeOf(value)` weighs a resolved value in bytes.
 *
 * A pending promise weighs nothing until it resolves — its bytes are counted (and the cache
 * trimmed) the moment it does. A rejected promise drops out on its own, so a failed load is
 * retried on the next `get`, never replayed from the cache.
 */
export class ByteBudgetCache<T> {
  private readonly entries = new Map<string, Entry<T>>()

  constructor(
    private readonly budget: () => number,
    private readonly sizeOf: (value: T) => number,
  ) {}

  /** Bytes of every RESOLVED entry currently held. */
  get bytes(): number {
    let n = 0
    for (const e of this.entries.values()) n += e.bytes
    return n
  }

  get size(): number { return this.entries.size }

  has(key: string): boolean { return this.entries.has(key) }

  /** Read AND touch — the entry becomes the most recently used one. */
  get(key: string): Promise<T> | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    this.entries.delete(key)
    this.entries.set(key, e)
    return e.promise
  }

  /** Store (or replace) an entry as the most recently used one. */
  set(key: string, promise: Promise<T>): void {
    const entry: Entry<T> = { promise, bytes: 0 }
    this.entries.delete(key)
    this.entries.set(key, entry)
    promise.then(
      (value) => {
        if (this.entries.get(key) !== entry) return // replaced or evicted while pending
        entry.bytes = this.sizeOf(value)
        this.evict()
      },
      () => { if (this.entries.get(key) === entry) this.entries.delete(key) },
    )
  }

  delete(key: string): boolean { return this.entries.delete(key) }

  /**
   * Drop the least recently used RESOLVED entries until the held bytes fit the budget. The most
   * recently used entry is never dropped, even when it alone exceeds the budget — it is the one
   * being drawn. Pending entries are skipped: forgetting a promise frees nothing.
   */
  evict(): void {
    const budget = this.budget()
    while (this.bytes > budget) {
      let victim: string | undefined
      const keys = [...this.entries.keys()]
      for (const k of keys.slice(0, -1)) {
        if (this.entries.get(k)!.bytes > 0) { victim = k; break }
      }
      if (victim === undefined) return
      this.entries.delete(victim)
    }
  }
}
