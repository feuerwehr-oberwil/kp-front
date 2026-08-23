import { useCallback, useEffect, useRef, useState } from 'react'
import './app.css'
import { IconSprite, Icon } from './lib/icons'
import { demoClockAnchor, latestTruppStamp, rebaseDemoClocks, type Saved } from './lib/workspace'
import { appConfig } from './config/appConfig'
import { shortAddress, isDemoMode, alarmProviderName } from './lib/deploymentConfig'
import { fillTemplate, initials, roleLabel } from './lib/format'
import { Overlays, toast, confirmDialog } from './lib/ui'
import { loadPrefs, savePrefs } from './lib/prefs'
import { useDevicePrefs } from './lib/useDevicePrefs'
import { buildLabel } from './lib/buildInfo'
import { useAutoTheme } from './lib/useAutoTheme'
import { Splash } from './components/Splash'
import { Brand } from './components/Brand'
import { DemoWelcome } from './components/DemoWelcome'
import { hasSeenDemoWelcome, markDemoWelcomeSeen } from './lib/demoWelcome'
import { InstallGuide } from './components/InstallGuide'
import { getInstallPlatform, isStandalone } from './lib/installPrompt'
import { installOffered } from './lib/installPolicy'
import { claimBootNotifyTarget } from './lib/notifyTarget'
import { useIncidentTabLock } from './lib/tabLock'
import { clearIncidentMedia, clearUploadedMedia } from './lib/mediaQueue'
import { ensurePushSubscription } from './lib/push'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useAuth } from './lib/auth'
import { IncidentWorkspace } from './IncidentWorkspace'
import {
  WorkspaceSync, listIncidentsResilient, getIncident, archiveIncident, reactivateIncident,
  migrateLegacyWorkspace, takeDiveraAlarm, patchIncident, attachDiveraAlarm, discardWorkspaceCache,
  type DiveraAlarm, type IncidentFull, type IncidentMeta,
} from './lib/incidents'
import { unlockAlarm } from './lib/alarm'
import { clearCrash } from './lib/crashLoop'
import { ApiError } from './lib/api'
import { useDiveraWatch } from './lib/useDiveraWatch'
import { dismissAlarm, loadDismissedAlarms } from './lib/diveraDismiss'
import { useIncidentWatch } from './lib/useIncidentWatch'
import { loadReviewedIncidents, needsIntakeReview, pickBootIncident, sameIncidentList, saveReviewedIncident } from './lib/incidentAlerts'
import { EinsatzWizard, DatenquellenPanel, FeedbackPrompt, FeedbackSheet, HistoryPanel, IncomingAlarmBanner, NewIncidentBanner, SettingsSheet } from './components/panels'
import { Meldeleiste } from './components/Meldeleiste'
import { pickTrouble, readTrouble, recordTrouble, type TroubleEvent } from './lib/trouble'
import { onStorageDegraded } from './lib/idb'
import { HelpOverlay } from './components/HelpOverlay'


// ---------------------------------------------------------------------------------
// Incident root: owns the incident list, the active selection, and the per-incident
// WorkspaceSync. The workspace below is keyed by incident id so switching remounts it,
// hydrating cleanly from that incident's own blob.
// ---------------------------------------------------------------------------------
/** Einstellungen opened from the landing card (no incident): device prefs only. Owns the
 *  pref state itself (mounted only while open, reads/writes the prefs cookie directly);
 *  the synced per-incident section is hidden by omitting settings/onSettings. */
/** Demo only: the fetched workspace with its Atemschutz clocks pinned to when this tab first
 *  opened this seed. A workspace with no Trupp clocks passes straight through. */
function rebaseDemoSeed(ws: Saved, incidentId: string): Saved {
  const stamp = latestTruppStamp(ws)
  return stamp == null ? ws : rebaseDemoClocks(ws, demoClockAnchor(incidentId, stamp, Date.now()))
}

function LandingSettings({ onClose, onFeedback }: { onClose: () => void; onFeedback?: () => void }) {
  const { symbolSize, setSymbolSize, symbolCaptions, setSymbolCaptions, offlineRadiusM, setOfflineRadiusM, keepScreenOn, setKeepScreenOn, railLabels, setRailLabels } = useDevicePrefs()
  useEffect(() => {
    savePrefs({ ...loadPrefs(), symbolSize, symbolCaptions, offlineRadiusM, keepScreenOn, railLabels })
  }, [symbolSize, symbolCaptions, offlineRadiusM, keepScreenOn, railLabels])
  return (
    <SettingsSheet
      onClose={onClose}
      symbolSize={symbolSize}
      railLabels={railLabels}
      onRailLabels={setRailLabels}
      onSymbolSize={setSymbolSize}
      symbolCaptions={symbolCaptions}
      onSymbolCaptions={setSymbolCaptions}
      offlineRadiusM={offlineRadiusM}
      onOfflineRadius={setOfflineRadiusM}
      keepScreenOn={keepScreenOn}
      onKeepScreenOn={setKeepScreenOn}
      themeCoord={null}
      elView={false}
      onFeedback={onFeedback}
    />
  )
}



