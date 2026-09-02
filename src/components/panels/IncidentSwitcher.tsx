import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { initials, roleLabel, fillTemplate, fmtSpanShort } from '../../lib/format'
import { buildLabel } from '../../lib/buildInfo'
import { appConfig } from '../../config/appConfig'
import { toast } from '../../lib/ui'
import { shortAddress } from '../../lib/deploymentConfig'
import { runningOthers } from '../../lib/switcherLists'
import { SyncGlyph } from '../SyncGlyph'
import type { IncidentMeta, SyncStatus } from '../../lib/incidents'

// HH:MM for the positive "gespeichert" trust signal next to the sync badge.
function fmtClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// (the SyncGlyph — the spinning-arc-closes-into-tick vocabulary this button speaks — now lives
// in ../SyncGlyph, shared with the Offline-Bereitschaft load and the Anwesenheit reload)

// --- TopBar switcher ----------------------------------------------------------------
export function IncidentSwitcher({
  active, incidents, isEditor, syncStatus, lastSyncedAt, user, onSettings, onSwitch, onHistory, onDivera, onEditMeta, onArchive, onShare, archiveOpenCount = 0, onHelp, onInstall, onOfflineReadiness, onSyncNow, onLogout, navKey, sheetOpen = false,
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
  /** correct the dispatch facts (address, category, Stichwort) — omitted for a viewer */
  onEditMeta?: () => void
  /** «Einsatz abschliessen» for the ACTIVE incident — the SAME confirm the Rapport runs
   *  (IncidentWorkspace · confirmAndComplete); absent for viewers / read-only views / an
   *  already-closed incident */
  onArchive?: () => void
  /** «Teilen» — open the Weitergeben sheet (the read-only Einsatz-Link + its QR) for the
   *  ACTIVE incident. In the card because the link belongs to this Einsatz, not to the app;
   *  omitted for viewers and for an Einsatz-Link session, which may not mint one. */
  onShare?: () => void
  /** how many Mindestangaben are still open, shown as a badge on that row. The check used to
   *  happen only after the press, and only on the other door — see confirmAndComplete. */
  archiveOpenCount?: number
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
  /** A child sheet launched from this menu is visible. The menu stays logically open but is
   *  suspended — unrendered, so its higher z-index cannot overlap the child — on every form
   *  factor. Cancelling the sheet therefore reveals the exact parent state; the rows that
   *  NAVIGATE close the menu deliberately instead (see `navKey`). */
  sheetOpen?: boolean
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
    // clicks inside an overlay sheet/dialog don't count as "outside": a sheet opened FROM this
    // menu suspends it via `sheetOpen` rather than closing it, so cancelling that sheet has to
    // reveal the menu exactly as it was — a press inside it must not have closed it meanwhile.
    // 'pointerdown', not 'mousedown': on touch the compat mousedown fires late or not at all,
    // so tapping outside would not reliably dismiss (same pattern as Combo/PersonField).
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Element
      if (ref.current && !ref.current.contains(t) && !t.closest?.('.ip-sheet, .ui-backdrop, .help-scrim, .confirm-backdrop, .toaster')) setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [])
  // A sheet action that NAVIGATES (Rapport → Anwesenheit/Mittel/Verlauf) must not
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
  // Only the RUNNING Einsätze are listed. Everything that is over lives behind «Alle Einsätze»,
  // where it can be searched and grouped — a handful of recent ones in the menu turned out to be
  // neither (feedback 2026-08-26): you either switch to something that is running, or you go
  // looking for a specific old Einsatz, and the second one is not a four-row list.
  const running = runningOthers(incidents, active?.id ?? null)
  const showIncidents = running.length > 0 || isEditor || !!onHistory || (incidents.length === 0 && !active)
  const exerciseBadge = <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>
  /**
   * «Jetzt synchronisieren» — always offered, not only on offline/error: it forces a push AND an
   * immediate pull, the "make everything fresh right now" action when things feel stale. It has
   * to LOOK like it ran, because on an already-synced Einsatz — the normal case — the status
   * says the same thing before and after the tap; so the ring spins for the round trip and then
   * closes into a tick on the button itself.
   *
   * It sits in the CARD's title row, at the Einsatzname's right edge: the action belongs to that
   * one Einsatz, so it belongs to the line that names it — not to the app's own header bar
   * (which on a phone has no room to spare anyway, see 15-mobile.css), and not down among
   * «Bearbeiten»/«Abschliessen», which are things you do to the Einsatz rather than to the
   * connection. Same place on every screen width.
   */
  const syncButton = (
    <button className={`ip-card-sync sync-${syncPhase}`} disabled={syncPhase === 'busy'}
      aria-busy={syncPhase === 'busy'} onClick={() => { void runSyncNow() }}
      aria-label={cp.syncNow} title={cp.syncNow}>
      {syncPhase === 'idle'
        ? <Icon id="rotate" />
        : <SyncGlyph done={syncPhase === 'done'} label={syncPhase === 'done' ? cp.syncDone : cp.syncNow} />}
    </button>
  )
  return (
    <div className="ip-switch" ref={ref}>
      <button className="ip-switch-btn" onClick={() => setOpen((v) => !v)}
        aria-label={active ? active.title : cp.noIncident} aria-expanded={open && !sheetOpen}>
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
      {open && !sheetOpen && (
        <div className="ip-menu">
          {/* The menu is about what is RUNNING, in two weights (field feedback: every row carried
              the same one): ① THIS Einsatz as a CARD — green status edge, Titel, Adresse, zwei
              Status-Pills — carrying its OWN actions inside it; ② the other running Einsätze as
              rows led by their laufende Zeit. The card needs no label — it names itself.
              Nothing that is OVER is listed here (a «Frühere» section was tried and dropped on
              2026-08-26): you either switch to something that is still running, or you go looking
              for one particular old Einsatz — and that is a search, which «Alle Einsätze» is.
              The round-4 rule was "no destructive actions in this menu" (a stray per-row ✕ closed
              old incidents in one tap); «abschliessen» is the sanctioned exception (field request
              2026-07-12), and only ever for the Einsatz whose card it sits in: it runs the SAME
              confirm as the Rapport — open points named, `report_done_at` stamped — and closing
              stays reversible via «Wieder öffnen». Closing OTHER incidents lives only in «Alle
              Einsätze».
              No «Einsatzrapport» action either: it is a surface in the rail now, and a second
              door to it from here made the menu the place you go to find things that are already
              one tap away. And no «Objekt» row — which Einsatzobjekt is loaded decides which
              PLANS are loaded, so it belongs on the Plan surface above them (Whiteboard). */}
          {active && (
            <div className="ip-card">
              <div className="ip-card-title">
                {/* the name gives way first — it clamps to two lines and then ellipsises, so
                    neither the ÜBUNG marker nor the Sync button is ever what gets cut off */}
                <span className="ip-card-name" title={active.title}>{active.title}</span>
                {active.is_exercise && exerciseBadge}
                {syncButton}
              </div>
              {active.address && <span className="ip-card-sub">{active.address}</span>}
              <div className="ip-card-pills">
                <span className={`ip-card-pill ip-status-${syncStatus}`} title={savedText}>{statusMark}<span>{savedText}</span></span>
                {active.started_at && (
                  <span className="ip-card-pill">
                    <Icon id="clock" />
                    <span>{fillTemplate(cp.startedRow, { t: fmtClock(Date.parse(active.started_at)), d: fmtSpanShort(now - Date.parse(active.started_at)) })}</span>
                  </span>
                )}
              </div>
              {/* The Einsatz's own actions, inside its own card. Short labels: the card names the
                  Einsatz one line above, so «Einsatz abschliessen» would say it twice — the full
                  wording rides along as the button's title/aria-label.
                  ⚠️ ONE LINE, always (decision 01.09.): three verbs that wrap to a second row
                  stop reading as one set of choices. The label is its own <span> so the row can
                  ellipsise instead of wrap when it truly cannot fit — see .ip-card-acts, which
                  carries the measured widths.
                  Order is Bearbeiten · Teilen · Abschliessen. Abschliessen goes LAST because it
                  is the one that ends the Einsatz; a terminal action sitting between two
                  everyday ones is a mis-tap waiting for a gloved thumb.
                  A wrong ADDRESS is noticed while looking at the map, long before anybody opens
                  the Rapport — whose «Bearbeiten» link was once the only way into the mask. */}
              {(onEditMeta || onArchive || onShare) && (
                <div className="ip-card-acts">
                  {onEditMeta && (
                    <button className="ip-card-act" title={cp.editMeta} aria-label={cp.editMeta}
                      onClick={onEditMeta}>
                      <Icon id="pen" /><span>{cp.editMetaShort}</span>
                    </button>
                  )}
                  {onShare && (
                    <button className="ip-card-act" title={cp.share} aria-label={cp.share}
                      onClick={onShare}>
                      <Icon id="external" /><span>{cp.shareShort}</span>
                    </button>
                  )}
                  {onArchive && (
                    <button className="ip-card-act" title={cp.archive} aria-label={cp.archive}
                      onClick={onArchive}>
                      <Icon id="archive" /><span>{cp.archiveShort}</span>
                      {/* The counter BEFORE the press, not only in the dialog after it. Bare
                          number: «3 offen» cost 50px of a row that has to stay on one line, and
                          the word is the half a glance does not need — the full «{n} offen»
                          rides along as the badge's own title/aria-label. */}
                      {archiveOpenCount > 0 && (
                        <span className="ip-badge ip-badge-todo"
                          title={fillTemplate(cp.archiveOpen, { n: archiveOpenCount })}
                          aria-label={fillTemplate(cp.archiveOpen, { n: archiveOpenCount })}>
                          {archiveOpenCount}
                        </span>
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {/* The Einsätze group is about moving BETWEEN Einsätze. When nothing in it can
              render — no other incident, no «Neuer Einsatz», no «Alle Einsätze» — none of it
              shows, which is what an Einsatz-Link sees: it is bound to one Einsatz and switching
              is neither offered nor permitted. Derived rather than passed, so the menu never has
              to know why the rows are missing. */}
          {showIncidents && (
            <div className="ip-rows">
              {/* No label over the laufende rows: they sit directly under the card they are the
                  alternatives to. Without a card there is no such context, so the group says
                  what it is. */}
              {!active && <div className="ip-menu-label">{cp.incidents}</div>}
              {incidents.length === 0 && !active && <div className="ip-menu-empty">{cp.noOpenIncidents}</div>}
              {running.map((i) => (
                <button key={i.id} className="ip-menu-row" onClick={() => { onSwitch(i); setOpen(false) }}>
                  <span className="ip-menu-when">{fmtSpanShort(now - Date.parse(i.started_at))}</span>
                  <span className="ip-menu-rowmain">
                    <span className="ip-menu-titleline">
                      <span className="ip-menu-title">{i.title}</span>
                      {/* beside the title, not inside it: a long Einsatzname ellipsises, and the
                          marker that says «Übung» must not be the part that gets cut off */}
                      {i.is_exercise && exerciseBadge}
                    </span>
                    {/* WHERE it is, the way the card says it for the active Einsatz — «Ölspur» is
                        not an Einsatz you can tell apart from another «Ölspur» without it. Same
                        shortened form as everywhere else: the own Gemeinde is left off. */}
                    {shortAddress(i.address) && <span className="ip-menu-rowsub">{shortAddress(i.address)}</span>}
                  </span>
                </button>
              ))}
              {/* History and creation are the two doors OUT of the running list. They are peers:
                  one opens an earlier Einsatz, one opens a new one. The old blue text link looked
                  detached from the full-size creation row directly below it, especially on a
                  phone, so both now use the same recognised icon+label action recipe. */}
              {/* ⚠️ Only when something stands ABOVE it inside this group. With one Einsatz running
                  and no others, the rows above are empty and the rule landed directly under the
                  active Einsatz's card — a divider between a card and the two doors out of a list
                  that isn't there, which reads as «there is more, and it is hidden». */}
              {(running.length > 0 || !active) && (onHistory || isEditor) && <div className="ip-menu-sep" />}
              {onHistory && (
                <button className="ip-menu-act" onClick={onHistory}>
                  <Icon id="history" /> {cp.allIncidents}
                </button>
              )}
              {isEditor && <button className="ip-menu-act" onClick={onDivera}><Icon id="plus" /> {appConfig.copy.intake.titleNew}</button>}
            </div>
          )}
          <div className="ip-menu-sep" />
          {/* «App»: device + installation, not this Einsatz. It always has rows — Hilfe is
              unconditional — so the label never heads an empty group the way «Einsätze» can. */}
          <div className="ip-menu-label">{cp.app}</div>
          {onSettings && <button className="ip-menu-act" onClick={onSettings}><Icon id="gear" /> {appConfig.copy.settings.title}</button>}
          {active && <button className="ip-menu-act" onClick={onOfflineReadiness}><Icon id="snapshot" /> {appConfig.copy.offline.title}</button>}
          <button className="ip-menu-act" onClick={onHelp}><Icon id="info" /> {appConfig.copy.help.menu}</button>
          {onInstall && <button className="ip-menu-act" onClick={onInstall}><Icon id="share-ios" /> {appConfig.copy.install.menu}</button>}
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
