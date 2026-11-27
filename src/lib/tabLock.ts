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

/** The lock name of Einsatz `id` – one per Einsatz, shared by every tab of the browser. */
export const incidentLockName = (id: string) => `kp-front-incident-${id}`

/**
 * This tab's edit-lock answers per Einsatz, for the writers that must not write behind another tab
 * (WorkspaceSync, useMediaQueue – docs/sync-and-offline.md › Two tabs). One per tab: the module's
 * `tabLockAnswers`, written by IncidentTabLock; a test makes one per simulated tab. Only a
 * confirmed «another tab holds it» stops a writer: no answer yet, or no Web Locks, writes as before.
 */
export class TabLockAnswers {
  private answers = new Map<string, boolean>()
  private listeners = new Map<string, Set<(held: boolean) => void>>()

  /** The lock said another tab holds Einsatz `id` – the last answer, not a guess. */
  anotherTabHolds(id: string): boolean {
    return this.answers.get(incidentLockName(id)) === false
  }

  /** Hear every later answer for Einsatz `id`. Returns the unsubscribe. */
  on(id: string, listener: (held: boolean) => void): () => void {
    const name = incidentLockName(id)
    const set = this.listeners.get(name) ?? new Set()
    this.listeners.set(name, set)
    set.add(listener)
    return () => { set.delete(listener) }
  }

  private settling = new Map<string, Promise<unknown>>()

  /** IncidentTabLock's side: the requests a stopped lock left for `name`, until the browser settled
   *  them. A try that fails meanwhile may be failing on one of them (a new lock for the Einsatz
   *  started right after the old one stopped), so it says nothing to the writers. */
  leftBehind(name: string, requests: Promise<unknown>[]): void {
    const left = Promise.allSettled([...requests, this.settling.get(name)])
    this.settling.set(name, left)
    void left.then(() => { if (this.settling.get(name) === left) this.settling.delete(name) })
  }

  /** …whether this tab still has such a request for `name` */
  ownSettling(name: string): boolean {
    return this.settling.has(name)
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
  /** this lock's requests the browser has not settled yet – see TabLockAnswers · leftBehind */
  private requests = new Set<Promise<unknown>>()

  constructor(
    private readonly name: string,
    /** fired on every editable/read-only transition of THIS tab */
    private readonly onChange: (held: boolean) => void,
    private readonly locks: LocksAPI | null = defaultLocks(),
    /** where the writers read this tab's answer – only a real answer is written: a request that
     *  rejects says nothing, and the writers go on as without Web Locks until a try answers */
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

  private track(request: Promise<unknown>): Promise<unknown> {
    this.requests.add(request)
    const settled = () => { this.requests.delete(request) }
    request.then(settled, settled)
    return request
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
        await this.track(this.locks.request(this.name, { ifAvailable: true }, async (lock) => {
          if (!lock || !current()) return // another tab holds it, or this request ended
          got = true
          granted = true
          this.answers.set(this.name, true)
          this.onChange(true)
          await this.hold()
        }))
        if (got || !current()) return
        // another tab holds it – unless the holder may be this tab's own previous request
        if (!this.answers.ownSettling(this.name)) this.answers.set(this.name, false)
        this.onChange(false)
      }
      // queue behind the current holder — granted (→ editing) when that tab goes away
      await this.track(this.locks.request(this.name, { signal: this.abort.signal }, async () => {
        if (!current()) return
        granted = true
        this.answers.set(this.name, true)
        this.onChange(true)
        await this.hold()
      }))
    } catch {
      if (!current()) return
      this.onChange(false)
      // A lost holder asks again, try first: only that try says whether another tab took the
      // lock – WebKit also releases a lone document's lock when it suspends it, and then the
      // try is granted and nothing changed for the writers. An ungranted rejection must stop:
      // WebKit rejects requests from a departing document, and immediate retries freeze navigation.
      if (granted) void this.acquire(true)
    }
  }

  /** Move editing into THIS tab (the current holder drops to read-only). */
  takeOver(): void {
    if (!this.locks || this.stopped) return
    const generation = ++this.generation
    const current = () => !this.stopped && generation === this.generation
    let granted = false
    this.abort?.abort() // leave the waiting queue; the steal below replaces it
    void this.track(this.locks.request(this.name, { steal: true }, async () => {
      if (!current()) return
      granted = true
      this.answers.set(this.name, true)
      this.onChange(true)
      await this.hold()
    })).catch(() => {
      if (!current()) return
      this.onChange(false)
      if (granted) void this.acquire(true) // lost again → ask, then wait in line (see acquire)
    })
  }

  stop(): void {
    this.stopped = true
    this.answers.set(this.name, undefined)
    if (this.requests.size) this.answers.leftBehind(this.name, [...this.requests])
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
