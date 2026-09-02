import { useCallback, useEffect, useRef, useState } from 'react'
import { pollWorkspaceSince, type WorkspaceSync, type Workspace, type SyncStatus } from './incidents'
import { appConfig } from '../config/appConfig'
import { onWorkspaceServerTime } from './api/workspace'
import { attendanceConflictRows, conflictSignature } from './attendanceConflict'
import { fillTemplate } from './format'
import type { RecordConflict } from './mergeWorkspace'
import { LONG_POLL_SPACING_MS, nextPollDelay } from './pollBackoff'
import { createClockSkewAlert, createSyncAlertTracker } from './syncAlert'
import { recordTrouble } from './trouble'
import { toast } from './ui'
import type { Saved } from './workspace'
import type { TimelineEvent } from '../types'

/**
 * Turn freshly reported Trupp divergences (mergeWorkspace · onTruppConflict) into Verlauf rows,
 * one per affected Trupp — the Atemschutz sibling of attendanceConflictRows, and the same
 * doctrine: the merge already resolved things (field-level, nothing dropped), the row exists so
 * a human double-checks a record two devices wrote at once. `seen` is the caller's
 * session-scoped signature set, so merge retries re-reporting the same divergence don't
 * re-append.
 */
function truppConflictRows(conflicts: RecordConflict[], seen: Set<string>, now: Date = new Date()): TimelineEvent[] {
  const rows: TimelineEvent[] = []
  const pad = (n: number) => String(n).padStart(2, '0')
  for (const c of conflicts) {
    const sig = conflictSignature(c)
    if (seen.has(sig)) continue
    seen.add(sig)
    const name = ((c.mine as { name?: string })?.name ?? (c.theirs as { name?: string })?.name ?? c.key).trim()
    rows.push({
      id: `tc${now.getTime()}-${rows.length}`, // prefixed timestamp, same convention as attendanceConflictRows
      t: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      at: now.toISOString(),
      icon: 'warn',
      text: fillTemplate(appConfig.copy.journal.truppConflict, { name }),
    })
  }
  return rows
}

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
  /** THIS device is sounding the Atemschutz alarm (tier 2). The event that ends the tone — a
   *  Funkkontakt or Druckmeldung, usually entered on another device — arrives via this poll, so
   *  a hidden tab drops from hiddenPollMs to hiddenAlarmPollMs while it is true. A device that
   *  is actively ringing has no battery case for a sleepy radio. */
  alarmUrgent?: boolean
}

/**
 * Everything that reads or writes the synced workspace blob, lifted out of App's god-component:
 * the persistence push (debounced save, skip-first/skip-rehydrate guards), the teardown keepalive
 * beacons, the live-follow poll (with the tablet sync-race guard — re-check `hasUnsynced` AFTER
 * the round-trip so a tap that lands mid-poll isn't clobbered), the in-place auto-merge apply, and
 * the reactive sync-status badge. State writes stay in App via `applyWorkspace`/`buildPayload`; this
 * hook owns the sync-internal refs (skip/first/liveRev) + effects so the wiring is one unit.
 */
