import { useCallback, useEffect, useRef, useState } from 'react'
import { pollWorkspaceSince, type WorkspaceSync, type Workspace, type SyncStatus } from './incidents'
import { appConfig } from '../config/appConfig'
import { attendanceConflictRows } from './attendanceConflict'
import type { RecordConflict } from './mergeWorkspace'
import { nextPollDelay } from './pollBackoff'
import { isDemoMode } from './deploymentConfig'
import { createSyncAlertTracker } from './syncAlert'
import { toast } from './ui'
import type { Saved } from './workspace'
import type { TimelineEvent } from '../types'

interface IncidentSyncDeps {
  sync: WorkspaceSync
  readOnly: boolean
  incidentId: string
  /** Build the workspace blob from the current document/state slices. A useCallback whose
   *  identity changes exactly when a persisted slice changes — that's what re-fires the save. */
  buildPayload: () => Saved
  /** Write an authoritative workspace into App's state (the old hydrate body, minus skipSave). */
  applyWorkspace: (ws: Saved) => void
  flushEvents: () => void
  flushEventsBeacon: () => void
  /** Append one Verlauf row (journal store) — used for the attendance-divergence note when a
   *  merge saw both sides change the same person's entry. Optional: omitted (or read-only) →
   *  conflicts stay silent, merge behavior is unchanged. */
  appendJournal?: (row: TimelineEvent) => void
}

/**
 * Everything that reads or writes the synced workspace blob, lifted out of App's god-component:
 * the persistence push (debounced save, skip-first/skip-rehydrate guards), the teardown keepalive
 * beacons, the live-follow poll (with the tablet sync-race guard — re-check `hasUnsynced` AFTER
 * the round-trip so a tap that lands mid-poll isn't clobbered), the in-place auto-merge apply, and
 * the reactive sync-status badge. State writes stay in App via `applyWorkspace`/`buildPayload`; this
 * hook owns the sync-internal refs (skip/first/liveRev) + effects so the wiring is one unit.
 */
