/*
 * A Web Lock request rejected before a grant must not immediately requeue: an inactive
 * document can reject forever and prevent navigation. Requeue only after a held lock is lost,
 * and ignore grants that arrive after the owner stopped.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Per-incident single-editor tab lock (Web Locks API).
 *
 * Two tabs of the SAME browser editing one incident race the shared IndexedDB sync cache —
 * each holds its own in-memory baseRev, so they 409-thrash and can clobber each other's
 * cache writes. Cross-DEVICE editing is fine (that's what the server merge is for); this is
 * strictly about tabs sharing one origin's storage.
 *
 * Model: the first tab on an incident holds `kp-front-incident-<id>` and edits. A later tab
 * fails the try-acquire, goes read-only (banner in the UI), and queues — when the holder
 * closes, the waiter is promoted to editing automatically. "Hier bearbeiten" steals the lock
 * the other way (the previous holder drops to read-only), so moving editing between tabs is
 * one tap. The same answers gate this tab's writers for the Einsatz (TabLockAnswers): a tab
 * that does not hold the lock writes nothing (docs/sync-and-offline.md › Two tabs).
 *
 * Browsers without Web Locks (none of our supported targets) just keep today's behaviour.
 */

type LocksAPI = Pick<LockManager, 'request'>

function defaultLocks(): LocksAPI | null {
  return typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null
}

/** How long a write waits for this tab's first lock answer before it goes as if the tab held the
 *  lock. The try-acquire answers in milliseconds once the Einsatz is on screen; the bound only
 *  covers a lock that never answers, so a lone tab is never held up for longer than this. */
export const TAB_LOCK_ANSWER_MS = 1_000

/** The lock name of Einsatz `id` – one per Einsatz, shared by every tab of the browser. */
export const incidentLockName = (id: string) => `kp-front-incident-${id}`

/**
 * This tab's edit-lock answers per Einsatz, for the writers that must not write behind another tab
 * (WorkspaceSync, useMediaQueue – docs/sync-and-offline.md › Two tabs). One per tab: the module's
 * `tabLockAnswers`, written by IncidentTabLock; a test makes one per simulated tab.
 */
export class TabLockAnswers {
  private answers = new Map<string, boolean>()
  private listeners = new Map<string, Set<(held: boolean) => void>>()

  /** true – this tab holds the lock (or there are no Web Locks, or the first answer is overdue);
   *  false – another tab holds it; undefined – not answered yet. */
  get(id: string): boolean | undefined {
    if (!defaultLocks()) return true
    return this.answers.get(incidentLockName(id))
  }

  /** Hear every later answer for Einsatz `id`. Returns the unsubscribe. */
  on(id: string, listener: (held: boolean) => void): () => void {
    const name = incidentLockName(id)
    const set = this.listeners.get(name) ?? new Set()
    this.listeners.set(name, set)
    set.add(listener)
    return () => { set.delete(listener) }
  }

  /** Resolves once Einsatz `id` has an answer – at the latest after TAB_LOCK_ANSWER_MS, which then
   *  counts as «held». */
  answered(id: string): Promise<void> {
    if (this.get(id) !== undefined) return Promise.resolve()
    return new Promise((resolve) => {
      const off = this.on(id, () => { clearTimeout(timer); off(); resolve() })
      const timer = setTimeout(() => {
        off()
        if (this.get(id) === undefined) this.answers.set(incidentLockName(id), true)
        resolve()
      }, TAB_LOCK_ANSWER_MS)
    })
  }

  /** May this tab write for Einsatz `id`? false once another tab holds it; before the first
   *  answer, the (bounded) wait for it. */
  mayWrite(id: string): boolean | Promise<boolean> {
    const now = this.get(id)
    if (now !== undefined) return now
    return this.answered(id).then(() => this.get(id) !== false)
  }

  /** IncidentTabLock's side: the lock `name` answered (or, `held` undefined, stopped asking). */
  set(name: string, held: boolean | undefined): void {
    if (held === undefined) { this.answers.delete(name); return }
    this.answers.set(name, held)
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(held)
  }
}

export const tabLockAnswers = new TabLockAnswers()

export class IncidentTabLock {
  private release: (() => void) | null = null
  private abort: AbortController | null = null
  private stopped = false
  private generation = 0

  constructor(
    private readonly name: string,
    /** fired on every editable/read-only transition of THIS tab */
    private readonly onChange: (held: boolean) => void,
    private readonly locks: LocksAPI | null = defaultLocks(),
    /** where the writers read this tab's answer – only a real answer is written: a request that
     *  rejects before any grant says nothing, and the writers go on as without Web Locks */
    private readonly answers: TabLockAnswers = tabLockAnswers,
  ) {}

