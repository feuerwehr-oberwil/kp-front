import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { initials, roleLabel, fillTemplate, fmtElapsedHM } from '../../lib/format'
import { buildLabel } from '../../lib/buildInfo'
import { useIsPhone } from '../../lib/useIsPhone'
import { appConfig } from '../../config/appConfig'
import { shortAddress } from '../../lib/deploymentConfig'
import type { IncidentMeta, SyncStatus } from '../../lib/incidents'

// HH:MM for the positive "gespeichert" trust signal next to the sync badge.
function fmtClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// --- TopBar switcher ----------------------------------------------------------------
export function IncidentSwitcher({
  active, incidents, isEditor, syncStatus, lastSyncedAt, user, onSettings, onSwitch, onHistory, onDivera, onReportPrint, onArchive, onHelp, onInstall, onOfflineReadiness, onSyncNow, onLogout, navKey, objectName, onObjectSwitch,
}: {
  active: IncidentMeta | null
  incidents: IncidentMeta[]
  isEditor: boolean
  syncStatus: SyncStatus
  lastSyncedAt: number | null
  user: { display_name: string; color: string | null; role: string }
  /** open the Einstellungen sheet (device prefs + synced incident settings) */
  onSettings: () => void
  onSwitch: (i: IncidentMeta) => void
  onHistory: () => void
  onDivera: () => void
  onDatenquellen: () => void
  onReportPrint: () => void
  /** archive the ACTIVE incident (behind the caller's «wirklich abschliessen?» confirm);
   *  absent for viewers / read-only views / an already-archived incident */
  onArchive?: () => void
  onHelp: () => void
  /** open the "Als App installieren" guide — App passes it only in a plain browser tab */
  onInstall?: () => void
  onOfflineReadiness: () => void
  /** push edits queued while offline (also auto-fires on reconnect) */
  onSyncNow: () => void
  onLogout: () => void
  /** changes whenever the app navigates to another surface — closes a menu that was left
   *  open under a sheet (e.g. Rapport → Anwesenheit must not land back in the menu) */
  navKey?: string
  /** active Einsatzobjekt (manual pick or auto-surfaced nearest); shown on the object row */
  objectName?: string | null
  /** open the PlanPicker («Anderes Objekt») — the row replaces the old NavRail footer item */
  onObjectSwitch?: () => void
}) {
  const cp = appConfig.copy.incidentSwitcher
  const badgeTitle: Record<Exclude<SyncStatus, 'synced'>, string> = {
    pending: cp.badgePending, offline: cp.badgeOffline, error: cp.badgeError,
  }
  const [open, setOpen] = useState(false)
  // Einsatzbeginn/-dauer row in the dropdown (phones hide the TopBar clocks, so the times
  // live here) — tick once a minute while open so the Dauer stays current
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [open])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // clicks inside an overlay sheet/dialog don't count as "outside": on phones the menu
    // deliberately stays open underneath a sheet it opened (see openSheet below)
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Element
      if (ref.current && !ref.current.contains(t) && !t.closest?.('.ip-sheet, .ui-backdrop, .help-scrim, .confirm-backdrop, .toaster')) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  // On phones a sheet opened from the menu keeps the menu open underneath (the overlay
  // covers it), so closing the sheet lands back in the menu instead of on the map — no
  // re-tapping the dropdown between two lookups. Desktop closes as usual (the floating
  // menu would sit beside the sheet there). Incident switch/eröffnen/logout always close.
  const isPhone = useIsPhone()
  const openSheet = (fn: () => void) => { fn(); if (!isPhone) setOpen(false) }
  // …but a sheet action that NAVIGATES (Rapport → Anwesenheit/Mittel/Verlauf) must not
  // leave the menu sitting on the new surface — any surface change closes it
  useEffect(() => { setOpen(false) }, [navKey])

  // Sync state surfaced two ways: a FIXED-WIDTH coloured mark in the header (so the constant
  // saving↔saved flip never shifts the title/chevron — no inline time/label), and the full
  // text + save time in the dropdown the user taps open (hover tooltips don't fire on a tablet).
  const savedText = syncStatus === 'synced'
    ? (lastSyncedAt != null ? fillTemplate(cp.savedAt, { t: fmtClock(lastSyncedAt) }) : cp.saved)
    : badgeTitle[syncStatus]
  const statusMark = syncStatus === 'synced'
    ? <Icon id="check" />
    : syncStatus === 'error'
      ? <Icon id="warn" />
      : <span className="ip-status-dot" />
  return (
    <div className="ip-switch" ref={ref}>
      <button className="ip-switch-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {/* phones: the title is CSS-hidden (a one-letter stump helped nobody) — a doc glyph
            marks the button; the full title heads the dropdown instead */}
        <span className="ip-switch-glyph" aria-hidden><Icon id="doc" /></span>
        <span className="ip-switch-title">{active ? active.title : cp.noIncident}</span>
        {/* persistent ÜBUNG marker in the chrome — a training must never read as a real
            Einsatz mid-use (it also survives the phone's CSS-hidden title) */}
        {active?.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
        {/* Offline and sync-error get a LOUD text chip (not just the tiny mark) — offline
            blocks switching incidents to the server, and a failing sync means edits are
            stranded on this device; the operator needs to recognise both at a glance
            WITHOUT opening the dropdown (there is deliberately no persistent banner). */}
        {active && syncStatus === 'offline' ? (
          <span className="ip-offline-chip" title={savedText} aria-label={savedText}>
            <span className="ip-status-dot" />{cp.offlineShort}
          </span>
        ) : active && syncStatus === 'error' ? (
          <span className="ip-offline-chip ip-error-chip" title={savedText} aria-label={savedText}>
            <Icon id="warn" />{cp.errorShort}
          </span>
        ) : active && (
          <span className={`ip-status ip-status-${syncStatus}`} title={savedText} aria-label={savedText}>
            {statusMark}
          </span>
        )}
        <Icon id="chevron-down" />
      </button>
      {open && (
        <div className="ip-menu">
          {/* Three zones (field feedback 2026-07-09): ① the current incident as a plain
              HEADER card — title (phone-only, the button shows it on larger screens),
              address, two small meta lines, icon-only Sync — plus its actions
              (Einsatzrapport, Einsatz abschliessen); ② Einsätze — the OTHER incidents +
              eröffnen + alle, all as rows; ③ utility rows + user. The round-4 rule was "no
              destructive actions in this menu" (a stray per-row ✕ closed old incidents in
              one tap); the labeled «abschliessen» row below is the sanctioned exception
              (field request 2026-07-12): it goes through the same «wirklich abschliessen?»
              confirm as «Alle Einsätze», and archiving stays reversible via Reaktivieren.
              Closing OTHER incidents still lives only in «Alle Einsätze». */}
          {active && (
            <>
              <div className="ip-menu-head">
                <div className="ip-menu-headmain">
                  <span className="ip-menu-headtitle">
                    {active.title}
                    {active.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
                  </span>
                  {active.address && <span className="ip-menu-sub">{active.address}</span>}
                  <span className={`ip-menu-metaline ip-status-${syncStatus}`}>{statusMark}<span>{savedText}</span></span>
                  {active.started_at && (
                    <span className="ip-menu-metaline"><Icon id="clock" /><span>{fillTemplate(cp.startedRow, { t: fmtClock(Date.parse(active.started_at)), d: fmtElapsedHM(now - Date.parse(active.started_at)) })}</span></span>
                  )}
                </div>
                {/* always offered (not only on offline/error): forces a push AND an immediate
                    pull, the "make everything fresh right now" action when things feel stale */}
                <button className="ip-menu-resync" onClick={() => { onSyncNow(); }} aria-label={cp.syncNow} title={cp.syncNow}>
                  <Icon id="rotate" />
                </button>
              </div>
              {/* Einsatzdaten editing lives inside the Einsatzrapport (its "Bearbeiten" link),
                  not as a second menu entry — see ReportPreflight. */}
              <button className="ip-menu-act" onClick={() => openSheet(onReportPrint)}><Icon id="doc" /> {cp.report}</button>
              {/* Einsatzobjekt row — shows WHICH object's plans are loaded and opens the
                  PlanPicker (replaces the old NavRail footer swap item, 2026-07-14) */}
              {onObjectSwitch && (
                <button className="ip-menu-act" onClick={() => openSheet(onObjectSwitch)}>
                  <Icon id="pen" /> {objectName ? fillTemplate(cp.objectRow, { name: objectName }) : appConfig.copy.whiteboard.otherObject}
                </button>
              )}
              {onArchive && (
                <button className="ip-menu-act" onClick={() => { setOpen(false); onArchive() }}><Icon id="check" /> {cp.archive}</button>
              )}
              <div className="ip-menu-sep" />
            </>
          )}
          <div className="ip-menu-label">{cp.incidents}</div>
          {incidents.length === 0 && !active && <div className="ip-menu-empty">{cp.noOpenIncidents}</div>}
          {incidents.filter((i) => i.id !== active?.id).map((i) => (
            <div key={i.id} className="ip-menu-row">
              <button className="ip-menu-rowmain" onClick={() => { onSwitch(i); setOpen(false) }}>
                <span className="ip-menu-title">
                  {i.title}
                  {i.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
                </span>
                <span className="ip-menu-sub">{shortAddress(i.address) ?? i.status}</span>
              </button>
            </div>
          ))}
          {isEditor && <button className="ip-menu-act" onClick={() => { onDivera(); setOpen(false) }}><Icon id="plus" /> {appConfig.copy.intake.titleNew}</button>}
          <button className="ip-menu-act" onClick={() => openSheet(onHistory)}><Icon id="history" /> {cp.allIncidents}</button>
          <div className="ip-menu-sep" />
          <button className="ip-menu-act" onClick={() => openSheet(onSettings)}><Icon id="gear" /> {appConfig.copy.settings.title}</button>
          {active && <button className="ip-menu-act" onClick={() => openSheet(onOfflineReadiness)}><Icon id="snapshot" /> {appConfig.copy.offline.title}</button>}
          <button className="ip-menu-act" onClick={() => openSheet(onHelp)}><Icon id="info" /> {appConfig.copy.help.menu}</button>
          {onInstall && <button className="ip-menu-act" onClick={() => openSheet(onInstall)}><Icon id="share-ios" /> {appConfig.copy.install.menu}</button>}
          <div className="ip-menu-sep" />
          <div className="ip-menu-user">
            <span className="ip-menu-av" style={{ background: user.color ?? 'var(--ink-faint)' }}>{initials(user.display_name)}</span>
            <span className="ip-menu-userinfo">
              <span className="ip-menu-username">{user.display_name}</span>
              <span className="ip-menu-userrole">{roleLabel(user.role)}</span>
            </span>
            <button className="ip-menu-logout" onClick={() => { onLogout(); setOpen(false) }}><Icon id="logout" /> {cp.logout}</button>
          </div>
          <div className="ip-menu-foot">
            {/* No manual "check for updates" — a fresh deploy surfaces itself via the automatic
                "Neue Version verfügbar" banner (UpdateBanner / swUpdate). Just the build label here. */}
            <span className="ip-menu-ver" title={cp.appVersion}>{buildLabel()}</span>
          </div>
        </div>
      )}
    </div>
  )
}
