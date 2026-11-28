// The workspace's TopBar: Einsatz title and mode chip, sync/clock state, ↶ ↷, the Einsatz-Menü
// and the per-surface actions. Split out of IncidentWorkspace (E1, 09.10.2026) verbatim; the
// menu's doors (switch, archive, share, settings, …) stay the workspace's and come in as props.
// The menu's «Präsentieren» (F15, 17.11.2026) starts the Präsentationsmodus itself – the one
// door to it since «Einsatz teilen» lost its card (owner, 18.11.2026).
//
// ⚠️ Steady props (perf sweep 26.11.2026): the bar, TopBar, the switcher and the pill are `memo`,
// so a workspace render that changes nothing they show renders none of them. The workspace hands
// it plain values (a count, a flag) rather than whole hook results, and functions that keep one
// identity (lib/useSteadyFns). A new prop must be one of the two, or it renders the bar on every
// workspace commit. A late language or station config reaches the parts through lib/useLateText.

import { memo, useMemo, type Dispatch, type SetStateAction, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { IncidentSwitcher, type AppMenuAlarms, type FoldedMenuRow } from '../components/panels'
import { linkPageOwnsSession } from '../lib/linkMode'
import type { Presentation } from './usePresentation'
import { SharePositionPill, type SharePillApi } from '../components/SharePosition'
import { TopBar } from '../components/TopBar'
import { appConfig } from '../config/appConfig'
import { type AtemschutzAlarmState, azChipRedundant } from '../lib/atemschutz'
import type { AuthUser } from '../lib/auth'
import { closeTimeOf, type IncidentMeta, type SyncStatus } from '../lib/incidents'
import { installOffered } from '../lib/installPolicy'
import { isStandalone, getInstallPlatform } from '../lib/installPrompt'
import { confirmLogout } from '../lib/logoutConfirm'
import { toast } from '../lib/ui'
import type { useIsPhone } from '../lib/useIsPhone'
import { useLateText } from '../lib/useLateText'
import { useSteadyFns } from '../lib/useSteadyFns'
import type { ShareLinkKind } from '../lib/viewLink'
import type { ReportMeta } from '../lib/workspace'
import type { Incident, WeatherData, ReactivateResult } from '../types'
import type { WorkspaceMode } from './types'
import type { ViewOnlyReason } from './access'

export interface WorkspaceTopBarProps {
  incidentView: Incident
  incidentMeta: IncidentMeta
  reportMeta: ReportMeta
  running: boolean
  /** the voice memo (lib/useVoiceMemo): recording now, since when, and its stop */
  recording: boolean
  recStartedAt: number | null
  stopVoice: () => void
  journalOpen: boolean
  setJournalOpen: Dispatch<SetStateAction<boolean>>
  /** open Wiedervorlagen (lib/useReminders · openCount) */
  reminderCount: number
  linkScoped: boolean
  readOnly: boolean
  setComposerOpen: Dispatch<SetStateAction<boolean>>
  tabLockLost: boolean
  isEditor: boolean
  onTakeOverTab: () => void
  startVoiceMemo: () => void
  startQuickPhoto: () => void
  onHistoryPress: (dir: 'undo' | 'redo') => (e: ReactMouseEvent<HTMLButtonElement>) => void
  histCanUndo: boolean
  histCanRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  canEditIncident: boolean
  canCloseIncident: boolean
  canEditRecord: boolean
  displayWeather: WeatherData | null
  openWeatherDetails: () => void
  /** the Karte's bearing – the wind arrow turns with it */
  bearing: number
  azAlarm: AtemschutzAlarmState
  mode: WorkspaceMode
  azRowsShown: string[]
  setMode: Dispatch<SetStateAction<WorkspaceMode>>
  setPanel: Dispatch<SetStateAction<'layers' | null>>
  setTruppFocus: Dispatch<SetStateAction<{ id: string; nonce: number } | null>>
  mapUI: boolean
  replayActive: boolean
  gpsStale: boolean
  gpsAgeMs: number | null
  share: SharePillApi
  onShareChangeName: (restore: () => void) => void
  onBackFromArchive: (() => void) | undefined
  onReactivateActive: (() => Promise<ReactivateResult>) | undefined
  isPhone: ReturnType<typeof useIsPhone>
  phoneTools: boolean
  planFit: RefObject<(() => void) | null>
  incidents: IncidentMeta[]
  syncStatus: SyncStatus
  /** the Verlauf's or the audit events' delivery failed (useJournal / useAuditEvents · status) */
  deliveryFailed: boolean
  /** Verlauf rows and media not yet delivered – read when «Abmelden» asks, not in render */
  unsentEntries: () => number
  closedRefusedUnexported: boolean
  baseSyncStatus: SyncStatus
  lastSyncedAt: number | null
  user: AuthUser | null
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  onSwitchIncident: (i: IncidentMeta) => void
  onOpenHistory: () => void
  onOpenObjectVisits: ((objectId?: string | null) => void) | undefined
  onOpenKarte: (() => void) | undefined
  activeObjectId: string | undefined
  canEditMeta: boolean
  onEditMeta: () => void
  onOpenDivera: () => void
  /** the alarms waiting to be opened, listed in the menu (App builds them) */
  menuAlarms?: AppMenuAlarms
  /** a hidden «Alarm aktualisiert», as the menu's quiet row (App builds it) */
  menuFolded?: FoldedMenuRow[]
  confirmAndComplete: () => Promise<boolean>
  /** the open Mindestangaben (useAbschluss · abschlussMissing.length) */
  archiveOpenCount: number
  canShareLink: boolean
  setShareLink: Dispatch<SetStateAction<ShareLinkKind | null>>
  setHelpOpen: Dispatch<SetStateAction<boolean>>
  setInstallGuideOpen: Dispatch<SetStateAction<boolean>>
  syncNow: () => Promise<void>
  logout: () => Promise<void>
  settingsOpen: boolean
  helpOpen: boolean
  installGuideOpen: boolean
  offlineReadyOpen: boolean
  shareLink: ShareLinkKind | null
  /** bumped when the Einsatz-Menü has to go although no surface changed — «Abschliessen» asked
   *  from «Alle Einsätze» (IncidentWorkspace · abschlussRef) */
  menuCloseKey: number
  /** «Nur ansehen» in the pill's status slot, and why (workspace/access · viewOnlyReason) */
  viewOnly: ViewOnlyReason | null
  /** the Präsentationsmodus may start here and is not running yet (usePresentation · canStart,
   *  follow), for the menu's own «Präsentieren», which starts it (F15, pick 29) */
  canStartPresentation: boolean
  startPresentation: Presentation['start']
}

/** The workspace's top bar. `memo`: it renders when one of its props changes, so every prop is a
 *  plain value or a steady function (see the head of this file). */
export const WorkspaceTopBar = memo(function WorkspaceTopBar({
  incidentView, incidentMeta, reportMeta, running, recording, recStartedAt, stopVoice, journalOpen, setJournalOpen, reminderCount,
  linkScoped, readOnly, setComposerOpen, tabLockLost, isEditor, onTakeOverTab, startVoiceMemo,
  startQuickPhoto, onHistoryPress, histCanUndo, histCanRedo, undoLabel, redoLabel, canEditIncident, canCloseIncident,
  canEditRecord, displayWeather, openWeatherDetails, bearing, azAlarm, mode, azRowsShown, setMode,
  setPanel, setTruppFocus, mapUI, replayActive, gpsStale, gpsAgeMs, share, onShareChangeName,
  onBackFromArchive, onReactivateActive, isPhone, phoneTools, planFit, incidents, syncStatus, deliveryFailed,
  unsentEntries, closedRefusedUnexported, baseSyncStatus, lastSyncedAt, user, setSettingsOpen,
  onSwitchIncident, onOpenHistory, onOpenObjectVisits, onOpenKarte, activeObjectId, canEditMeta, onEditMeta,
  onOpenDivera, menuAlarms, menuFolded, confirmAndComplete, archiveOpenCount, canShareLink, setShareLink,
  setHelpOpen, setInstallGuideOpen, syncNow, logout, settingsOpen,
  helpOpen, installGuideOpen, offlineReadyOpen, shareLink,
  menuCloseKey, viewOnly, canStartPresentation, startPresentation,
}: WorkspaceTopBarProps) {
  // the bar's own words below (syncDetail, the phone's «Einpassen») follow a late catalogue
  useLateText()
  const endedAt = reportMeta.endedAt ?? (running ? undefined : closeTimeOf(incidentMeta))
  // The bar's handlers, steady (lib/useSteadyFns): each reads this render's values when it runs,
  // so TopBar and the switcher are not rendered for a fresh closure. Whether a handler EXISTS
  // still decides what they offer – an absent one stays absent.
  const bar = useSteadyFns({
    onToggleJournal: () => setJournalOpen((v) => !v),
    // NOT a composer on a read-only surface: it used to open, take the text, and have the
    // journal store drop the row — «ich kann keine Einträge erfassen», with no reason given.
    // A tab that merely LOST THE LOCK keeps the button though: making it vanish answers the
    // question just as badly, so it says what is in the way and offers the one tap out of it
    // (the same «Hier bearbeiten» the banner carries, for when the banner is scrolled away).
    // Editor AND el: both write the Verlauf, so both get the banner (WorkspaceMeldungen).
    onAddEntry: linkScoped ? undefined
      : !readOnly ? () => setComposerOpen(true)
      : tabLockLost && (isEditor || user?.role === 'el') ? () => toast(appConfig.copy.tabLock.hint, {
          icon: 'info', kind: 'tab-lock', // each «Eintrag» tap used to add one
          action: { label: appConfig.copy.tabLock.takeOver, onClick: onTakeOverTab },
        })
      : undefined,
    onHoldStart: linkScoped ? undefined : startVoiceMemo,
    onHoldEnd: linkScoped ? undefined : stopVoice,
    onHoldPhoto: linkScoped ? undefined : startQuickPhoto,
    onUndo: (e: ReactMouseEvent<HTMLButtonElement>) => onHistoryPress('undo')(e),
    onRedo: (e: ReactMouseEvent<HTMLButtonElement>) => onHistoryPress('redo')(e),
    // …and the chip lands ON the urgent Trupp's card, like every other way in (Meldeleiste,
    // Anwesenheit, the notification tap) — the chip names a Trupp, so the tap must find it.
    onOpenAtemschutz: (truppId?: string) => {
      setMode('atemschutz'); setPanel(null)
      if (truppId) setTruppFocus({ id: truppId, nonce: Date.now() })
    },
    // «Dieses Gerät» for a link session too (M9, 13.11.2026): it holds the Offline part the
    // link always had, and every write in it is gated on its own (Rückmeldung, Standort)
    onSettings: () => setSettingsOpen(true),
    onObjectVisits: linkScoped || !onOpenObjectVisits ? undefined : () => onOpenObjectVisits(activeObjectId ?? null),
    // Einsatzrapport (PDF + Drucken) and «Alle Einsätze» are both refused for a link
    // session — one generates a document with everyone's names, the other lists the
    // Einsätze this link has nothing to do with.
    // ⚠️ The SAME confirm the Rapport runs, with the same count in front of it — this row
    // used to archive plainly (see confirmAndComplete). The badge puts the check where it
    // can be read before the row is pressed, not only after.
    onArchive: canCloseIncident && !readOnly && !incidentMeta.is_archived ? () => { void confirmAndComplete() } : undefined,
    // «Teilen» — THE door to the share sheet (06.09.): the bar's own Teilen button is
    // gone on every width, so this Einsatz-Karte row is the one place an Einsatz is
    // handed to somebody. Same gate as every minting door (`canShareLink`): editors,
    // never a viewer, a read-only surface or a link session.
    onShare: canShareLink ? () => setShareLink('view') : undefined,
    // «Präsentieren» (F15) STARTS the presentation at once (owner pick 29, 17.11.2026); the
    // presentation's own stop is the way out. Editors only (`canShareLink`), and only while
    // this device can start one and is not already presenting.
    onPresent: canShareLink && canStartPresentation ? () => void startPresentation() : undefined,
    onHelp: () => setHelpOpen(true),
    onInstall: isStandalone() || !installOffered(getInstallPlatform()) ? undefined : () => setInstallGuideOpen(true),
    // ⚠️ No «Abmelden» for a link session (02.09.): a link is the literal page and owns
    // no login on this device, so there is none to end here — and the row used to end
    // the DEVICE's own one. Leaving the link means leaving the page.
    // …and it always asks first (lib/logoutConfirm), saying what is still unsent here
    onLogout: linkScoped ? undefined : () => {
      void confirmLogout({
        online: navigator.onLine,
        unsyncedEntries: unsentEntries(),
        unsyncedOther: syncStatus !== 'synced',
      }).then((ok) => { if (ok) void logout() })
    },
    // …and «Anmelden» in its place for a guest on a VIEW or ALARM link (C8, 17.11.2026).
    // Those links never outrank a login (lib/linkMode · linkPageOwnsSession), so a
    // link-scoped session there means this browser holds none: the bare site is its
    // sign-in. An Atemschutz link may sit on top of a login – it gets no row.
    onLogin: linkScoped && !linkPageOwnsSession() ? () => location.assign('/') : undefined,
  })
  const syncDetail = deliveryFailed && syncStatus !== 'storage' ? appConfig.copy.journal.delivery.short
    : closedRefusedUnexported && baseSyncStatus === 'synced' ? appConfig.copy.journal.delivery.closedShort : undefined
  const displayName = user?.display_name ?? '', color = user?.color ?? null, role = user?.role ?? 'viewer'
  const switcherUser = useMemo(() => ({ display_name: displayName, color, role }), [displayName, color, role])
  const navKey = `${mode}|${journalOpen ? 'journal' : ''}|${menuCloseKey}`
  const sheetOpen = settingsOpen || helpOpen || installGuideOpen || offlineReadyOpen || !!shareLink
  // The two slots are elements, so TopBar's `memo` sees the same ones only while their inputs
  // are the same: built here once per change, not once per render.
  const titleSlot = useMemo(() => (
    <IncidentSwitcher
      active={incidentMeta}
      incidents={incidents}
      isEditor={isEditor}
      syncStatus={syncStatus}
      syncDetail={syncDetail}
      lastSyncedAt={lastSyncedAt}
      startedAt={incidentMeta.started_at}
      endedAt={endedAt}
      user={switcherUser}
      onSettings={bar.onSettings}
      onSwitch={onSwitchIncident}
      onHistory={linkScoped ? undefined : onOpenHistory}
      onObjectVisits={bar.onObjectVisits}
      onKarte={linkScoped ? undefined : onOpenKarte}
      onEditMeta={canEditMeta ? onEditMeta : undefined}
      onDivera={onOpenDivera}
      alarms={menuAlarms}
      folded={menuFolded}
      onArchive={bar.onArchive}
      // ONE number, the nav tile's and the Rapport head's (29.09.2026): a +1 for Trupps still
      // out made this badge say 5 where the nav said 4 one tap away. The confirm names
      // the Trupps that are still out («Trupps noch drin»), so nothing is lost.
      archiveOpenCount={archiveOpenCount}
      onShare={bar.onShare}
      onPresent={bar.onPresent}
      onHelp={bar.onHelp}
      onInstall={bar.onInstall}
      onSyncNow={syncNow}
      onLogout={bar.onLogout}
      onLogin={bar.onLogin}
      // «Einsatz abgeschlossen» (sweep #5, 27.10.2026): the lock in the pill's ✓ slot, the
      // card's «Abgeschlossen 01:18» pill folding out its two exits
      onBackFromArchive={onBackFromArchive}
      onReactivate={onReactivateActive}
      navKey={navKey}
      sheetOpen={sheetOpen}
      viewOnly={viewOnly}
    />
  ), [incidentMeta, incidents, isEditor, syncStatus, syncDetail, lastSyncedAt, endedAt, switcherUser, bar, onSwitchIncident,
    linkScoped, onOpenHistory, onOpenKarte, canEditMeta, onEditMeta, onOpenDivera, menuAlarms, menuFolded, archiveOpenCount,
    syncNow, onBackFromArchive, onReactivateActive, navKey, sheetOpen, viewOnly])
  // On EVERY surface, unlike the GPS caveat: this says what the device in your hand
  // is doing, which does not stop being true because you switched to the Plan.
  const shareSlot = useMemo(() => <SharePositionPill share={share} onChangeName={onShareChangeName} />, [share, onShareChangeName])
  // On the phone map surface the compass in the bottom bar already carries Einpassen
  // (== centerIncident) + Mein Standort, so a top-bar center button here would just
  // duplicate it AND crowd the narrow bar off its right edge (clipping the Atemschutz
  // alarm chip). A Plan's bottom bar carries «Einpassen» as its own tile too (20.09.2026:
  // the top-bar twin went) – so this is left ONLY for the sheets that have no bar at all:
  // a viewer-only Modul, the Gebäude pick surface, a replay. A phone's plan has no other
  // zoom control there, so this is the one way back.
  const fitLabel = isPhone && mode === 'plans' && !phoneTools ? appConfig.copy.nav.fit : null
  const mapNav = useMemo(() => (fitLabel ? { action: { icon: 'cross', label: fitLabel, onClick: () => planFit.current?.() } } : null), [fitLabel, planFit])
  return (
    <>
      <TopBar
        incident={incidentView}
        startedAt={incidentMeta.started_at}
        // the declared Einsatzende wins over the server's closure stamp: it is what the EL said
        // the Einsatz ended, and it is what the Rapport prints
        // ⚠️ `closed_at` only while CLOSED (staging r3, F3): it is the FIRST Einsatzende and is
        // kept across «Wieder öffnen», so a reopened Einsatz's clock stood frozen at the close on
        // every device. The Rapport's own Einsatzende still stops it — that is a stated fact.
        // …and the CURRENT close, not the first, once it is closed again (D2)
        endedAt={endedAt}
        recording={recording}
        recStartedAt={recStartedAt}
        journalOpen={journalOpen}
        onToggleJournal={bar.onToggleJournal}
        reminderCount={reminderCount}
        onAddEntry={bar.onAddEntry}
        onHoldStart={bar.onHoldStart}
        onHoldEnd={bar.onHoldEnd}
        onHoldPhoto={bar.onHoldPhoto}
        // ⚠️ ONE pair, ONE history (08.09.2026). It used to route by surface — «take back what you
        // last did HERE» — which asked the operator to already know which surface his last tap
        // landed on, and left the Tafel's actions reachable only through a toast that expired.
        // It now steps the one global timeline and NAMES what it will take back, so an undo that
        // lands on another surface is never invisible (lib/undoTimeline · IncidentWorkspace ·
        // stepHistory).
        onUndo={bar.onUndo}
        onRedo={bar.onRedo}
        canUndo={histCanUndo}
        canRedo={histCanRedo}
        undoLabel={undoLabel}
        redoLabel={redoLabel}
        // ⚠️ No longer gated by SURFACE (08.09.2026). It used to be «map, plans or anwesenheit,
        // and not tacticalLocked», because on Checklisten or Mittel the pair would have stepped
        // the map's document invisibly — the very thing that made it a per-surface control. With
        // one timeline that reason is gone and the gate inverts: those surfaces are exactly the
        // ones whose actions had no way back at all, and hiding the pair there would hide the
        // only door to them. What is left is the honest question — may this session write
        // anything? An Einsatzleiter may (the record surfaces), so `tacticalLocked` is the wrong
        // test for it; a viewer may not, and gets nothing.
        showHistory={canEditIncident || canEditRecord}
        // On EVERY surface, not only the Karte: which way the smoke goes matters exactly as much
        // on the Atemschutz board and a Modul as on the map, and the chip vanishing on a surface
        // switch read as «the weather indicator is broken» in the field. Phones keep their
        // map-only float (.phone-wx) — that bar is genuinely too narrow everywhere else.
        weather={displayWeather}
        onOpenWeather={openWeatherDetails}
        bearing={bearing}
        azAlarm={azAlarm}
        // ONE red door per alarm on screen (29.09.2026, sweep 3 T1): on the Trupps board the head's
        // «⚠ n» badge is it, elsewhere the Meldeleiste row naming the same Trupp; the chip comes
        // back once «Zum Trupp» took that row down, and the amber lead always keeps it
        azChipHidden={azChipRedundant(azAlarm, mode === 'atemschutz', azRowsShown)}
        onOpenAtemschutz={bar.onOpenAtemschutz}
        // Only on the map surface: the chip is a caveat about what the MAP is showing, and on
        // Plan/Atemschutz there are no vehicle symbols for it to qualify. During replay the
        // positions are historical by definition, so a staleness warning would be nonsense.
        gpsStale={mapUI && !replayActive && gpsStale}
        gpsAgeMs={gpsAgeMs}
        shareSlot={shareSlot}
        mapNav={mapNav}
        titleSlot={titleSlot}
      />
    </>
  )
})