  start(): void {
    if (this.stopped) return
    if (!this.locks) {
      this.onChange(true) // no Web Locks → no coordination, behave as before
      return
    }
    void this.acquire(true)
  }

  /** resolves when stop()/switch releases the held lock */
  private hold(): Promise<void> {
    return new Promise((res) => { this.release = res })
  }

  private async acquire(tryFirst: boolean): Promise<void> {
    if (this.stopped || !this.locks) return
    const generation = ++this.generation
    const current = () => !this.stopped && generation === this.generation
    let granted = false
    this.abort = new AbortController()
    try {
      if (tryFirst) {
        let got = false
        await this.locks.request(this.name, { ifAvailable: true }, async (lock) => {
          if (!lock || !current()) return // another tab holds it, or this request ended
          got = true
          granted = true
          this.answers.set(this.name, true)
          this.onChange(true)
          await this.hold()
        })
        if (got || !current()) return
        this.answers.set(this.name, false) // another tab holds it
        this.onChange(false)
      }
      // queue behind the current holder — granted (→ editing) when that tab goes away
      await this.locks.request(this.name, { signal: this.abort.signal }, async () => {
        if (!current()) return
        granted = true
        this.answers.set(this.name, true)
        this.onChange(true)
        await this.hold()
      })
    } catch {
      if (!current()) return
      if (granted) this.answers.set(this.name, false) // stolen by another tab
      this.onChange(false)
      // A stolen holder may queue again. An ungranted rejection must stop: WebKit rejects
      // requests from a departing document, and immediate retries freeze navigation.
      if (granted) void this.acquire(false)
    }
  }

  /** Move editing into THIS tab (the current holder drops to read-only). */
  takeOver(): void {
    if (!this.locks || this.stopped) return
    const generation = ++this.generation
    const current = () => !this.stopped && generation === this.generation
    let granted = false
    this.abort?.abort() // leave the waiting queue; the steal below replaces it
    void this.locks
      .request(this.name, { steal: true }, async () => {
        if (!current()) return
        granted = true
        this.answers.set(this.name, true)
        this.onChange(true)
        await this.hold()
      })
      .catch(() => {
        if (!current()) return
        if (granted) this.answers.set(this.name, false)
        this.onChange(false)
        if (granted) void this.acquire(false) // stolen back → wait in line again
      })
  }

  stop(): void {
    this.stopped = true
    this.answers.set(this.name, undefined)
    this.generation++
    this.abort?.abort()
    this.release?.()
    this.release = null
  }
}

/** React binding: editable-here state + take-over action for the active incident.
 *  `heldAtOpen`: the lock's FIRST answer for this incident — true when this tab got it at once
 *  (or there are no Web Locks), false when it opened behind another tab, null until it answers.
 *  `held` alone cannot say it: it starts true optimistically.
 *  `onHeld`: called with the incident each time this tab is granted the lock – where the App
 *  reopens an Einsatz whose engine followed another tab (docs/sync-and-offline.md › Two tabs). */
export function useIncidentTabLock(incidentId: string | null, onHeld?: (incidentId: string) => void): { held: boolean; heldAtOpen: boolean | null; takeOver: () => void } {
  // starts true so the common single-tab case never flashes the read-only banner; the
  // try-acquire settles within milliseconds and corrects this if another tab holds the lock.
  const [held, setHeld] = useState(true)
  // keyed by the incident it answers for: on a switch the previous Einsatz's answer must not
  // stand for the next one through the render before the effect resets it
  const [firstAnswer, setFirstAnswer] = useState<{ id: string; held: boolean } | null>(null)
  const ref = useRef<IncidentTabLock | null>(null)
  const onHeldRef = useRef(onHeld)
  useEffect(() => { onHeldRef.current = onHeld }, [onHeld])
  useEffect(() => {
    if (!incidentId) { setHeld(true); return }
    const lock = new IncidentTabLock(incidentLockName(incidentId), (now) => {
      setHeld(now)
      setFirstAnswer((first) => (first?.id === incidentId ? first : { id: incidentId, held: now }))
      if (now) onHeldRef.current?.(incidentId)
    })
    ref.current = lock
    lock.start()
    return () => {
      ref.current = null
      lock.stop()
      setHeld(true)
      setFirstAnswer(null) // a reopen asks again: another tab may hold it by then
    }
  }, [incidentId])
  const takeOver = useCallback(() => ref.current?.takeOver(), [])
  const heldAtOpen = firstAnswer && firstAnswer.id === incidentId ? firstAnswer.held : null
  return { held, heldAtOpen, takeOver }
}
