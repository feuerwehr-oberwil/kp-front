import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { initials, roleLabel, fillTemplate, fmtElapsedHM } from '../../lib/format'
import { buildLabel } from '../../lib/buildInfo'
import { useIsPhone } from '../../lib/useIsPhone'
import { appConfig } from '../../config/appConfig'
import { toast } from '../../lib/ui'
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

/**
 * The sync glyph: one SVG that spins as an open arc and then closes into a full ring with a
 * tick drawn through it. Deliberately ONE element rather than a spinner swapped for a check —
 * the ring is the same circle throughout, so the eye follows it from "working" to "done"
 * instead of seeing two unrelated icons flash past.
 *
 * The circle is r=9 → circumference ≈ 56.5; the dash values in .sync-ring/.sync-tick are cut
 * to that, so changing the radius means re-cutting them (see app.css).
 */
function SyncGlyph({ done, label }: { done: boolean; label: string }) {
  return (
    <svg className={`sync-glyph${done ? ' on' : ''}`} viewBox="0 0 24 24" role="img" aria-label={label}>
      <circle className="sync-ring" cx="12" cy="12" r="9" />
      <path className="sync-tick" d="M7.8 12.4l2.9 2.9 5.6-6.1" />
    </svg>
  )
}

// --- TopBar switcher ----------------------------------------------------------------
export function IncidentSwitcher({
  active, incidents, isEditor, syncStatus, lastSyncedAt, user, onSettings, onSwitch, onHistory, onDivera, onArchive, onHelp, onInstall, onOfflineReadiness, onSyncNow, onLogout, navKey,
}: {
  active: IncidentMeta | null
  incidents: IncidentMeta[]
  isEditor: boolean
  syncStatus: SyncStatus
  lastSyncedAt: number | null
  user: { display_name: string; color: string | null; role: string }
  /** open the Einstellungen sheet (device prefs + synced incident settings) */
  /** Omitted hides the Einstellungen row — an Einsatz-Link has no device or incident
      settings to change, and every write behind them is refused anyway. */
  onSettings?: () => void
  onSwitch: (i: IncidentMeta) => void
  /** «Alle Einsätze» — absent for an Einsatz-Link session, which may only ever see its own */
  onHistory?: () => void
  onDivera: () => void
  onDatenquellen: () => void
  /** Einsatzrapport (PDF / Drucken) — absent for an Einsatz-Link session, which may not
   *  generate documents or reach the station printer */
  /** archive the ACTIVE incident (behind the caller's «wirklich abschliessen?» confirm);
   *  absent for viewers / read-only views / an already-archived incident */
  onArchive?: () => void
  onHelp: () => void
  /** open the "Als App installieren" guide — App passes it only in a plain browser tab */
  onInstall?: () => void
  onOfflineReadiness: () => void
  /** push edits queued while offline (also auto-fires on reconnect) */
  /** awaited so the button can spin for the round trip and report the outcome */
  onSyncNow: () => void | Promise<void>
  /** absent for an Einsatz-Link session — there is no login to leave and no way back in */
  onLogout?: () => void
  /** changes whenever the app navigates to another surface — closes a menu that was left
   *  open under a sheet (e.g. Rapport → Anwesenheit must not land back in the menu) */
  navKey?: string
}) {
  const cp = appConfig.copy.incidentSwitcher
  // «Jetzt synchronisieren» reports what it did on the button itself: the ring spins for the
  // round trip, then closes and draws a tick. Success needs no words — a toast for «alles
  // synchronisiert» was a sentence to read for the most boring outcome there is. Offline and
  // failure still get one, because those change what the operator should do next.
  const [syncPhase, setSyncPhase] = useState<'idle' | 'busy' | 'done'>('idle')
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (doneTimer.current) clearTimeout(doneTimer.current) }, [])
  const runSyncNow = async () => {
    if (syncPhase === 'busy') return
    if (doneTimer.current) clearTimeout(doneTimer.current)
    setSyncPhase('busy')
    // a round trip on a fast connection can finish in ~50 ms; without a floor the ring would
    // flick past too quickly to read as anything, and the tick would look like a glitch
    const floor = new Promise((r) => setTimeout(r, 420))
    try {
      await Promise.all([onSyncNow(), floor])
      if (!navigator.onLine) { setSyncPhase('idle'); toast(cp.syncOfflineToast, { icon: 'warn', tone: 'warn' }); return }
      setSyncPhase('done')
      // 2.5s, not the ~1.5s that feels right when you already know it is coming: the tick is
      // the only confirmation there is now, and someone who taps and then looks up must still
      // find it there. It costs nothing to leave it — the button stays usable throughout.
      doneTimer.current = setTimeout(() => setSyncPhase('idle'), 2500)
    } catch {
      setSyncPhase('idle')
      toast(cp.syncFailedToast, { icon: 'warn', tone: 'warn' })
    }
  }
  const badgeTitle: Record<Exclude<SyncStatus, 'synced'>, string> = {
    pending: cp.badgePending, offline: cp.badgeOffline, error: cp.badgeError, storage: cp.badgeStorage,
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
    : syncStatus === 'error' || syncStatus === 'storage'
      ? <Icon id="warn" />
      : <span className="ip-status-dot" />
  const otherIncidents = incidents.filter((i) => i.id !== active?.id)
  const showIncidents = otherIncidents.length > 0 || isEditor || !!onHistory || (incidents.length === 0 && !active)
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
        {/* Storage-full is the loudest of the three: offline and sync-error both still mean the
            work is safely cached on this device, this one means it is not saved ANYWHERE. */}
        {active && syncStatus === 'storage' ? (
          <span className="ip-offline-chip ip-error-chip" title={savedText} aria-label={savedText}>
            <Icon id="warn" />{cp.storageShort}
          </span>
        ) : active && syncStatus === 'offline' ? (
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
          {/* Three zones (field feedback 2026-07-09), and each one now SAYS which it is: ① THIS
              Einsatz as a plain HEADER card — title (phone-only, the button shows it on larger
              screens), address, two small meta lines, icon-only Sync — plus «Einsatz
              abschliessen»; ② «Einsätze» — WHICH Einsatz: the others + eröffnen + alle; ③ «App»
              — the rows that have nothing to do with any Einsatz, then the user. The zones were
              only ever separated by hairlines, so a row's scope had to be inferred from the
              company it kept; the two labels are what the admin sidebar does with its nav, and
              they cost one line each. The head card needs no label — it names itself.
              The round-4 rule was "no destructive actions in this menu" (a stray per-row ✕
              closed old incidents in one tap); the «abschliessen» row is the sanctioned
              exception (field request 2026-07-12): it goes through the same «wirklich
              abschliessen?» confirm as «Alle Einsätze», and archiving stays reversible via
              Reaktivieren. Closing OTHER incidents still lives only in «Alle Einsätze». */}
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
                {/* It has to LOOK like it ran. On an already-synced Einsatz — the normal case —
                    the status line above says «gerade eben synchronisiert» both before and after
                    the tap, so without this the button read as broken. */}
                <button className={`ip-menu-resync sync-${syncPhase}`} disabled={syncPhase === 'busy'}
                  aria-busy={syncPhase === 'busy'} onClick={() => { void runSyncNow() }}
                  aria-label={cp.syncNow} title={cp.syncNow}>
                  {syncPhase === 'idle'
                    ? <Icon id="rotate" />
                    : <SyncGlyph done={syncPhase === 'done'} label={syncPhase === 'done' ? cp.syncDone : cp.syncNow} />}
                </button>
              </div>
              {/* No «Einsatzrapport» row: it is a surface in the rail now, and a second door to
                  it from here made the menu the place you go to find things that are already
                  one tap away. Einsatzdaten editing still lives inside it (the «Bearbeiten»
                  link on its dispatch block) rather than as a menu entry of its own. */}
              {/* No «Objekt» row either: which Einsatzobjekt is loaded decides which PLANS are
                  loaded, so it belongs on the Plan surface above them (Whiteboard · .wb-object),
                  not in a menu that is opened for something else. Here it also had to say the
                  object's name — a menu row is the wrong place for a read-out you want to check
                  while you work on the plans it names. */}
              {onArchive && (
                <>
                  {/* set the terminal «abschliessen» apart from the card above it so it isn't a
                      mis-tap neighbour of the Sync button — it still runs the «wirklich
                      abschliessen?» confirm */}
                  <div className="ip-menu-sep ip-menu-sep-tight" />
                  <button className="ip-menu-act" onClick={() => { setOpen(false); onArchive() }}><Icon id="check" /> {cp.archive}</button>
                </>
              )}
              <div className="ip-menu-sep" />
            </>
          )}
          {/* The Einsätze group is about moving BETWEEN Einsätze. When nothing in it can
              render — no other incident, no «Neuer Einsatz», no «Alle Einsätze» — the label
              would head an empty list, which is what an Einsatz-Link sees: it is bound to
              one Einsatz and switching is neither offered nor permitted. Derived rather
              than passed, so the menu never has to know why the rows are missing. */}
          {showIncidents && (
            <>
              <div className="ip-menu-label">{cp.incidents}</div>
              {incidents.length === 0 && !active && <div className="ip-menu-empty">{cp.noOpenIncidents}</div>}
              {otherIncidents.map((i) => (
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
              {onHistory && <button className="ip-menu-act" onClick={() => openSheet(onHistory)}><Icon id="history" /> {cp.allIncidents}</button>}
              <div className="ip-menu-sep" />
            </>
          )}
          {/* «App»: device + installation, not this Einsatz. It always has rows — Hilfe is
              unconditional — so the label never heads an empty group the way «Einsätze» can. */}
          <div className="ip-menu-label">{cp.app}</div>
          {onSettings && <button className="ip-menu-act" onClick={() => openSheet(onSettings)}><Icon id="gear" /> {appConfig.copy.settings.title}</button>}
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
            {onLogout && <button className="ip-menu-logout" onClick={() => { onLogout(); setOpen(false) }}><Icon id="logout" /> {cp.logout}</button>}
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
