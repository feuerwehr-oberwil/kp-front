import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JournalStore, type JournalOwner } from './journalStore'
import { useLongPoll } from './useLongPoll'
import type { TimelineEvent } from '../types'

/**
 * React binding for the JournalStore — one store per incident mount (IncidentWorkspace is
 * keyed by incident id upstream). Pulls new rows + retries the outbox on the same long-poll
 * loop as the workspace live-follow (useLongPoll), flushes on reconnect, and re-renders via a
 * change nonce.
 */
export function useJournal({ incidentId, readOnly, legacy, slowFollow = false, owner = null }: {
  incidentId: string
  readOnly: boolean
  /** whose outbox this is (journalStore · JournalOwner) — read once, at the store's creation */
  owner?: JournalOwner | null
  /** follow once a minute (the Atemschutz-Link of a closed Einsatz — see useIncidentSync) */
  slowFollow?: boolean
  /** the blob's timeline at open (newest-first) — legacy display + migration input */
  legacy: TimelineEvent[]
}) {
  const [nonce, setNonce] = useState(0)
  // rows the CLOSED Einsatz refused (journalStore · refused) — for the notice that says why.
  // Carried as state, set from the store's change callback, never read off the store in render.
  const [refusedCount, setRefusedCount] = useState(0)
  const storeRef = useRef<JournalStore | null>(null)
  if (!storeRef.current) storeRef.current = new JournalStore(incidentId, readOnly, owner)
  const store = storeRef.current

  // Same live-follow loop as the workspace sync — literally the same one (useLongPoll), so only
  // the round differs. Before the store's effect, so a teardown stops the loop (and aborts the
  // held pull) before the store is disposed. A VISIBLE tab long-polls (`wait: true` —
  // the server holds the request until a row is appended, see backend app/live_wait), so a
  // Verlaufszeile dictated on the tablet is on the phone as soon as it commits, and the rounds
  // run back-to-back with only a spacing floor between them. A HIDDEN tab keeps the flat 60 s
  // no-wait poll: nothing on screen to keep fresh, and a backgrounded PWA holding a connection
  // open only spends radio (see pollBackoff).
  useLongPoll({
    slowFollow,
    round: async ({ hidden, signal }) => {
      // Push BEFORE the pull, not only after it: a visible tab's pull is a long poll the server
      // holds ~20 s when nothing is new, so an outbox flushed only on its answer waited that
      // long after every recovery the `online` event did not announce — a backend restart, a
      // WLAN that was up but routed nowhere (navigator.onLine never went false), or a missed
      // event (e2e «offline journal entries survive reload and reconnect», 24.09.2026). A round
      // with an empty outbox costs nothing here: flush() returns at once.
      void store.flush()
      const result = await store.pull({ wait: !hidden, signal })
      void store.flush()
      // 'failed' (offline, aborted, backend down) → the loop eases off so a dead server isn't
      // hammered; anything else answered and a visible tab goes straight into the next round.
      return result !== 'failed'
    },
    // the outbox retries as soon as the link is back — the loop restarts the PULL on its own
    onOnline: () => void store.flush(),
    // page teardown (iOS PWA backgrounded / swiped away): a normal fetch is aborted with the
    // document, so pending rows ride a keepalive beacon — the coverage timeline rows had via
    // the workspace blob beacon before the extraction.
    onSuspend: () => store.flushKeepalive(),
  }, [])

  useEffect(() => {
    // ⚠️ React StrictMode (dev) mounts this effect, tears it down and mounts it AGAIN. The store
    // lives in a ref, so it survives that — but the first teardown disposed it, and a disposed
    // store drops every `append` on the floor without a word. In dev that meant: the composer
    // closed, the toast said «gespeichert», and no Verlaufszeile ever reached the server.
    if (store.isDisposed) store.revive()
    store.onChange = () => { setNonce((n) => n + 1); setRefusedCount(store.refusedCount) }
    void store.init(legacy)

    return () => { store.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the tab lock can flip read-only at runtime; a promoted tab starts flushing
  useEffect(() => { store.setReadOnly(readOnly) }, [readOnly, store])

  const rows = useMemo(() => store.display(), [nonce])           // eslint-disable-line react-hooks/exhaustive-deps
  const blobTimeline = useMemo(() => store.blobTimeline(), [nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const append = useCallback((row: TimelineEvent) => store.append(row), [store])
  const appendPatch = useCallback(
    (id: string, fields: Partial<Pick<TimelineEvent, 'transcript' | 'transcriptSection' | 'transcriptSectionEdit' | 'audioUrl' | 'photoUrl' | 'photoUrls' | 'photoGeo' | 'textEdit' | 'retracted'>>) =>
      store.appendPatch(id, fields),
    [store],
  )
  const overlaySession = useCallback((id: string, fields: Partial<TimelineEvent>) => store.overlaySession(id, fields), [store])
  // stable identity: callers hang upload callbacks off this, and reading a row's photos from
  // the store (not from a captured `rows`) is what keeps a multi-photo row intact
  const swapPhoto = useCallback((id: string, from: string, to: string) => store.swapPhoto(id, from, to), [store])
  const ingestLegacy = useCallback((tl: TimelineEvent[]) => store.ingestLegacy(tl), [store])

  const retry = useCallback(() => store.retry(), [store])
  const flush = useCallback(() => store.flush(), [store])
  const requeueRefused = useCallback(() => store.requeueRefused(), [store])
  const recoveryData = useCallback(() => store.recoveryData(), [store])
  const getStatus = useCallback(() => store.syncStatus, [store])
  const rowShown = useCallback((id: string) => store.rowShown(id), [store])

  return { rows, blobTimeline, append, appendPatch, overlaySession, swapPhoto, ingestLegacy,
    retry, flush, requeueRefused, recoveryData, getStatus, rowShown, syncStatus: store.syncStatus,
    pendingCount: store.pendingCount, rejectedCount: store.rejectedCount, refusedCount }
}