export function useIncidentSync({ sync, readOnly, incidentId, buildPayload, applyWorkspace, flushEvents, flushEventsBeacon, appendJournal, alarmUrgent }: IncidentSyncDeps) {
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
  const seenTruppConflicts = useRef(new Set<string>())
  useEffect(() => {
    if (!appendJournal || readOnly) return
    const report = (conflicts: RecordConflict[]) => {
      const rows = attendanceConflictRows(conflicts, seenConflicts.current)
      for (const row of rows) appendJournal(row)
      // A divergence that produced a note is worth asking the operator about later: LWW kept
      // one side, and only a human knows whether the losing side mattered.
      if (rows.length > 0) recordTrouble('syncConflict')
    }
    // Same wiring for concurrently edited Trupps. Here the merge is field-level (nothing was
    // dropped), but an SCBA record two devices wrote at once still gets its note + follow-up.
    const reportTrupps = (conflicts: RecordConflict[]) => {
      const rows = truppConflictRows(conflicts, seenTruppConflicts.current)
      for (const row of rows) appendJournal(row)
      if (rows.length > 0) recordTrouble('syncConflict')
    }
    sync.onAttendanceConflicts = report
    sync.onTruppConflicts = reportTrupps
    report(sync.drainAttendanceConflicts()) // conflicts from init()'s cold-reopen merge
    reportTrupps(sync.drainTruppConflicts())
    return () => { sync.onAttendanceConflicts = undefined; sync.onTruppConflicts = undefined }
  }, [sync, appendJournal, readOnly])

  // persistence → server (offline cache + debounced sync). Skip the first run so loading
  // an incident doesn't immediately re-push the just-loaded state.
  const firstSave = useRef(true)
  useEffect(() => {
    const payload = buildPayload()
    if (firstSave.current) { firstSave.current = false; return }
    if (skipSave.current) { skipSave.current = false; return }
    // Demo edits DO persist now (shared, like a real station) — visitors work a live incident that
    // survives reload and is reset once nightly (backend cron at 00:00 Europe/Zurich). Creating NEW
    // incidents stays blocked (backend + UI guards). save() also writes the IDB cache.
    if (!readOnly) sync.save(payload as unknown as Workspace)
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
  // Awaitable so the caller can SHOW that it ran. It used to be fire-and-forget, which on an
  // already-synced Einsatz — the normal case — was indistinguishable from a dead button: the
  // status line already said «gerade eben synchronisiert» before the tap and still did after.
  const startRef = useRef<((delay: number) => void) | null>(null)
  const syncNow = useCallback(async () => {
    if (!readOnly) { flushEvents(); await sync.flush() }
    startRef.current?.(0)
  }, [readOnly, sync, flushEvents])

  // live-follow: every device follows the server's workspace revision and re-renders, so an edit
  // on one device (e.g. a tablet) shows up on the others (e.g. a phone) — shared situational
  // awareness without WebSocket. Viewers follow unconditionally; editors follow too, but skip a
  // round while they have unsynced local edits (their pending flush + last-write-wins owns that
  // merge — pulling mid-edit would clobber in-progress work). On a pull we `adoptServer` so the
  // sync engine rebases onto the new rev and the next local edit doesn't 409. Conditional on
  // `> sync.rev` so we never re-hydrate our own just-pushed write.
  //
  // A VISIBLE tab long-polls: `wait: true` makes the server hold the request until the rev moves
  // (backend app/live_wait), so the other device's edit lands here as fast as it commits and the
  // rounds are back-to-back instead of on a 2–15 s cadence. A HIDDEN tab does NOT hold a
  // connection — there is nothing on screen to keep fresh, iOS suspends a backgrounded PWA's
  // timers and sockets anyway (so a held request is killed and re-issued on resume, i.e. churn
  // for nothing), and keeping the radio in its high-power state 20 s at a time is precisely the
  // battery cost the old cadence was tuned to avoid. It keeps the flat 60 s no-wait poll and
  // catches up at once on the visibility return — unless this device is RINGING (alarmUrgent),
  // where the hidden cadence drops to hiddenAlarmPollMs so the Funkkontakt that ends the alarm
  // is not up to a minute late.
  const liveRev = useRef(sync.rev)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let quiet = 0    // consecutive rounds that fetched nothing (failed / dirty-skipped) → ease-off
    let gen = 0      // bumps to invalidate any in-flight async round when we (re)start or tear down
    let inflight: AbortController | null = null // the held request, so a restart can drop it
    // While this device is sounding the alarm the hidden cadence drops to hiddenAlarmPollMs
    // (see IncidentSyncDeps · alarmUrgent). `alarmUrgent` is in the effect's deps, so a flip
    // restarts the loop and the new cadence applies at once — not after the parked 60 s timer.
    const hiddenMs = () => (alarmUrgent ? appConfig.sync.hiddenAlarmPollMs : appConfig.sync.hiddenPollMs)

    const tick = async (myGen: number) => {
      if (stopped || myGen !== gen) return
      // Demo follows the shared server too now (edits persist + sync across visitors, like a real
      // station). The `!sync.hasUnsynced` guard still protects in-progress local edits from being
      // clobbered mid-edit; the nightly reset re-seeds everyone at once.
      const skipped = !readOnly && sync.hasUnsynced
      const hold = !document.hidden
      let answered = false
      if (!skipped) {
        const ctrl = new AbortController()
        inflight = ctrl
        try {
          const since = Math.max(liveRev.current, sync.rev)
          const res = await pollWorkspaceSince(incidentId, since, { wait: hold, signal: ctrl.signal })
          answered = true
          // RE-CHECK after the round-trip: a local edit may have landed WHILE this poll was in
          // flight (with a held request that window is now the whole wait, so this guard matters
          // MORE, not less). Adopting the server blob now would clobber that unsaved edit — the
          // "symbol placed on a tablet vanishes ~200ms later" race. Skip the take-server: the
          // edit's own debounced flush will 3-way merge against the server.
          if (stopped || myGen !== gen || (!readOnly && sync.hasUnsynced)) return
          if (res && res.workspace_rev > sync.rev) {
            liveRev.current = res.workspace_rev
            const ws = (res.workspace ?? {}) as Workspace
            if (!readOnly) sync.adoptServer(ws, res.workspace_rev)
            hydrate(ws as unknown as Saved)
          }
        } catch { /* offline, or this round was aborted — handled by the delay below */ }
        finally { if (inflight === ctrl) inflight = null }
      }
      if (stopped || myGen !== gen) return
      // Straight into the next round while the server is answering a visible tab — it does the
      // waiting for us, so the spacing is only a floor against a tight retry loop. A round that
      // never reached the server, or one skipped because we're dirty, eases off instead
      // (pollBackoff): a dead backend must not be hammered, and a dirty skip fetches nothing.
      const hidden = document.hidden
      let delay: number
      if (answered && !hidden) { quiet = 0; delay = LONG_POLL_SPACING_MS }
      else {
        delay = nextPollDelay({
          baseMs: appConfig.sync.livePollMs, maxMs: appConfig.sync.livePollMaxMs,
          quietRounds: quiet, hidden, hiddenMs: hiddenMs(),
        })
        quiet += 1
      }
      timer = setTimeout(() => void tick(myGen), delay)
    }

    // (re)start the loop, invalidating any prior round — including one the server is still
    // holding: without the abort, a teardown or an incident switch would stay pinned to a
    // 20 s request that can no longer do anything with its answer.
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
    startRef.current = start

    // returning to the foreground: catch up immediately and resume long-polling, so a
    // backgrounded device (which was polling at hiddenPollMs) shows the latest state at once.
    // Going away: drop the held request and fall back to the slow no-wait cadence.
    const onVis = () => start(document.visibilityState === 'visible' ? 0 : hiddenMs())
    document.addEventListener('visibilitychange', onVis)

    return () => {
      stopped = true; gen++
      if (timer) clearTimeout(timer)
      inflight?.abort()
      startRef.current = null
      document.removeEventListener('visibilitychange', onVis)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, incidentId, sync, alarmUrgent])

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

  // Device-vs-server clock skew, sampled from X-Server-Time on every live-follow poll answer
  // (api/workspace · onWorkspaceServerTime — the backend stamps all /api/ responses). Every
  // Atemschutz timestamp is device-local Date.now(), so a tablet minutes off writes wrong
  // contact times into the legal record and nothing else would notice. Positive = this device
  // runs ahead. Minute-quantized behind a 45 s dead-band (below) so per-sample network jitter
  // doesn't re-render the tree every poll round; null until the first parseable sample. Crossing the
  // warn threshold (>3 min — CLOCK_SKEW_WARN_MIN, the capture surface's bound) fires ONE toast
  // per episode (syncAlert · createClockSkewAlert), re-armed when the clock comes back within
  // bounds. Same doctrine as the sync-trouble toasts: no persistent banner here — the standing
  // value is exposed as `clockSkewMs` for the Atemschutz surface to render.
  const [clockSkewMs, setClockSkewMs] = useState<number | null>(null)
  useEffect(() => {
    const alert = createClockSkewAlert((skewMin) => {
      toast(fillTemplate(appConfig.copy.incidentSwitcher.clockSkewToast, { n: Math.abs(skewMin) }), {
        icon: 'warn', tone: 'warn',
      })
    })
    // Committed-sample dead-band: a clock sitting near a minute boundary would otherwise flip
    // 3↔4 on latency jitter every poll round — re-rendering the tree and re-firing the toast
    // on every flip. A sample only commits when the raw skew moved >45 s from the one on
    // record; the committed minute is what the state, the alert and the board all see.
    // (Same sign/rounding as captureDraft · serverSkewMinutes; unparseable = no information.)
    let committedRawMs: number | null = null
    onWorkspaceServerTime((iso) => {
      const server = Date.parse(iso)
      if (!Number.isFinite(server)) return
      const raw = Date.now() - server // positive = device runs ahead
      if (committedRawMs !== null && Math.abs(raw - committedRawMs) <= 45_000) return
      committedRawMs = raw
      const skewMin = Math.round(raw / 60_000)
      setClockSkewMs(skewMin * 60_000)
      alert.onSkew(skewMin)
    })
    return () => onWorkspaceServerTime(null)
  }, [])

  return { syncStatus, lastSyncedAt, syncNow, clockSkewMs }
}
