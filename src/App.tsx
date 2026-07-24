import { useCallback, useEffect, useRef, useState } from 'react'
import './app.css'
import { IconSprite, Icon } from './lib/icons'
import { rebaseDemoClocks, type Saved } from './lib/workspace'
import { appConfig } from './config/appConfig'
import { shortAddress, isDemoMode } from './lib/deploymentConfig'
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
import { clearIncidentMedia } from './lib/mediaQueue'
import { ensurePushSubscription } from './lib/push'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useAuth } from './lib/auth'
import { IncidentWorkspace } from './IncidentWorkspace'
import {
  WorkspaceSync, listIncidentsResilient, getIncident, archiveIncident, reactivateIncident,
  migrateLegacyWorkspace, takeDiveraAlarm, patchIncident, attachDiveraAlarm,
  type DiveraAlarm, type IncidentFull, type IncidentMeta,
} from './lib/incidents'
import { ApiError } from './lib/api'
import { useDiveraWatch } from './lib/useDiveraWatch'
import { dismissAlarm, loadDismissedAlarms } from './lib/diveraDismiss'
import { useIncidentWatch } from './lib/useIncidentWatch'
import { pickBootIncident, sameIncidentList } from './lib/incidentAlerts'
import { EinsatzWizard, DatenquellenPanel, HistoryPanel, IncomingAlarmBanner, NewIncidentBanner, SettingsSheet } from './components/panels'
import { HelpOverlay } from './components/HelpOverlay'


// ---------------------------------------------------------------------------------
// Incident root: owns the incident list, the active selection, and the per-incident
// WorkspaceSync. The workspace below is keyed by incident id so switching remounts it,
// hydrating cleanly from that incident's own blob.
// ---------------------------------------------------------------------------------
/** Einstellungen opened from the landing card (no incident): device prefs only. Owns the
 *  pref state itself (mounted only while open, reads/writes the prefs cookie directly);
 *  the synced per-incident section is hidden by omitting settings/onSettings. */
function LandingSettings({ onClose }: { onClose: () => void }) {
  const { symbolSize, setSymbolSize, symbolCaptions, setSymbolCaptions, offlineRadiusM, setOfflineRadiusM, keepScreenOn, setKeepScreenOn } = useDevicePrefs()
  useEffect(() => {
    savePrefs({ ...loadPrefs(), symbolSize, symbolCaptions, offlineRadiusM, keepScreenOn })
  }, [symbolSize, symbolCaptions, offlineRadiusM, keepScreenOn])
  return (
    <SettingsSheet
      onClose={onClose}
      symbolSize={symbolSize}
      onSymbolSize={setSymbolSize}
      symbolCaptions={symbolCaptions}
      onSymbolCaptions={setSymbolCaptions}
      offlineRadiusM={offlineRadiusM}
      onOfflineRadius={setOfflineRadiusM}
      keepScreenOn={keepScreenOn}
      onKeepScreenOn={setKeepScreenOn}
      themeCoord={null}
      elView={false}
    />
  )
}

