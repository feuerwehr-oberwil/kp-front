import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { JournalStore } from './journalStore'
import { nextPollDelay } from './pollBackoff'
import type { TimelineEvent } from '../types'

/**
 * React binding for the JournalStore — one store per incident mount (IncidentWorkspace is
 * keyed by incident id upstream). Pulls new rows + retries the outbox on the same cadence
 * as the workspace live-poll, flushes on reconnect, and re-renders via a change nonce.
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
    store.onChange = () => setNonce((n) => n + 1)
    void store.init(legacy)

    // Same adaptive live-poll as the workspace sync: pull new rows + retry the outbox on a fast
    // cadence while rows are arriving, ease off while the Verlauf is quiet, and poll rarely while
    // the tab is hidden — so the radio isn't pinned awake by a 2 s beat for the whole incident.
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let quiet = 0
    let gen = 0

    const tick = async (myGen: number) => {
      if (stopped || myGen !== gen) return
      const changed = await store.pull()
      void store.flush()
      if (stopped || myGen !== gen) return
      quiet = changed ? 0 : quiet + 1
      timer = setTimeout(() => void tick(myGen), nextPollDelay({
        baseMs: appConfig.sync.livePollMs, maxMs: appConfig.sync.livePollMaxMs,
        quietRounds: quiet, hidden: document.hidden, hiddenMs: appConfig.sync.hiddenPollMs,
      }))
    }
    const start = (delay: number) => {
      gen++
      const myGen = gen
      quiet = 0
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void tick(myGen), delay)
    }
    start(appConfig.sync.livePollMs)

    const onOnline = () => void store.flush()
    // page teardown (iOS PWA backgrounded / swiped away): a normal fetch is aborted with the
    // document, so pending rows ride a keepalive beacon — the coverage timeline rows had via
    // the workspace blob beacon before the extraction.
    const onHide = () => store.flushKeepalive()
    const onVis = () => {
      if (document.visibilityState === 'hidden') store.flushKeepalive()
      else start(0) // back to the foreground → pull the latest at once and reset to fast
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
    (id: string, fields: Partial<Pick<TimelineEvent, 'transcript' | 'audioUrl' | 'photoUrl' | 'textEdit' | 'retracted'>>) =>
      store.appendPatch(id, fields),
    [store],
  )
  const overlaySession = useCallback((id: string, fields: Partial<TimelineEvent>) => store.overlaySession(id, fields), [store])
  const ingestLegacy = useCallback((tl: TimelineEvent[]) => store.ingestLegacy(tl), [store])

  return { rows, blobTimeline, append, appendPatch, overlaySession, ingestLegacy, pendingCount: store.pendingCount }
}