export function useIncidentSync({ sync, readOnly, incidentId, buildPayload, applyWorkspace, flushEvents, flushEventsBeacon, appendJournal }: IncidentSyncDeps) {
  // re-hydrate flags one save to skip — otherwise an editor would immediately push the
  // just-pulled blob back, bumping the rev and triggering an endless pull→push→pull echo.
  const skipSave = useRef(false)
  const hydrate = (ws: Saved) => { skipSave.current = true; applyWorkspace(ws) }

  // Attendance divergence → ONE Verlauf note per affected person: a merge kept LWW but saw
  // both sides (e.g. KP tablet and QR-Erfassung) change the same person's entry. The seen-set
  // is session-scoped, so merge retries / later cycles re-reporting the same divergence don't
  // re-append (attendanceConflictRows guards by signature). Read-only sessions stay silent —
  // the editing side appends the note.
  const seenConflicts = useRef(new Set<string>())
  useEffect(() => {
    if (!appendJournal || readOnly) return
    const report = (conflicts: RecordConflict[]) => {
      for (const row of attendanceConflictRows(conflicts, seenConflicts.current)) appendJournal(row)
    }
    sync.onAttendanceConflicts = report
    report(sync.drainAttendanceConflicts()) // conflicts from init()'s cold-reopen merge
    return () => { sync.onAttendanceConflicts = undefined }
  }, [sync, appendJournal, readOnly])

  // persistence → server (offline cache + debounced sync). Skip the first run so loading
  // an incident doesn't immediately re-push the just-loaded state.
  const firstSave = useRef(true)
  useEffect(() => {
    const payload = buildPayload()
    if (firstSave.current) { firstSave.current = false; return }
    if (skipSave.current) { skipSave.current = false; return }
    // Demo = LOCAL SANDBOX: never push a visitor's edits to the shared server, so every visitor
    // lands on the same pristine curated scene regardless of what the previous one drew. save()
    // also writes the IDB cache, so skipping it keeps edits in React state only (gone on reload/
    // reset — exactly the sandbox contract). Pull is disabled below for the same reason.
    if (!readOnly && !isDemoMode()) sync.save(payload as unknown as Workspace)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildPayload])

  // Flush pending edits + events when the page is going away. On real teardown — iOS PWA
  // backgrounded / screen locked / swiped away, or a tab close — a normal async flush is
  // aborted before its fetch completes, so the last edits reach only this device's cache.
  // We use keepalive beacons that survive the document unloading instead. visibilitychange
  // →hidden is the reliable signal on mobile; pagehide covers desktop nav/close. (We drop
  // beforeunload: it's unreliable on iOS and blocks the back/forward cache.) On in-app
  // unmount (incident switch) the page lives on, so the normal flush() runs and can still
  // process a 409 merge.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') { flushEventsBeacon(); sync.flushKeepalive() } }
    const onPageHide = () => { flushEventsBeacon(); sync.flushKeepalive() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
      flushEvents(); void sync.flush()
    }
  }, [flushEvents, flushEventsBeacon, sync])

  // Reconnect resume: when the device comes back online, push any edits queued while offline.
  // save()/page-hide/incident-switch are the only other flush triggers, so without this an edit
  // made offline would sit in 'offline' status until the next edit happened to re-arm a flush.
  // The live-follow poll below already resumes PULLING on its own once fetches succeed again;
  // this covers the PUSH side. flush() is a no-op when nothing is dirty.
  useEffect(() => {
    const onOnline = () => { if (!readOnly) { flushEvents(); void sync.flush() } }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [readOnly, sync, flushEvents])

  // Manual "Jetzt synchronisieren": push pending edits AND snap the live-follow pull to now —
  // the "everything fresh right now" button for when things feel laggy. Viewers only pull.
  // startRef hands the poll loop's (re)start out of its effect so this callback can fire it.
  const startRef = useRef<((delay: number) => void) | null>(null)
  const syncNow = useCallback(() => {
    if (!readOnly) { flushEvents(); void sync.flush() }
    startRef.current?.(0)
  }, [readOnly, sync, flushEvents])

  // live-follow: every device polls for newer server revisions and re-renders, so an edit on
  // one device (e.g. a tablet) shows up on the others (e.g. a phone) within a poll cycle —
  // shared situational awareness without WebSocket. Viewers follow unconditionally; editors
  // follow too, but skip a cycle while they have unsynced local edits (their pending flush +
  // last-write-wins owns that merge — pulling mid-edit would clobber in-progress work). On a
  // pull we `adoptServer` so the sync engine rebases onto the new rev and the next local edit
  // doesn't 409. Conditional on `> sync.rev` so we never re-hydrate our own just-pushed write.
  const liveRev = useRef(sync.rev)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let quiet = 0    // consecutive rounds that pulled nothing new → adaptive ease-off (pollBackoff)
    let gen = 0      // bumps to invalidate any in-flight async round when we (re)start or tear down

    const tick = async (myGen: number) => {
      if (stopped || myGen !== gen) return
      let changed = false
      // Demo sandbox: don't pull the shared server either — a visitor's local edits stay put
      // until they reload or hit «zurücksetzen» (a mid-session server change, e.g. the 2 h reset,
      // would otherwise wipe their scribbles). The next page load re-fetches the pristine seed.
      if (!isDemoMode() && (readOnly || !sync.hasUnsynced)) {
        try {
          const since = Math.max(liveRev.current, sync.rev)
          const res = await pollWorkspaceSince(incidentId, since)
          // RE-CHECK after the round-trip: a local edit may have landed WHILE this poll was in
          // flight (~the request's latency). Adopting the server blob now would clobber that unsaved
          // edit — the "symbol placed on a tablet vanishes ~200ms later" race (slower network = a
          // wider in-flight window, so it overlaps a tap reliably; on desktop it almost never does).
          // Skip the take-server: the edit's own debounced flush will 3-way merge against the server.
          if (stopped || myGen !== gen || (!readOnly && sync.hasUnsynced)) return
          if (res && res.workspace_rev > sync.rev) {
            liveRev.current = res.workspace_rev
            const ws = (res.workspace ?? {}) as Workspace
            if (!readOnly) sync.adoptServer(ws, res.workspace_rev)
            hydrate(ws as unknown as Saved)
            changed = true
          }
        } catch { /* ignore */ }
      }
      if (stopped || myGen !== gen) return
      // a pulled change snaps back to the fast cadence; an unproductive round (nothing new, or a
      // brief dirty-skip while the local flush is pending) eases it off so a still incident stops
      // pinning the radio awake. A local edit's flush + the visibility catch-up both reset to fast.
      quiet = changed ? 0 : quiet + 1
      timer = setTimeout(() => void tick(myGen), nextPollDelay({
        baseMs: appConfig.sync.livePollMs, maxMs: appConfig.sync.livePollMaxMs,
        quietRounds: quiet, hidden: document.hidden, hiddenMs: appConfig.sync.hiddenPollMs,
      }))
    }

    // (re)start the loop at the fast cadence, invalidating any prior in-flight round
    const start = (delay: number) => {
      gen++
      const myGen = gen
      quiet = 0
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void tick(myGen), delay)
    }
    start(appConfig.sync.livePollMs)
    startRef.current = start

    // returning to the foreground: catch up immediately and reset to the fast cadence, so a
    // backgrounded device (which was polling at hiddenPollMs) shows the latest state at once.
    const onVis = () => { if (document.visibilityState === 'visible') start(0) }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      stopped = true; gen++
      if (timer) clearTimeout(timer)
      startRef.current = null
      document.removeEventListener('visibilitychange', onVis)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, incidentId, sync])

  // let the sync engine apply an auto-merged conflict result IN PLACE (no remount), so the
  // resolver smoothly gains the other device's edits instead of having the screen rebuilt.
  useEffect(() => {
    sync.onApplyMerged = (ws, rev) => { liveRev.current = rev; hydrate(ws as unknown as Saved) }
    return () => { sync.onApplyMerged = undefined }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync])

  // Reactive sync-status badge: the engine flushes debounced/out-of-band, so the old
  // one-shot `sync.hasUnsynced` read went stale after a flush. Subscribe instead so
  // pending/offline/error/synced is always reflected live in the TopBar.
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(sync.syncStatus)
  // last successful save timestamp — surfaced as a positive "gespeichert HH:MM" trust
  // signal next to the sync badge. Read alongside the status (it lands together).
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(sync.lastSyncedAt)
  // Sync-trouble surfacing (decision 2026-07-18: one-shot warn toast, NO persistent banner):
  // entering 'error' — or staying 'offline' beyond the grace window — fires ONE toast per
  // episode with a «Jetzt synchronisieren» action; the badge in the switcher stays the
  // always-visible indicator. syncNow via ref so the subscription effect stays keyed on `sync`.
  const syncNowRef = useRef(syncNow)
  useEffect(() => { syncNowRef.current = syncNow }, [syncNow])
  useEffect(() => {
    const tracker = createSyncAlertTracker((kind) => {
      const cp = appConfig.copy.incidentSwitcher
      toast(kind === 'error' ? cp.syncErrorToast : cp.syncOfflineToast, {
        icon: 'warn', tone: 'warn',
        action: { label: cp.syncNow, onClick: () => syncNowRef.current() },
      })
    })
    const onStatus = (s: SyncStatus) => { setSyncStatus(s); setLastSyncedAt(sync.lastSyncedAt); tracker.onStatus(s) }
    sync.onStatus = onStatus
    onStatus(sync.syncStatus)
    return () => { sync.onStatus = undefined; tracker.dispose() }
  }, [sync])

  return { syncStatus, lastSyncedAt, syncNow }
}
