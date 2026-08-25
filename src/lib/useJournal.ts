import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { JournalStore } from './journalStore'
import { LONG_POLL_SPACING_MS, nextPollDelay } from './pollBackoff'
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

    // Same live-follow shape as the workspace sync: pull new rows + retry the outbox. A VISIBLE
    // tab long-polls (`wait: true` — the server holds the request until a row is appended, see
    // backend app/live_wait), so a Verlaufszeile dictated on the tablet is on the phone as soon
    // as it commits, and the rounds run back-to-back with only a spacing floor between them. A
    // HIDDEN tab keeps the flat 60 s no-wait poll: nothing on screen to keep fresh, and a
    // backgrounded PWA holding a connection open only spends radio (see pollBackoff).
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let quiet = 0
    let gen = 0
    let inflight: AbortController | null = null // the held request, so a restart can drop it

    const tick = async (myGen: number) => {
      if (stopped || myGen !== gen) return
      const ctrl = new AbortController()
      inflight = ctrl
      const hidden = document.hidden
      const result = await store.pull({ wait: !hidden, signal: ctrl.signal })
      if (inflight === ctrl) inflight = null
      void store.flush()
      if (stopped || myGen !== gen) return
      // The server answered a visible tab → straight into the next round. It didn't (offline,
      // aborted, backend down) → ease off so a dead server isn't hammered; hidden → 60 s.
      let delay: number
      if (result !== 'failed' && !document.hidden) { quiet = 0; delay = LONG_POLL_SPACING_MS }
      else {
        delay = nextPollDelay({
          baseMs: appConfig.sync.livePollMs, maxMs: appConfig.sync.livePollMaxMs,
          quietRounds: quiet, hidden: document.hidden, hiddenMs: appConfig.sync.hiddenPollMs,
        })
        quiet += 1
      }
      timer = setTimeout(() => void tick(myGen), delay)
    }
    // (re)start, dropping any round the server is still holding — a 20 s request must not
    // outlive the loop that issued it (teardown, incident switch, tab going away).
    const start = (delay: number) => {
      gen++
      const myGen = gen
      quiet = 0
      if (timer) clearTimeout(timer)
      inflight?.abort()
      inflight = null
      timer = setTimeout(() => void tick(myGen), delay)
    }
    start(appConfig.sync.livePollMs)

    const onOnline = () => void store.flush()
    // page teardown (iOS PWA backgrounded / swiped away): a normal fetch is aborted with the
    // document, so pending rows ride a keepalive beacon — the coverage timeline rows had via
    // the workspace blob beacon before the extraction.
    const onHide = () => store.flushKeepalive()
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        store.flushKeepalive()
        start(appConfig.sync.hiddenPollMs) // drop the held request, fall back to the slow poll
      } else start(0) // back to the foreground → pull the latest at once and resume long-polling
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true; gen++
      if (timer) clearTimeout(timer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVis)
      inflight?.abort()
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
