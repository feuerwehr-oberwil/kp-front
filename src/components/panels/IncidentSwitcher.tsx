import { ShellLoader } from '../ShellLoader'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { initials, roleLabel, fillTemplate, fmtSpanShort, streetPart } from '../../lib/format'
import { buildLabel } from '../../lib/buildInfo'
import { applyUpdateNow, onUpdateAvailable } from '../../lib/swUpdate'
import { canApplyInPlace } from '../../lib/updatePolicy'
import { getInstallPlatform } from '../../lib/installPrompt'
import { appConfig } from '../../config/appConfig'
import { toast } from '../../lib/ui'
import { shortAddress } from '../../lib/deploymentConfig'
import { runningOthers } from '../../lib/switcherLists'
import { SyncGlyph } from '../SyncGlyph'
import { useOnline } from '../../lib/useOnline'
import type { IncidentMeta, SyncStatus } from '../../lib/incidents'
import { useIsPhone } from '../../lib/useIsPhone'
import { CLOCK_ICON, useEinsatzuhr } from '../../lib/einsatzuhr'
import { EinsatzuhrChoices } from '../Einsatzuhr'

// HH:MM for the positive "gespeichert" trust signal next to the sync badge.
function fmtClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// (the SyncGlyph — the shared activity and completion vocabulary — now lives
// in ../SyncGlyph, shared with the Offline-Bereitschaft load and the Anwesenheit reload)

