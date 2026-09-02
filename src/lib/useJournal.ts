import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { JournalStore } from './journalStore'
import { createLongPollLoop } from './pollBackoff'
import type { TimelineEvent } from '../types'

/**
 * React binding for the JournalStore — one store per incident mount (IncidentWorkspace is
 * keyed by incident id upstream). Pulls new rows + retries the outbox on the same long-poll
 * loop as the workspace live-follow, flushes on reconnect, and re-renders via a change nonce.
 */
export function useJournal({ incidentId, readOnly, legacy }: {
  incidentId: string
  readOnly: boolean
  /** the blob's timeline at open (newest-first) — legacy display + migration input */
  legacy: TimelineEvent[]
}) {
  const [nonce, setNonce] = useState(0)
  const storeRef = useRef<JournalStore | null>(null)
  if (!storeRef.current) storeRef.current = new JournalStore(incidentId, readOnly)
  const store = storeRef.current

  useEffect(() => {
    // ⚠️ React StrictMode (dev) mounts this effect, tears it down and mounts it AGAIN. The store
    // lives in a ref, so it survives that — but the first teardown disposed it, and a disposed
    // store drops every `append` on the floor without a word. In dev that meant: the composer
    // closed, the toast said «gespeichert», and no Verlaufszeile ever reached the server.
    if (store.isDisposed) store.revive()
    store.onChange = () => setNonce((n) => n + 1)
    void store.init(legacy)

    // Same live-follow loop as the workspace sync — literally the same one (pollBackoff ·
    // createLongPollLoop), so only the round differs. A VISIBLE tab long-polls (`wait: true` —
    // the server holds the request until a row is appended, see backend app/live_wait), so a
    // Verlaufszeile dictated on the tablet is on the phone as soon as it commits, and the rounds
    // run back-to-back with only a spacing floor between them. A HIDDEN tab keeps the flat 60 s
    // no-wait poll: nothing on screen to keep fresh, and a backgrounded PWA holding a connection
    // open only spends radio (see pollBackoff).
    const loop = createLongPollLoop({
      baseMs: appConfig.sync.livePollMs,
      maxMs: appConfig.sync.livePollMaxMs,
      hiddenMs: () => appConfig.sync.hiddenPollMs,
      round: async ({ hidden, signal }) => {
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
    })
    loop.start(appConfig.sync.livePollMs)

    return () => {
      loop.stop()
      store.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the tab lock can flip read-only at runtime; a promoted tab starts flushing
  useEffect(() => { store.setReadOnly(readOnly) }, [readOnly, store])

  const rows = useMemo(() => store.display(), [nonce])           // eslint-disable-line react-hooks/exhaustive-deps
  const blobTimeline = useMemo(() => store.blobTimeline(), [nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const append = useCallback((row: TimelineEvent) => store.append(row), [store])
  const appendPatch = useCallback(
    (id: string, fields: Partial<Pick<TimelineEvent, 'transcript' | 'transcriptSection' | 'transcriptSectionEdit' | 'audioUrl' | 'photoUrl' | 'photoUrls' | 'textEdit' | 'retracted'>>) =>
      store.appendPatch(id, fields),
    [store],
  )
  const overlaySession = useCallback((id: string, fields: Partial<TimelineEvent>) => store.overlaySession(id, fields), [store])
  // stable identity: callers hang upload callbacks off this, and reading a row's photos from
  // the store (not from a captured `rows`) is what keeps a multi-photo row intact
  const swapPhoto = useCallback((id: string, from: string, to: string) => store.swapPhoto(id, from, to), [store])
  const ingestLegacy = useCallback((tl: TimelineEvent[]) => store.ingestLegacy(tl), [store])

  return { rows, blobTimeline, append, appendPatch, overlaySession, swapPhoto, ingestLegacy, pendingCount: store.pendingCount }
}