export default function App() {
  const { user, logout } = useAuth()
  const isEditor = user?.role === 'editor'
  // Einsatz-Link session (/l/<token>): a viewer narrowed to ONE incident. The backend answers
  // 403 for everything outside a read allowlist — reports, printing, push, the incident LIST —
  // so the rule here is the same as for `isEditor`: a link holder must never see a control
  // that will fail. `linkIncidentId` is the incident the token names; the app opens it
  // directly, because listing incidents is exactly what a link may not do.
  const linkScoped = !!user?.link_scoped
  const linkIncidentId = (linkScoped && user?.link_incident_id) || null

  // register this browser for server push once per session (no-op unless notification
  // permission is already granted AND the deployment has VAPID keys) — killed-app alarms.
  // Never on a link session: /api/push/subscriptions writes rows tied to a user and 403s.
  useEffect(() => { if (!linkScoped) void ensurePushSubscription() }, [linkScoped])

  const [incidents, setIncidents] = useState<IncidentMeta[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeMeta, setActiveMeta] = useState<IncidentMeta | null>(null)
  const [workspace, setWorkspace] = useState<Saved | null>(null)
  const [remount, setRemount] = useState(0)
  // Demo instances greet a first-time visitor once per device with the can/can't intro.
  const [showWelcome, setShowWelcome] = useState(() => isDemoMode() && !hasSeenDemoWelcome())
  const [forceReadOnly, setForceReadOnly] = useState(false)
  // single-editor-per-browser: only one tab may edit an incident (they'd race the shared
  // IDB sync cache); a second tab is read-only with a one-tap take-over.
  const tabLock = useIncidentTabLock(activeId)
  const [overlay, setOverlay] = useState<null | 'create' | 'history' | 'daten'>(null)
  // landing-card utilities (no incident open): device settings / help / install guide
  const [landingSheet, setLandingSheet] = useState<null | 'settings' | 'help' | 'install'>(null)
  // Rückmeldung: something went wrong recently and the cooldown has passed → ask on the
  // LAUNCHER, never inside an incident. Read once at mount; the log only grows during an
  // incident, and by then this branch isn't rendered anyway.
  const [trouble, setTrouble] = useState<TroubleEvent | null>(() => pickTrouble(readTrouble(), Date.now()))
  const [feedbackFor, setFeedbackFor] = useState<TroubleEvent | 'plain' | null>(null)
  // Note a full device storage for the same prompt. Subscribed here rather than inside
  // lib/idb's setDegraded on purpose: that runs ON the failing write, and answering a failed
  // localStorage write with ANOTHER localStorage write is both futile and a side effect on the
  // one path that must stay minimal. App is mounted for the whole session, so nothing is missed.
  useEffect(() => onStorageDegraded((d) => { if (d) recordTrouble('storageFull') }), [])
  // existing incident opened in the wizard for in-place correction (PATCH, not create)
  const [editMeta, setEditMeta] = useState<IncidentMeta | null>(null)
  // always-on Divera watch: surfaces fresh alarms wherever the EL is (editor only).
  // Off in the demo: taking an alarm opens a NEW Einsatz, which the demo blocks server-side
  // («In der Demo können keine neuen Einsätze übernommen werden»), so both take surfaces —
  // the mid-incident banner and the landing take-card — would only offer a dead end. The
  // demo's story is the one running Einsatz; a leftover pool row must not compete with it.
  const { alarms: poolAlarms, refresh: refreshPool } = useDiveraWatch(isEditor && !isDemoMode())
  // per-device dismiss of pool alarms (kp.divera.dismissed) — «×» hides a dispatch on THIS
  // tablet only; it never archives it for the crew. Shared store with the incoming-alarm banner.
  const [dismissedAlarms, setDismissedAlarms] = useState<Set<number>>(loadDismissedAlarms)
  // always-on incident-list watch: with alarm auto-open an Einsatz can appear with no human
  // in the loop — keep the list fresh and announce mid-session arrivals (banner, never a
  // forced switch). Enabled for viewers too; announcing is read-only.
  const onWatchList = useCallback((list: IncidentMeta[]) => {
    setIncidents((prev) => (sameIncidentList(prev, list) ? prev : list))
  }, [])
  // (off for a link session: the list endpoint isn't on its allowlist — it would leak every
  // other Einsatz — so the watch would just 403 every 30 s)
  const { fresh: freshIncident, dismiss: dismissFreshIncident } = useIncidentWatch(!!user && !linkScoped, activeId, onWatchList)

  // A tapped «Neuer Einsatz» push routes here (target 'divera'): re-poll the pool
  // immediately so the alarm is on screen (landing card / mid-incident banner) — not just
  // a focused window that waits for the next 30 s tick. Two delivery paths (sw-notify.js):
  // postMessage while the app is running, and the ?kpn= boot param when the tap
  // cold-started a killed app. Editor only — viewers can't take alarms; per-incident
  // targets (atemschutz/journal) are claimed by IncidentWorkspace once mounted.
  useEffect(() => {
    if (!isEditor) return
    const openPool = () => { void refreshPool() }
    if (claimBootNotifyTarget(['divera'])) openPool()
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
    if (!sw) return
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'kp-notification-click' && e.data.target === 'divera') openPool()
    }
    sw.addEventListener('message', onMsg)
    return () => sw.removeEventListener('message', onMsg)
  }, [isEditor, refreshPool])
  const [taking, setTaking] = useState<number | null>(null) // divera_id mid-take
  // incident just opened one-tap → show the correct-in-place review banner until confirmed
  const [reviewPendingId, setReviewPendingId] = useState<string | null>(null)
  // …and the same banner for an Einsatz that opened ITSELF: nobody reviewed the dispatch's
  // guesses on the way in any more, so the first editor to look at it gets the offer once
  // (per device, kp.incident.reviewed).
  const [reviewedIncidents, setReviewedIncidents] = useState<Set<string>>(loadReviewedIncidents)
  const markReviewed = useCallback((id: string) => {
    saveReviewedIncident(id)
    setReviewedIncidents(loadReviewedIncidents())
    setReviewPendingId(null)
  }, [])
  const syncRef = useRef<WorkspaceSync | null>(null)
  const selectReq = useRef(0) // guards against interleaved incident switches (fast double-taps)
  // where «Zurück» from an archived read-only view lands: the editable incident that was
  // active before the (first) read-only open — chained archived views keep the original.
  // Refs mirror the states because selectIncident is a stable ([] deps) callback.
  const archiveReturnRef = useRef<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const forceReadOnlyRef = useRef(false)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  useEffect(() => { forceReadOnlyRef.current = forceReadOnly }, [forceReadOnly])

  // Night ergonomics: when the theme pref is 'auto', track daylight at the incident
  // coordinate so the UI dims itself after dusk (manual day/night overrides win).
  useAutoTheme(activeMeta?.lng != null && activeMeta?.lat != null ? [activeMeta.lng, activeMeta.lat] : null)

  const refreshList = useCallback(async () => {
    const { list } = await listIncidentsResilient().catch(() => ({ list: [] as IncidentMeta[] }))
    setIncidents(list)
    return list
  }, [])

  const selectIncident = useCallback(async (id: string, opts: { readOnly?: boolean; meta?: IncidentMeta; boot?: boolean } = {}) => {
    // ⚠️ THE AUDIO UNLOCK LIVES HERE, before the first `await`, because this is the first touch of
    // every Einsatz: the launch card, the switcher, «Einsatz eröffnen». A browser only releases
    // audio inside a real gesture, and the only caller that ever did this was the Atemschutz
    // Trupp-Formular — so anyone who synced the Trupps from a second device, or only ever tapped
    // «Kontakt», had a bell showing «an» over an AudioContext that was still `suspended`. Called
    // on a boot auto-open too, where it is a harmless no-op that leaves the context suspended and
    // the bell honestly saying «Ton nicht freigegeben» (see useAtemschutzMute).
    unlockAlarm()
    const my = ++selectReq.current // any newer call supersedes this one
    if (opts.readOnly) {
      if (!forceReadOnlyRef.current) archiveReturnRef.current = activeIdRef.current
    } else {
      archiveReturnRef.current = null
    }
    if (syncRef.current) { await syncRef.current.flush().catch(() => {}); syncRef.current.dispose(); syncRef.current = null }
    const sync = new WorkspaceSync(id, {
      debounceMs: appConfig.sync.saveDebounceMs,
      // Concurrent edits are auto-merged three-way (see mergeWorkspace), so no blocking
      // dialog — just a quiet notice. The merged result is applied in place via onApplyMerged
      // (registered by the live view); onServerWorkspace is the remount fallback.
      onMerged: () => toast(appConfig.copy.toast.merged),
      onServerWorkspace: (ws) => { setWorkspace(ws as unknown as Saved); setRemount((n) => n + 1) },
    })
    const meta = opts.meta ?? (await getIncident(id))
    if (selectReq.current !== my) { sync.dispose(); return } // superseded mid-flight
    const { workspace: ws } = await sync.init()
    if (selectReq.current !== my) { sync.dispose(); return } // superseded mid-flight
    syncRef.current = sync
    setActiveMeta(meta as IncidentMeta)
    // Make sure the open switcher list contains the one we just opened. Normally it already
    // does, but a just-reactivated incident was archived (hence absent) — without this the
    // switcher shows "keine offenen Einsätze" right after reactivating. Read-only opens
    // (viewing an archived incident from Verlauf) must NOT join the open list.
    if (!opts.readOnly) {
      const m = meta as IncidentMeta
      setIncidents((list) => {
        const arr = list ?? []
        return arr.some((i) => i.id === id) ? arr.map((i) => (i.id === id ? m : i)) : [m, ...arr]
      })
    }
    // Demo: rebase the SCBA clocks to the visitor's ARRIVAL so a late visitor doesn't land on an
    // overdue alarm (the seed's clocks are as-of the last server reset). Read-only, display only.
    // The anchor is remembered per tab + seed, so a refresh keeps the clocks running instead of
    // shunting them backwards — see workspace · demoClockAnchor.
    const seed = ws ? (isDemoMode() ? rebaseDemoSeed(ws as unknown as Saved, id) : (ws as unknown as Saved)) : null
    setWorkspace(seed)
    setForceReadOnly(!!opts.readOnly)
    setActiveId(id)
    setRemount((n) => n + 1)
    // ⚠️ `incidentChosenAt` is stamped only when a HUMAN opened this — never on the boot
    // auto-open, which would otherwise record the app's own choice as the operator's and let a
    // stale alarm keep re-confirming itself on every reload (lib/incidentAlerts · pickBootIncident).
    const prev = loadPrefs()
    savePrefs({ ...prev, incidentId: id, incidentChosenAt: opts.boot ? prev.incidentChosenAt : Date.now() })
  }, [])

  // boot: list → migrate legacy localStorage if empty → open remembered/first incident.
  // Offline (network error), fall back to the cached list so the last incident reopens
  // from the WorkspaceSync cache — with an honest one-shot toast that the list is cached.
  useEffect(() => {
    void (async () => {
      // Link session: there is exactly one incident and no list to pick from — fetch it by id
      // and open it. (GET /api/incidents is not on the link allowlist, so listing here would
      // 403 and land a responder on an empty launcher instead of the Einsatz they were sent.)
      if (linkIncidentId) {
        const inc = await getIncident(linkIncidentId).catch(() => null)
        setIncidents(inc ? [inc as IncidentMeta] : [])
        if (inc) await selectIncident(inc.id, { meta: inc as IncidentMeta }).catch(() => {})
        return
      }
      let { list, offline } = await listIncidentsResilient().catch(() => ({ list: [] as IncidentMeta[], offline: false }))
      if (list.length === 0 && !offline) {
        await migrateLegacyWorkspace([appConfig.storage.key, ...appConfig.storage.legacyKeys]).catch(() => null)
        list = (await listIncidentsResilient().catch(() => ({ list: [] as IncidentMeta[] }))).list
      }
      if (offline) toast(appConfig.copy.incidentSwitcher.bootOffline, { icon: 'warn' })
      setIncidents(list)
      // Remembered incident normally wins, but a NEWER alarm-created incident takes
      // precedence: a killed app reopens onto the live alarm, not yesterday's Einsatz.
      const bootPrefs = loadPrefs()
      const pick = pickBootIncident(list, bootPrefs.incidentId, { now: Date.now(), chosenAt: bootPrefs.incidentChosenAt })
      if (pick) await selectIncident(pick.id, { meta: pick, boot: true }).catch(() => {})
    })()
  }, [selectIncident, linkIncidentId])

  // An incident that has rendered for this long without throwing is healthy — forget the crash
  // streak so an unrelated crash weeks later starts from one, and the destructive recovery stays
  // hidden until it's genuinely warranted. A crash loop never reaches the timeout.
  useEffect(() => {
    if (!activeId) return
    const t = setTimeout(clearCrash, 15_000)
    return () => clearTimeout(t)
  }, [activeId])

  const openCreated = useCallback(async (inc: IncidentFull) => {
    setOverlay(null)
    await refreshList()
    await selectIncident(inc.id, { meta: inc })
  }, [refreshList, selectIncident])

  // One-tap Divera take: create the incident from the alarm AS-IS (everything Divera
  // carries + backend type/priority/geocode), drop straight onto the live map, and arm the
  // in-map review banner. No wizard — corrections happen on the map, never blocking it.
  // Undo a one-tap take: archive the just-created incident and return to the prior view (the
  // previous open incident if there was one, else the landing). Always targets the passed id
  // (the take made it active) — no activeId dep, so the toast's captured closure can't go stale.
  const undoTake = useCallback(async (id: string) => {
    if (syncRef.current) { syncRef.current.dispose(); syncRef.current = null }
    // ⚠️ SAY SO when the undo does not go through. A swallowed failure here left the incident on
    // the server, refreshed the list, and dropped the operator back onto it with no explanation —
    // an Einsatz that reappears by itself is how a tool stops being believed.
    try {
      await archiveIncident(id)
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : appConfig.copy.abschluss.failed, { icon: 'warn', tone: 'warn' })
      return
    }
    // ⚠️ the hard clear, deliberately — «Rückgängig» on a one-tap take means this incident should
    // never have existed, so keeping its blobs would leave an orphan queue nothing ever drains.
    // Every other archive path keeps what is still pending (clearUploadedMedia).
    await clearIncidentMedia(id).catch(() => {})
    setReviewPendingId(null)
    const list = await refreshList() // returns non-archived only → the taken incident is gone
    setActiveId(null); setActiveMeta(null)
    if (list[0]) await selectIncident(list[0].id, { meta: list[0] })
    void refreshPool()
  }, [refreshList, selectIncident, refreshPool])

  const takeAndOpen = useCallback(async (a: DiveraAlarm) => {
    if (taking != null) return
    setTaking(a.divera_id)
    try {
      const inc = await takeDiveraAlarm(a.divera_id)
      await openCreated(inc)
      setReviewPendingId(inc.id)
      // confirm-with-undo: a one-tap take is otherwise only reversible via a multi-tap
      // menu-archive. Undo archives the just-created incident and returns to the prior view.
      toast(appConfig.copy.intake.taken, {
        icon: 'check', tone: 'success',
        action: { label: appConfig.copy.undo, onClick: () => void undoTake(inc.id) },
      })
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : appConfig.copy.intake.errorTake, { icon: 'warn', tone: 'warn' })
    } finally {
      setTaking(null)
      void refreshPool()
    }
  }, [taking, openCreated, refreshPool, undoTake])

  // Split dispatch: the banner alarm may be the SAME Einsatz already open (reworded group
  // dispatch, Nachalarm) — attach it to the ACTIVE incident instead of opening a duplicate.
  // The banner only renders mid-incident, so the target is always the Einsatz being worked;
  // to attach to a different open incident, switch there first. Confirm-with-context (not a
  // picker sheet): the Meldung lands in the Verlauf, milestones follow, title/pin unchanged.
  const attachToActive = useCallback(async (a: DiveraAlarm) => {
    if (!activeMeta) return
    const ix = appConfig.copy.intake
    const ok = await confirmDialog({
      title: fillTemplate(ix.attachConfirmTitle, { alarm: a.title }),
      message: ix.attachHint,
      confirmLabel: ix.attachConfirm,
      cancelLabel: appConfig.copy.cancel,
    })
    if (!ok) return
    try {
      await attachDiveraAlarm(a.divera_id, activeMeta.id)
      toast(ix.attachDone, { icon: 'check', tone: 'success' })
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : ix.attachError, { icon: 'warn', tone: 'warn' })
    } finally {
      void refreshPool()
    }
  }, [activeMeta, refreshPool])

  /** Show an already-saved incident's new facts without remounting anything — the active meta
   *  and its row in the list, no location/center change. Used by the Einsatzdaten correction.
   *  (It was also shared with an inline patch from the review banner until 23.08., when that
   *  banner became a Meldeleiste row and its Kategorie dropdown moved into the edit panel.) */
  const reflectMeta = useCallback((updated: IncidentMeta) => {
    setActiveMeta(updated)
    setIncidents((list) => (list ?? []).map((i) => (i.id === updated.id ? updated : i)))
  }, [])

  // THE close, and the only one. Both doors on the ACTIVE Einsatz (the Rapport's button/band and
  // the Einsatz-Menü row) run their counting confirm in IncidentWorkspace and land here; «Alle
  // Einsätze» runs the plain confirm below and lands here too. Flush the last workspace edits,
  // stamp report_done_at, close, and move on — one action, no second dialog. Late corrections
  // stay possible (wieder öffnen / Nachträge) and flip the derived chip to «geändert nach
  // Abschluss».
  // Resolves TRUE only when the Einsatz was actually closed — the workspace's confirm passes
  // the outcome on (a failed handover must not look like an Abschluss to anyone upstream).
  const completeRapport = useCallback(async (id: string): Promise<boolean> => {
    if (isDemoMode()) { toast(appConfig.copy.demo.actionBlocked, { icon: 'info' }); return false }
    try {
      if (id === activeId && syncRef.current) await syncRef.current.flush().catch(() => {})
      await patchIncident(id, { report_done_at: new Date().toISOString() })
      // ⚠️ NOT `.catch(() => {})`. A swallowed failure here sat one line above a green «Rapport
      // abgeschlossen» toast — and then the Einsatz reopened by itself on the next list refresh,
      // because it had never been closed at all. The catch below reports it and the Einsatz stays
      // where it is, which is the truth.
      await archiveIncident(id)
      // …and say so when something could not go up: the operator is about to leave this incident,
      // and «kommt beim nächsten Öffnen» is only reassuring if it was said out loud.
      const stillQueued = await clearUploadedMedia(id)
      toast(stillQueued
        ? fillTemplate(appConfig.copy.abschluss.doneMediaPending, { n: stillQueued })
        : appConfig.copy.abschluss.done, { icon: stillQueued ? 'warn' : 'check', tone: stillQueued ? 'warn' : 'success' })
      if (id === activeId) {
        if (syncRef.current) { syncRef.current.dispose(); syncRef.current = null }
        const list = await refreshList()
        setActiveId(null); setActiveMeta(null)
        if (list[0]) await selectIncident(list[0].id, { meta: list[0] })
      } else {
        await refreshList()
      }
      return true
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : appConfig.copy.abschluss.failed, { icon: 'warn', tone: 'warn' })
      return false
    }
  }, [activeId, refreshList, selectIncident])

  // Close ANY incident from the «Alle Einsätze» list (per-incident, not just the active one).
  // ⚠️ It ends the same way the Rapport does — through `completeRapport` — so an Einsatz put away
  // from a list is not a second, weaker kind of ending. Until 22.08. this path archived plainly:
  // no `report_done_at`, none of the seven ABSCHLUSS_STEPS checked, so the Einsatz stood in the
  // Historie as «offen» for ever while the Rapport path stamped and counted. Two doors with the
  // same label into two different rooms.
  //
  // The CONFIRM is the plain one here, and deliberately: this incident's workspace is not loaded,
  // so there are no open points to name. The Einsatz being worked on goes through the counting
  // confirm in IncidentWorkspace instead — both of ITS doors do.
  const archiveById = useCallback(async (id: string) => {
    if (!id) return
    // Demo: don't let a visitor close the one shared running incident (it would archive for
    // everyone until the nightly reset). Editing it stays open; only closing/creating is blocked.
    if (isDemoMode()) { toast(appConfig.copy.demo.actionBlocked, { icon: 'info' }); return }
    const ok = await confirmDialog({
      title: appConfig.copy.history.archiveConfirmTitle,
      message: appConfig.copy.history.archiveConfirmMsg,
      confirmLabel: appConfig.copy.history.archiveConfirmBtn,
      cancelLabel: appConfig.copy.cancel,
      danger: true,
    })
    if (!ok) return
    await completeRapport(id)
  }, [completeRapport])

  // «Zurück» from an archived read-only view: return to the incident that was active before,
  // else land on the launcher with «Alle Einsätze» open (the sheet the view was entered from).
  const backFromArchive = useCallback(async () => {
    const backId = archiveReturnRef.current
    archiveReturnRef.current = null
    if (backId && (await selectIncident(backId).then(() => true).catch(() => false))) return
    // a read-only view holds no unsaved edits — dispose without flushing
    if (syncRef.current) { syncRef.current.dispose(); syncRef.current = null }
    setActiveId(null); setActiveMeta(null); setForceReadOnly(false)
    setOverlay('history')
  }, [selectIncident])

  // «Wieder öffnen» — the mirror of abschliessen (the ArchivedBanner action), and as deliberate:
  // the confirm also teaches the consequences (Nachträge, «geändert nach Abschluss»). On confirm
  // the same incident reopens EDITABLE (readOnly false ⇒ it rejoins the open list).
  const reactivateById = useCallback(async (id: string) => {
    const h = appConfig.copy.history
    const ok = await confirmDialog({
      title: h.reactivateConfirmTitle,
      message: h.reactivateConfirmMsg,
      confirmLabel: h.reactivateConfirmBtn,
      cancelLabel: appConfig.copy.cancel,
    })
    if (!ok) return
    // ⚠️ Reported, not swallowed: a failed reopen used to be followed by the incident being
    // opened read-only anyway, which reads as «the app decided I may not edit this» rather than
    // as «the server refused». Same rule as abschliessen — the outcome, not the intent.
    try {
      await reactivateIncident(id)
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : appConfig.copy.errors.updateFailed, { icon: 'warn', tone: 'warn' })
      return
    }
    await refreshList()
    await selectIncident(id, { readOnly: false }).catch(() => {})
  }, [refreshList, selectIncident])

  // Incident list still loading after auth: keep the boot Splash up rather than a blank
  // colour flash, so the launch stays continuous from /me probe → list → workspace.
  if (incidents === null) return <Splash />

  // --- ErrorBoundary escapes (see lib/crashLoop) -------------------------------------------
  // «Neu laden» alone can't recover a workspace whose own data throws: boot auto-reopens the
  // last incident, so the reload lands straight back on the crash. These two give the operator
  // a way off it without a dedicated admin surface.
  //
  // Lossless: forget the remembered incident and drop to the launcher, where a DIFFERENT
  // Einsatz (or a fresh one) can be opened. Nothing is archived and nothing is deleted — the
  // crashing incident is still there, and still on the server.
  const escapeToLanding = () => {
    savePrefs({ ...loadPrefs(), incidentId: undefined })
    clearCrash()
    if (syncRef.current) { syncRef.current.dispose(); syncRef.current = null }
    setActiveId(null); setActiveMeta(null); setWorkspace(null); setForceReadOnly(false)
  }

  // Last resort, only offered after reopening has already failed once: the crash is coming from
  // the cached copy on THIS device, so drop it and reload — the next open re-pulls from the
  // server. Destructive for unsynced edits, which is why the boundary warns before offering it.
  const discardLocalAndReload = (id: string) => {
    void discardWorkspaceCache(id)
      .catch(() => {})
      .finally(() => { clearCrash(); location.reload() })
  }

  // Landing list when no incident is active: the open Einsätze to resume + the Divera alarms
  // to take, shown directly (no "Kein offener Einsatz" dead-end), with manual create always on.
  const openIncidents = incidents.filter((i) => !i.is_archived)
  // ⚠️ The alarms that will ACTUALLY render, dismissals included. `hasLanding` counted the raw
  // pool while the list below filtered out anything dismissed on this device — so once every
  // pool alarm had been ×-ed away, the card took the launcher branch, rendered an EMPTY list
  // (with its own margin) and skipped the sentence explaining what to do. A hole where the
  // explanation should be, on the one screen whose whole job is «what now».
  const landingAlarms = isEditor ? poolAlarms.filter((a) => !dismissedAlarms.has(a.divera_id)) : []
  // the Alarmquelle's own name, or null where this station has none (deploymentConfig)
  const alarmProvider = alarmProviderName()
  const hasLanding = openIncidents.length > 0 || landingAlarms.length > 0

  return (
    <>
      {showWelcome && <DemoWelcome onClose={() => { markDemoWelcomeSeen(); setShowWelcome(false) }} />}
      {/* ── Die Meldeleiste ────────────────────────────────────────────────────────────────
          ONE ranked strip for every message that has no place of its own and stays until
          somebody acts. The publishers paint nothing: each hands the strip a record, and the
          strip shows the highest-ranked one plus a +n pill for the rest (class before time —
          src/lib/meldungen.ts). It is not in the DOM at all while nothing is pending.
          ⚠️ Mounted at APP root, not in IncidentWorkspace: `NewIncidentBanner` publishes when a
          colleague takes an Einsatz or one auto-opens, and that can happen with NO incident open
          — inside the workspace the strip would not be mounted and the message would vanish.
          ⚠️ It replaced five top banners on one axis and four bottom cards on one coordinate.
          Do not add a sixth floating card: either the message has a PLACE — then it belongs in
          that surface, the way ShiftConflictNotice does — or it belongs in this strip. */}
      <Meldeleiste />
      {activeId && activeMeta && syncRef.current ? (
        <ErrorBoundary
          /* Keyed on activeId ONLY (not `remount`): a background remount — the live-follow
             poll, a resolved 409 calling onServerWorkspace — must NOT reset a latched crash,
             or the boundary re-renders the same throwing workspace in a flicker loop. It
             resets on a deliberate incident change, which is exactly what the escapes do. */
          key={`eb:${activeId}`}
          scopeId={activeId}
          onCloseIncident={escapeToLanding}
          onDiscardLocal={() => discardLocalAndReload(activeId)}
        >
        <IncidentWorkspace
          key={`${activeId}:${remount}`}
          incidentMeta={activeMeta}
          incidents={incidents}
          workspace={workspace}
          sync={syncRef.current}
          forceReadOnly={forceReadOnly}
          tabLockLost={!tabLock.held}
          onTakeOverTab={tabLock.takeOver}
          onSwitchIncident={(i) => void selectIncident(i.id, { meta: i }).catch(() => {})}
          onOpenHistory={() => setOverlay('history')}
          // «Einsatz eröffnen» goes straight to the manual wizard — the pool sheet is gone
          // (testing feedback 2026-07-18): incoming alarms are taken via the landing card or
          // the mid-incident banner, never via a separate pool screen.
          onOpenDivera={() => setOverlay('create')}
          onOpenDatenquellen={() => setOverlay('daten')}
          // ⚠️ There is no separate «archive the active one» prop any more. The Einsatz-Menü row
          // used to hang off `archiveById`, which archived plainly — no report_done_at, nothing
          // checked — while the Rapport path stamped and counted. Both doors run the SAME confirm
          // in IncidentWorkspace now and end here (mockup 06 · Fall 4).
          onCompleteRapport={() => completeRapport(activeMeta.id)}
          onReactivateActive={isEditor && activeMeta.is_archived ? () => void reactivateById(activeMeta.id) : undefined}
          onBackFromArchive={activeMeta.is_archived ? () => void backFromArchive() : undefined}
          needsReview={
            reviewPendingId === activeMeta.id ||
            needsIntakeReview(activeMeta, { isEditor, reviewed: reviewedIncidents, now: Date.now() })
          }
          onReviewDone={() => markReviewed(activeMeta.id)}
          onEditMeta={() => setEditMeta(activeMeta)}
        />
        </ErrorBoundary>
      ) : (
        <div className="ip-emptyapp">
          <IconSprite />
          <div className="ip-emptyapp-card">
            <Brand className="ip-emptyapp-brand" sub={appConfig.copy.login.subtitle} />
            {trouble && !linkScoped && (
              <FeedbackPrompt
                trouble={trouble}
                onOpen={() => { setFeedbackFor(trouble); setTrouble(null) }}
                onDismiss={() => setTrouble(null)}
              />
            )}
            {hasLanding ? (
              <div className="ip-launch-list">
                {openIncidents.map((i) => (
                  <button key={i.id} type="button" className="ip-launch" onClick={() => void selectIncident(i.id, { meta: i }).catch(() => {})}>
                    <Icon id="flag" />
                    <span className="ip-launch-main">
                      <span className="ip-launch-title">{i.title}</span>
                      <span className="ip-launch-sub">{shortAddress(i.address) ?? ''}</span>
                    </span>
                    <Icon id="chevron" />
                  </button>
                ))}
                {landingAlarms.map((a) => (
                  // the pool's ONLY surface now (the intake sheet is gone): take, or ×
                  // to hide it on THIS device only (per-device, kp.divera.dismissed) — the ×
                  // NEVER archives a live dispatch for the crew (that would be a server delete)
                  <div key={a.id} className="ip-launch alarm">
                    <button type="button" className="ip-launch-hit" disabled={taking != null} onClick={() => void takeAndOpen(a)}>
                      <span className="ip-launch-pulse"><Icon id={taking === a.divera_id ? 'rotate' : 'bell'} className={taking === a.divera_id ? 'spin' : undefined} /></span>
                      <span className="ip-launch-main">
                        <span className="ip-launch-kicker">{appConfig.copy.intake.newDiveraAlarm}</span>
                        <span className="ip-launch-title">{a.title}</span>
                        <span className="ip-launch-sub">{shortAddress(a.address) ?? appConfig.copy.intake.addressUnknown}</span>
                      </span>
                      <span className="ip-launch-go">{taking === a.divera_id ? appConfig.copy.intake.alarmOpening : appConfig.copy.intake.alarmOpen}</span>
                    </button>
                    <button
                      type="button" className="ip-launch-x" aria-label={appConfig.copy.intake.dismiss} disabled={taking != null}
                      onClick={() => setDismissedAlarms(dismissAlarm(a.divera_id))}
                    >
                      <Icon id="close" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              // archived Einsätze deliberately do NOT surface here (they live in the
              // Verlauf, one tap below) — with nothing open the intro sentence is enough.
              // A link session only ever lands here when ITS incident couldn't be fetched
              // (signal lost between the link and the incident) — say that instead of an
              // "eröffne einen Einsatz" it can't act on.
              // ⚠️ «übernimm einen Divera-Alarm» only where there IS an Alarmquelle, and named
              // after whichever one this station runs. Every station saw the Divera sentence —
              // including the ones on another source and the ones entering every Einsatz by
              // hand, who were pointed at a product they do not have.
              <p className="ip-emptyapp-none">{
                linkScoped ? appConfig.copy.incidentLink.unavailable
                  : !isEditor ? appConfig.copy.emptyApp.bodyViewer
                    : alarmProvider ? fillTemplate(appConfig.copy.emptyApp.bodyEditorAlarm, { provider: alarmProvider })
                      : appConfig.copy.emptyApp.bodyEditor
              }</p>
            )}
            <div className="ip-emptyapp-actions">
              {isEditor && (
                <button className="ip-btn primary block" onClick={() => setOverlay('create')}>
                  <Icon id="plus" />{appConfig.copy.intake.manualIncident}
                </button>
              )}
              {/* Verlauf lists OTHER incidents — not on the link allowlist, and not this
                  responder's business either */}
              {!linkScoped && (
                <div className="ip-emptyapp-secondary">
                  <button className="ip-btn" onClick={() => setOverlay('history')}>{appConfig.copy.emptyApp.history}</button>
                </div>
              )}
            </div>
            {/* footer: who is signed in (same identity card as the in-incident menu) plus the
                app-level utilities that exist without an incident — settings, help, install */}
            <div className="ip-emptyapp-foot">
              <div className="ip-menu-user">
                <span className="ip-menu-av" style={{ background: user?.color ?? 'var(--ink-faint)' }}>{initials(user?.display_name ?? '')}</span>
                <span className="ip-menu-userinfo">
                  <span className="ip-menu-username">{user?.display_name ?? ''}</span>
                  <span className="ip-menu-userrole">{roleLabel(user?.role ?? 'viewer')}</span>
                </span>
                {/* no Abmelden on a link session: there is no login to leave, /api/auth/logout
                    is refused, and tapping it would strand a responder with no way back in */}
                {!linkScoped && <button className="ip-foot-logout" onClick={() => void logout()}><Icon id="logout" />{appConfig.copy.incidentSwitcher.logout}</button>}
              </div>
              <div className="ip-emptyapp-utils">
                <button className="ip-foot-util" onClick={() => setLandingSheet('settings')}><Icon id="gear" />{appConfig.copy.settings.title}</button>
                <button className="ip-foot-util" onClick={() => setLandingSheet('help')}><Icon id="info" />{appConfig.copy.help.menu}</button>
                {!isStandalone() && installOffered(getInstallPlatform()) && (
                  <button className="ip-foot-util" onClick={() => setLandingSheet('install')}><Icon id="share-ios" />{appConfig.copy.install.menu}</button>
                )}
              </div>
            </div>
            <div className="ip-emptyapp-ver">{buildLabel()}</div>
          </div>
          {landingSheet === 'settings' && (
            <LandingSettings
              onClose={() => setLandingSheet(null)}
              // Rückmeldung posts a diagnostic report — refused for a link session
              onFeedback={linkScoped ? undefined : () => { setLandingSheet(null); setFeedbackFor('plain') }}
            />
          )}
          {landingSheet === 'help' && <HelpOverlay onClose={() => setLandingSheet(null)} />}
          {landingSheet === 'install' && <InstallGuide onClose={() => setLandingSheet(null)} />}
          {feedbackFor && (
            <FeedbackSheet
              trouble={feedbackFor === 'plain' ? undefined : feedbackFor}
              onClose={() => setFeedbackFor(null)}
            />
          )}
        </div>
      )}

      {/* incoming-alarm banner: a fresh dispatch finds the EL MID-INCIDENT, one tap from
          opening on the live map (the landing announces alarms via its launch card — one
          surface per screen). Anhängen attaches to the ACTIVE incident (split dispatch). */}
      {isEditor && activeMeta != null && (
        <IncomingAlarmBanner
          alarms={poolAlarms}
          taking={taking}
          onTake={(a) => void takeAndOpen(a)}
          onAttach={(a) => void attachToActive(a)}
        />
      )}

      {/* auto-opened / colleague-taken incident announced, never forced. Suppressed while
          untaken pool alarms exist — the take banner owns that spot and the take flow. */}
      {freshIncident && poolAlarms.length === 0 && (
        <NewIncidentBanner
          inc={freshIncident}
          active={!!activeId}
          onSwitch={() => {
            const f = freshIncident
            dismissFreshIncident()
            void selectIncident(f.id, { meta: f }).catch(() => {})
          }}
          onDismiss={dismissFreshIncident}
        />
      )}

      {(overlay === 'create' || editMeta) && (
        <EinsatzWizard
          edit={editMeta}
          nearCoord={activeMeta?.lng != null && activeMeta?.lat != null ? [activeMeta.lng, activeMeta.lat] : null}
          onClose={() => { setOverlay(null); setEditMeta(null) }}
          // ⚠️ A CORRECTION does not remount. `openCreated` re-keys IncidentWorkspace, which is
          // right when an Einsatz is opened and wrong when one is corrected: it threw the
          // operator out of whatever surface they were on (the Rapport, usually — that is where
          // the «Bearbeiten» link lives) and reset the print section toggles and the Kroki
          // reconstruction with it. `reflectMeta` is what reflects a patch in place instead.
          onCreated={(inc) => {
            const wasEdit = !!editMeta
            setEditMeta(null)
            markReviewed(inc.id)
            if (wasEdit) { setOverlay(null); reflectMeta(inc as IncidentMeta) } else void openCreated(inc)
          }}
        />
      )}
      {overlay === 'history' && (
        <HistoryPanel onClose={() => setOverlay(null)} onOpen={(id, ro) => { setOverlay(null); void selectIncident(id, { readOnly: ro }) }}
          onArchive={isEditor ? archiveById : undefined} />
      )}
      {overlay === 'daten' && (
        <DatenquellenPanel
          isEditor={isEditor}
          incidentCoord={activeMeta?.lng != null && activeMeta?.lat != null ? [activeMeta.lng, activeMeta.lat] : null}
          onClose={() => setOverlay(null)}
        />
      )}

      {/* toast/confirm host — LAST at the ROOT, not inside the workspace's .app div:
          position:fixed makes .app a stacking context, so a confirm opened from a
          root-level sheet (e.g. Reaktivieren in «Alle Einsätze») painted UNDER the
          sheet regardless of its own z-index, and the landing screen had no host at
          all (confirms silently never appeared). Root + last ⇒ always on top. */}
      <Overlays />
    </>
  )
}