export default function App() {
  const { user, logout } = useAuth()
  const isEditor = user?.role === 'editor'

  // register this browser for server push once per session (no-op unless notification
  // permission is already granted AND the deployment has VAPID keys) — killed-app alarms.
  useEffect(() => { void ensurePushSubscription() }, [])

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
  // Divera alarm handed to the intake wizard for review/override (null = manual create)
  const [wizardSeed, setWizardSeed] = useState<DiveraAlarm | null>(null)
  // existing incident opened in the wizard for in-place correction (PATCH, not create)
  const [editMeta, setEditMeta] = useState<IncidentMeta | null>(null)
  // always-on Divera watch: surfaces fresh alarms wherever the EL is (editor only)
  const { alarms: poolAlarms, refresh: refreshPool } = useDiveraWatch(isEditor)
  // per-device dismiss of pool alarms (kp.divera.dismissed) — «×» hides a dispatch on THIS
  // tablet only; it never archives it for the crew. Shared store with the incoming-alarm banner.
  const [dismissedAlarms, setDismissedAlarms] = useState<Set<number>>(loadDismissedAlarms)
  // always-on incident-list watch: with alarm auto-open an Einsatz can appear with no human
  // in the loop — keep the list fresh and announce mid-session arrivals (banner, never a
  // forced switch). Enabled for viewers too; announcing is read-only.
  const onWatchList = useCallback((list: IncidentMeta[]) => {
    setIncidents((prev) => (sameIncidentList(prev, list) ? prev : list))
  }, [])
  const { fresh: freshIncident, dismiss: dismissFreshIncident } = useIncidentWatch(!!user, activeId, onWatchList)

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
  // incident just taken one-tap → show the correct-in-place review banner until confirmed
  const [reviewPendingId, setReviewPendingId] = useState<string | null>(null)
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

  const selectIncident = useCallback(async (id: string, opts: { readOnly?: boolean; meta?: IncidentMeta } = {}) => {
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
    // Demo: rebase the SCBA clocks to page-load so a late visitor doesn't land on an overdue
    // alarm (the seed's clocks are as-of the last 2 h reset). Read-only fetch, display only.
    const seed = ws ? (isDemoMode() ? rebaseDemoClocks(ws as unknown as Saved, Date.now()) : (ws as unknown as Saved)) : null
    setWorkspace(seed)
    setForceReadOnly(!!opts.readOnly)
    setActiveId(id)
    setRemount((n) => n + 1)
    savePrefs({ ...loadPrefs(), incidentId: id })
  }, [])

  // boot: list → migrate legacy localStorage if empty → open remembered/first incident.
  // Offline (network error), fall back to the cached list so the last incident reopens
  // from the WorkspaceSync cache — with an honest one-shot toast that the list is cached.
  useEffect(() => {
    void (async () => {
      let { list, offline } = await listIncidentsResilient().catch(() => ({ list: [] as IncidentMeta[], offline: false }))
      if (list.length === 0 && !offline) {
        await migrateLegacyWorkspace([appConfig.storage.key, ...appConfig.storage.legacyKeys]).catch(() => null)
        list = (await listIncidentsResilient().catch(() => ({ list: [] as IncidentMeta[] }))).list
      }
      if (offline) toast(appConfig.copy.incidentSwitcher.bootOffline, { icon: 'warn' })
      setIncidents(list)
      // Remembered incident normally wins, but a NEWER alarm-created incident takes
      // precedence: a killed app reopens onto the live alarm, not yesterday's Einsatz.
      const pick = pickBootIncident(list, loadPrefs().incidentId)
      if (pick) await selectIncident(pick.id, { meta: pick }).catch(() => {})
    })()
  }, [selectIncident])

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
    await archiveIncident(id).catch(() => {})
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

  // In-place metadata correction from the review banner (category) — patch + reflect in the
  // active meta and list without remounting the workspace (no location/center change).
  const patchActiveMeta = useCallback(async (patch: Partial<IncidentMeta>) => {
    if (!activeId) return
    try {
      const updated = await patchIncident(activeId, patch)
      setActiveMeta(updated as IncidentMeta)
      setIncidents((list) => (list ?? []).map((i) => (i.id === updated.id ? (updated as IncidentMeta) : i)))
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : appConfig.copy.errors.updateFailed, { icon: 'warn', tone: 'warn' })
    }
  }, [activeId])

  // Archive ANY incident from the switcher list (per-incident, not just the active one).
  // Archiving the active one flushes + tears down its live sync and re-opens the next
  // incident; archiving a background one just removes it and leaves the current one open.
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
    if (id === activeId) {
      if (syncRef.current) { await syncRef.current.flush().catch(() => {}); syncRef.current.dispose(); syncRef.current = null }
      await archiveIncident(id).catch(() => {})
      await clearIncidentMedia(id).catch(() => {})
      const list = await refreshList()
      setActiveId(null); setActiveMeta(null)
      if (list[0]) await selectIncident(list[0].id, { meta: list[0] })
    } else {
      await archiveIncident(id).catch(() => {})
      await clearIncidentMedia(id).catch(() => {})
      await refreshList()
    }
  }, [activeId, refreshList, selectIncident])

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

  // Reactivate an archived incident (the ArchivedBanner action) — as deliberate as archiving:
  // the mirror confirm also teaches the consequences (Nachträge, «geändert nach Abschluss»).
  // On confirm the same incident reopens EDITABLE (readOnly false ⇒ it rejoins the open list).
  const reactivateById = useCallback(async (id: string) => {
    const h = appConfig.copy.history
    const ok = await confirmDialog({
      title: h.reactivateConfirmTitle,
      message: h.reactivateConfirmMsg,
      confirmLabel: h.reactivateConfirmBtn,
      cancelLabel: appConfig.copy.cancel,
    })
    if (!ok) return
    await reactivateIncident(id).catch(() => {})
    await refreshList()
    await selectIncident(id, { readOnly: false }).catch(() => {})
  }, [refreshList, selectIncident])

  // Abschluss-Assistent finished (its own confirm covered the decision): flush the last
  // workspace edits, stamp report_done_at, archive, and move on — one action, no second
  // dialog. Late corrections stay possible (reactivate / Nachträge) and flip the derived
  // chip to «geändert nach Abschluss».
  const completeRapport = useCallback(async (id: string) => {
    if (isDemoMode()) { toast(appConfig.copy.demo.actionBlocked, { icon: 'info' }); return }
    try {
      if (id === activeId && syncRef.current) await syncRef.current.flush().catch(() => {})
      await patchIncident(id, { report_done_at: new Date().toISOString() })
      await archiveIncident(id).catch(() => {})
      await clearIncidentMedia(id).catch(() => {})
      toast(appConfig.copy.abschluss.done, { icon: 'check', tone: 'success' })
      if (id === activeId) {
        if (syncRef.current) { syncRef.current.dispose(); syncRef.current = null }
        const list = await refreshList()
        setActiveId(null); setActiveMeta(null)
        if (list[0]) await selectIncident(list[0].id, { meta: list[0] })
      } else {
        await refreshList()
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : appConfig.copy.abschluss.failed, { icon: 'warn', tone: 'warn' })
    }
  }, [activeId, refreshList, selectIncident])

  // Incident list still loading after auth: keep the boot Splash up rather than a blank
  // colour flash, so the launch stays continuous from /me probe → list → workspace.
  if (incidents === null) return <Splash />

  // Landing list when no incident is active: the open Einsätze to resume + the Divera alarms
  // to take, shown directly (no "Kein offener Einsatz" dead-end), with manual create always on.
  const openIncidents = incidents.filter((i) => !i.is_archived)
  const hasLanding = openIncidents.length > 0 || (isEditor && poolAlarms.length > 0)

  return (
    <>
      {showWelcome && <DemoWelcome onClose={() => { markDemoWelcomeSeen(); setShowWelcome(false) }} />}
      {activeId && activeMeta && syncRef.current ? (
        <ErrorBoundary key={`eb:${activeId}:${remount}`}>
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
          onOpenDivera={() => { setWizardSeed(null); setOverlay('create') }}
          onOpenDatenquellen={() => setOverlay('daten')}
          onCompleteRapport={() => void completeRapport(activeMeta.id)}
          onArchiveActive={isEditor && !activeMeta.is_archived ? () => void archiveById(activeMeta.id) : undefined}
          onReactivateActive={isEditor && activeMeta.is_archived ? () => void reactivateById(activeMeta.id) : undefined}
          onBackFromArchive={activeMeta.is_archived ? () => void backFromArchive() : undefined}
          needsReview={reviewPendingId != null && reviewPendingId === activeMeta.id}
          onReviewDone={() => setReviewPendingId(null)}
          onEditMeta={() => setEditMeta(activeMeta)}
          onPatchMeta={(patch) => void patchActiveMeta(patch)}
        />
        </ErrorBoundary>
      ) : (
        <div className="ip-emptyapp">
          <IconSprite />
          <div className="ip-emptyapp-card">
            <Brand className="ip-emptyapp-brand" sub={appConfig.copy.login.subtitle} />
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
                {isEditor && poolAlarms.filter((a) => !dismissedAlarms.has(a.divera_id)).map((a) => (
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
              // Verlauf, one tap below) — with nothing open the intro sentence is enough
              <p className="ip-emptyapp-none">{isEditor ? appConfig.copy.emptyApp.bodyEditor : appConfig.copy.emptyApp.bodyViewer}</p>
            )}
            <div className="ip-emptyapp-actions">
              {isEditor && (
                <button className="ip-btn primary block" onClick={() => { setWizardSeed(null); setOverlay('create') }}>
                  <Icon id="plus" />{appConfig.copy.intake.manualIncident}
                </button>
              )}
              <div className="ip-emptyapp-secondary">
                <button className="ip-btn" onClick={() => setOverlay('history')}>{appConfig.copy.emptyApp.history}</button>
              </div>
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
                <button className="ip-foot-logout" onClick={() => void logout()}><Icon id="logout" />{appConfig.copy.incidentSwitcher.logout}</button>
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
          {landingSheet === 'settings' && <LandingSettings onClose={() => setLandingSheet(null)} />}
          {landingSheet === 'help' && <HelpOverlay onClose={() => setLandingSheet(null)} />}
          {landingSheet === 'install' && <InstallGuide onClose={() => setLandingSheet(null)} />}
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
          seed={editMeta ? null : wizardSeed}
          edit={editMeta}
          nearCoord={activeMeta?.lng != null && activeMeta?.lat != null ? [activeMeta.lng, activeMeta.lat] : null}
          onClose={() => { setWizardSeed(null); setOverlay(null); setEditMeta(null) }}
          onCreated={(inc) => { setWizardSeed(null); setEditMeta(null); setReviewPendingId(null); void openCreated(inc) }}
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