// --- TopBar switcher ----------------------------------------------------------------
export function IncidentSwitcher({
  active, incidents, isEditor, syncStatus, lastSyncedAt, user, startedAt, endedAt, onSettings, onSwitch, onHistory, onObjectVisits, onDivera, onEditMeta, onArchive, onShare, archiveOpenCount = 0, onHelp, onInstall, onOfflineReadiness, onSyncNow, onLogout, navKey, sheetOpen = false, syncDetail,
}: {
  active: IncidentMeta | null
  incidents: IncidentMeta[]
  isEditor: boolean
  syncStatus: SyncStatus
  syncDetail?: string
  lastSyncedAt: number | null
  user: { display_name: string; color: string | null; role: string }
  /** the Einsatzuhr's start and (for a closed Einsatz) end — the SAME two the top bar's clock gets.
   *  On a phone the clock is the pill's second line (see `twoLine` below). */
  startedAt?: string | null
  endedAt?: string | null
  /** open the Einstellungen sheet (device prefs + synced incident settings) */
  /** Omitted hides the Einstellungen row — an Einsatz-Link has no device or incident
      settings to change, and every write behind them is refused anyway. */
  onSettings?: () => void
  onSwitch: (i: IncidentMeta) => void
  /** «Alle Einsätze» — absent for an Einsatz-Link session, which may only ever see its own */
  onHistory?: () => void
  /** Objektbesuche — set only where the station switched the module on and this is no link session */
  onObjectVisits?: () => void
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
  /** «Teilen» — opens the share sheet (`ShareIncidentSheet`) for the ACTIVE incident, on the
   *  read-only tab; the sheet's tabs are what picks between the two links (03.09.). Since 06.09.
   *  this row is THE door on every width — the bar's own Teilen button is gone. Omitted for
   *  viewers, read-only views and a link session, which may not mint one. */
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
  /** End the login on this device. ⚠️ Absent for an Einsatz-Link session (02.09.): a link owns
   *  no login here to end — leaving it is closing the page — and the row used to sign the
   *  device's own account out with it. */
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
  const cu = appConfig.copy.update
  // A waiting build, and whether this device may take it in place (iOS wedges — updatePolicy).
  // Subscribed rather than read on open: the menu is mounted the whole time, and the button has
  // to appear the moment a deploy lands, not only on the next open.
  const [updateWaiting, setUpdateWaiting] = useState(false)
  const [applyingUpdate, setApplyingUpdate] = useState(false)
  useEffect(() => onUpdateAvailable(setUpdateWaiting), [])
  const updateReady = updateWaiting && canApplyInPlace(getInstallPlatform())
  // «Jetzt synchronisieren» reports what it did on the button itself: Shell trail runs for the
  // round trip, then gives way to a tick. Success needs no words — a toast for «alles
  // synchronisiert» was a sentence to read for the most boring outcome there is. Offline and
  // failure still get one, because those change what the operator should do next.
  const [syncPhase, setSyncPhase] = useState<'idle' | 'busy' | 'done'>('idle')
  // offline the button is not drawn at all (see `syncButton`)
  const online = useOnline()
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
  // ⚠️ PHONE: «where over the clock» (07.10.2026, UI sweep · owner pick B3 D). The pill carried a
  // doc glyph and nothing else — the Stichwort was hidden as a useless «C…» — while the bar spent
  // a second control on the Einsatzuhr beside it. Now the pill IS both: the ADDRESS's street part
  // (owner: «the address is more important than the type»; the Stichwort where there is none),
  // 13.5/700 with an ellipsis, over the Einsatzuhr (mono 12.5, its mode's glyph); the bar's own
  // clock button goes (TopBar). The clock's modes are an INLINE choice under the Einsatz card's
  // Beginn pill below (never a popover over this menu) — the same per-device choice as the
  // tablet's bar menu (lib/einsatzuhr). Tablet unchanged.
  const isPhone = useIsPhone()
  const uhr = useEinsatzuhr(startedAt, endedAt, undefined, !isPhone)
  const twoLine = isPhone && !!active
  const street = streetPart(active?.address)
  const pillName = street || active?.title || ''
  // the inline clock choice starts folded every time the menu is opened (the switch button below)
  const [clockOpen, setClockOpen] = useState(false)
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
    : syncDetail ?? badgeTitle[syncStatus]
  // The CARD's pill says «Gespeichert» without the time (27.09.2026, slim sweep · decision D1):
  // one wording for one fact, the same the Trupps head shows; the time stays in the title (it
  // was «Gespeichert um 23:16»). The other states keep their words — they are warnings.
  const savedPill = syncStatus === 'synced' ? cp.saved : savedText
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
   * «Jetzt synchronisieren» — offered whenever the device has a link, not only on error: it forces a push AND an
   * immediate pull, the "make everything fresh right now" action when things feel stale. It has
   * to LOOK like it ran, because on an already-synced Einsatz — the normal case — the status
   * says the same thing before and after the tap; so Shell trail runs for the round trip and then
   * gives way to a tick on the button itself.
   *
   * It sits in the CARD's title row, at the Einsatzname's right edge: the action belongs to that
   * one Einsatz, so it belongs to the line that names it — not to the app's own header bar
   * (which on a phone has no room to spare anyway, see 15-mobile.css), and not down among
   * «Bearbeiten»/«Abschliessen», which are things you do to the Einsatz rather than to the
   * connection. Same place on every screen width.
   * ⚠️ NOT while offline (owner, 05.10.2026: «pointless when offline»): the tap could only end in
   * «Immer noch offline», and the queue pushes by itself the moment the link is back. The
   * «● Offline» chip says why it is gone.
   */
  const syncButton = online && (
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
      <button className={`ip-switch-btn${twoLine ? ' ip-switch-two' : ''}`} onClick={() => { setClockOpen(false); setOpen((v) => !v) }}
        aria-label={twoLine
          ? [street, active.title, uhr.text ? `${uhr.label[uhr.mode]} ${uhr.text}` : ''].filter(Boolean).join(', ')
          : active ? active.title : cp.noIncident}
        aria-expanded={open && !sheetOpen}>
        {twoLine ? (
          <span className="ip-switch-lines">
            <span className="ip-switch-title">{pillName}</span>
            {uhr.text && (
              <span className="ip-switch-clock"><Icon id={CLOCK_ICON[uhr.mode]} /><b>{uhr.text}</b></span>
            )}
          </span>
        ) : (
          <>
            {/* a narrow TABLET bar's last step (fit-9): the title gives way to a doc glyph; the full
                title heads the dropdown instead */}
            <span className="ip-switch-glyph" aria-hidden><Icon id="doc" /></span>
            <span className="ip-switch-title">{active ? active.title : cp.noIncident}</span>
          </>
        )}
        {/* persistent ÜBUNG marker in the chrome — a training must never read as a real
            Einsatz mid-use (it also survives the phone's CSS-hidden title) */}
        {active?.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
        {/* Offline and sync-error get a LOUD text chip (not just the tiny mark) — offline
            blocks switching incidents to the server, and a failing sync means edits are
            stranded on this device; the operator needs to recognise both at a glance
            WITHOUT opening the dropdown. (Since 07.09. an offline spell past 60 s also
            raises a standing Meldung — components/OfflineMeldung; this chip stays the
            immediate, always-on indicator.) */}
        {/* Storage-full is the loudest of the three: offline and sync-error both still mean the
            work is safely cached on this device, this one means it is not saved ANYWHERE. */}
        {active && syncStatus === 'storage' ? (
          <span className="ip-offline-chip ip-error-chip" title={savedText} aria-label={savedText}>
            <Icon id="warn" /><span className="ip-chip-word">{cp.storageShort}</span>
          </span>
        ) : active && syncStatus === 'offline' ? (
          <span className="ip-offline-chip" title={savedText} aria-label={savedText}>
            <span className="ip-status-dot" />{cp.offlineShort}
          </span>
        ) : active && syncStatus === 'error' ? (
          <span className="ip-offline-chip ip-error-chip" title={savedText} aria-label={savedText}>
            <Icon id="warn" /><span className="ip-chip-word">{cp.errorShort}</span>
          </span>
        ) : active && (
          <span className={`ip-status ip-status-${syncStatus}`} title={savedText} aria-label={savedText}>
            {statusMark}
          </span>
        )}
        {/* ▾ while the dropdown is shut, ▴ while it stands open (02-base.css · .chev) */}
        <Icon id="chevron-down" className="chev" />
      </button>
      {open && !sheetOpen && (
        <div className="ip-menu">
          {/* The menu is about what is RUNNING, in two weights (field feedback: every row carried
              the same one): ① THIS Einsatz as a CARD — Titel, Adresse, zwei
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
                <span className={`ip-card-pill ip-status-${syncStatus}`} title={savedText}>{statusMark}<span>{savedPill}</span></span>
                {/* «🕓 21:22 · 1 h 54» — the clock glyph is the label; «Einsatzbeginn» is the title */}
                {active.started_at && (() => {
                  // a closed Einsatz stops its clock at the end, as the bar's Einsatzuhr does
                  const until = endedAt ? Date.parse(endedAt) : now
                  const title = fillTemplate(cp.startedFull, { t: fmtClock(Date.parse(active.started_at)), d: fmtSpanShort(until - Date.parse(active.started_at)) })
                  const body = <><Icon id="clock" /><span>{fillTemplate(cp.startedRow, { t: fmtClock(Date.parse(active.started_at)), d: fmtSpanShort(until - Date.parse(active.started_at)) })}</span></>
                  // PHONE: the pill is the door to the Einsatzuhr's modes, which have no button of
                  // their own in the phone bar any more (see `twoLine`): it folds the inline choice
                  // out under the pills (below), ▾/▴ like every other fold
                  return twoLine && startedAt ? (
                    <button type="button" className="ip-card-pill ip-card-pill-btn" title={title} aria-label={title}
                      aria-expanded={clockOpen} onClick={() => setClockOpen((v) => !v)}>
                      {body}<Icon id="chevron-down" className="chev" />
                    </button>
                  ) : (
                    <span className="ip-card-pill" title={title}>{body}</span>
                  )
                })()}
              </div>
              {twoLine && clockOpen && (
                <EinsatzuhrChoices uhr={uhr} ariaLabel={appConfig.copy.einsatzuhr.modeElapsed} onPicked={() => setClockOpen(false)} />
              )}
              {/* The Einsatz's own actions, inside its own card. Short labels: the card names the
                  Einsatz one line above, so «Einsatz abschliessen» would say it twice — the full
                  wording rides along as the button's title/aria-label.
                  ⚠️ ONE LINE, always (decision 01.09.): three verbs that wrap to a second row
                  stop reading as one set of choices. The label is its own <span> (the badge is
                  the tile's other child) — see .ip-card-acts, which carries the measured widths.
                  Order is Bearbeiten · Teilen · Abschliessen. Abschliessen goes LAST because it
                  is the one that ends the Einsatz; a terminal action sitting between two
                  everyday ones is a mis-tap waiting for a gloved thumb.
                  Three tiles of the head's family since 27.09.2026 (slim sweep · mockup 10) —
                  Abschliessen amber, its count on the tile's corner. Content-sized and NEVER
                  truncated since the same evening (owner screenshot r2-6: «Abschliess…» — the
                  equal thirds ellipsised the verb on a 390px phone; .ip-card-acts).
                  A wrong ADDRESS is noticed while looking at the map, long before anybody opens
                  the Rapport — whose «Bearbeiten» link was once the only way into the mask. */}
              {(onEditMeta || onArchive || onShare) && (
                <div className="ip-card-acts">
                  {onEditMeta && (
                    <button className="ip-card-act head-tile sm" title={cp.editMeta} aria-label={cp.editMeta}
                      onClick={onEditMeta}>
                      <Icon id="pen" /><span>{cp.editMetaShort}</span>
                    </button>
                  )}
                  {onShare && (
                    <button className="ip-card-act head-tile sm" title={cp.share} aria-label={cp.share}
                      onClick={onShare}>
                      <Icon id="external" /><span>{cp.shareShort}</span>
                    </button>
                  )}
                  {onArchive && (
                    <button className="ip-card-act head-tile sm amber" title={cp.archive} aria-label={cp.archive}
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
              {onHistory && (
                <button className="ip-menu-act" onClick={onHistory}>
                  <Icon id="history" /> {cp.allIncidents}
                </button>
              )}
              {isEditor && <button className="ip-menu-act" onClick={onDivera}><Icon id="plus" /> {appConfig.copy.intake.titleNew}</button>}
            </div>
          )}
          {/* «App»: device + installation, not this Einsatz. It always has rows — Hilfe is
              unconditional — so the label never heads an empty group the way «Einsätze» can. */}
          <div className="ip-menu-label">{cp.app}</div>
          {/* Objektbesuche is no Einsatz, so it is not under «Einsätze»: it is the app's other job.
              Here because a device that always opens its running Einsatz never sees the launcher
              (staging 03.10.2026). */}
          {onObjectVisits && (
            <button className="ip-menu-act" onClick={() => { setOpen(false); onObjectVisits() }}>
              <Icon id="clipboard" /> {appConfig.copy.objectVisits.launcher}
            </button>
          )}
          {onSettings && <button className="ip-menu-act" onClick={onSettings}><Icon id="gear" /> {appConfig.copy.settings.title}</button>}
          {active && <button className="ip-menu-act" onClick={onOfflineReadiness}><Icon id="snapshot" /> {appConfig.copy.offline.title}</button>}
          <button className="ip-menu-act" onClick={onHelp}><Icon id="info" /> {appConfig.copy.help.menu}</button>
          {onInstall && <button className="ip-menu-act" onClick={onInstall}><Icon id="share-ios" /> {appConfig.copy.install.menu}</button>}
          {/* ONE hairline in this menu, above the identity row (22.09.2026): the small-caps label
              heads «App» on its own, but the row under the actions is not an action — it is who
              is signed in, and the rule is what says «the list ends here». */}
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
            {/* No manual "check for updates" — a fresh deploy surfaces itself (the 5-min poll and
                the visibility-resume check). What IS here is the apply, and only while a build is
                actually waiting: the menu is where somebody looks when an app feels stale, which
                is exactly the state a dismissed banner leaves behind (16.09.2026). */}
            <span className="ip-menu-ver" title={cp.appVersion}>{buildLabel()}</span>
            {updateReady && (
              <button className="ip-menu-update" disabled={applyingUpdate}
                onClick={() => { setApplyingUpdate(true); void applyUpdateNow() }}>
                {applyingUpdate ? <ShellLoader /> : <Icon id="rotate" />}
                {applyingUpdate ? cu.applying : cu.apply}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
