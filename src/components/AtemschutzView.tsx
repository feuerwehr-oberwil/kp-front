import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime, stripUnprintable } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import { cx } from '../lib/cx'
import { newId } from '../lib/ids'
import { Segmented } from './Segmented'
import { Button } from './Button'
import { Chip } from './Chip'
import { Menu, Overlay, Popover, SheetFoot, SheetGrab } from '../lib/overlays'
import { NotfallBanner, NotfallHold } from './AtemschutzNotfall'
import { alarmBarFor, currentRunStart, deriveTruppLive, notfallOffered, safetyInside, safetyReady, truppInNotfall, earlyEntryCorrection, entryPressureAsks, isStandDownExit, estimatePressure, truppEditPatch, truppFieldGroupsChanged, truppLogName, type TruppFieldGroup, fmtClock, fmtDuration, fmtElapsedFull, isAtemschutzTrupp, pressureAlarm, truppAlarm, truppFieldsOf, truppHeadName, truppInField, truppNeverDeployed, truppRegisteredAt, truppStillDeployed, truppTransferState, type TruppAlarm, type TruppLive, type TruppTransferState } from '../lib/atemschutz'
import { foreignContactAgo } from '../lib/contactEcho'
import { serverNow, serverNowIso } from '../lib/serverClock'
import { isPresent } from '../lib/attendanceIntervals'
import { ortOf } from '../lib/attendanceOrt'
import { readingBarShown, truppAuftragLabel, truppEquipmentLabels, truppStatusLabel } from '../lib/report'
import { useIsPhone } from '../lib/useIsPhone'
import { usePageHeadFit } from '../lib/pageHeadFit'
import type { AttendanceState, Person, Trupp, TruppAuftrag, TruppFields, TruppKind, TruppReading } from '../types'
import { assignedPersonIds, personIdForName, rosterFromList, rosterIdByName, truppSlots } from '../lib/personnel'
import { truppLineNo, type LeitungOption } from '../lib/truppLines'
import { markerHolderNote, type MarkerOption } from '../lib/placedTrupps'
import { ClearableInput } from './ClearableInput'
import type { Slot } from './PersonField'
import { TruppTeam } from './TruppTeam'
import { ensureNotifyPermission, notificationsSupported, unlockAlarm } from '../lib/alarm'
import { atemschutzDoctrine, atemschutzEquipment, isDemoMode } from '../lib/deploymentConfig'
import type { SyncStatus } from '../lib/api/workspaceSync'
import { CLOCK_SKEW_WARN_MIN } from '../lib/syncAlert'
import { keepDraft, useKeptState } from '../lib/draftKeep'
import { truppOrderKey } from '../lib/useTruppActions'
import s from './Atemschutz.module.css'
import { AuftragSheet, KanalPickSheet, KanalSheet, LeitungField, PressureSheet, TeamConflictRow, TruppSheet } from './TruppSheets'
import { fileGuestSlots, teamConflict, truppSheetSub } from '../lib/truppQuickEdit'
import { crewAfterChange, type CrewChange } from '../lib/truppLeader'
import { rankOrder } from '../lib/rank'

const cfg = appConfig.atemschutz // static, non-doctrine parts only (the two auftrag lists)
// `az` (appConfig.copy.atemschutz) and the doctrine numbers (`atemschutzDoctrine()`) are read
// at the top of each component/helper below rather than captured here at module-load, so the
// locale AND the deployment config resolved at boot apply.

/**
 * The last incoming `focus` nonce this view has already rung the bell for — MODULE scope, not
 * component state, on purpose (read while deriving `externalFocus`, written once it was shown).
 *
 * IncidentWorkspace renders this view behind `mode === 'atemschutz'`, a plain conditional: leaving
 * the page fully UNMOUNTS it, and its `truppFocus` state (the source of the `focus` prop) is never
 * cleared once shown — by design, «a repeat tap on the same alarm must replay the mark». But an
 * un-cleared pointer stays exactly as true across a REMOUNT as it does across a re-render, so the
 * very next ordinary visit to this page replayed the same ring on a Trupp that had long since come
 * back — a stale notification, an old locked-row tap, minutes or exercises later. Invisible until
 * 30.08. (see .cardFlash below): the ring itself silently never fired before that, so nobody saw
 * the replay happen. Module scope survives the remount the way `seededFocus`'s per-mount ref
 * deliberately does not — this is the one thing here that must NOT reset with the page.
 */
let lastShownFocusNonce: number | null = null
/** …and the last `createRequest` nonce already opened — same remount replay, same cure. */
let lastOpenedCreateNonce: number | null = null

type FormMode = 'create' | 'edit' | 'redeploy'

/** «niemand ist gebunden» — one frozen instance, because it feeds a `useMemo` dependency in the
 *  form and a fresh Set on every render would re-run that memo for nothing (see `assignedIds`). */
const NO_ASSIGNED: Set<string> = new Set()

/** How the board is arranged — mirrors Prefs.atemschutzOrder. */
export type TruppOrder = 'dringlichkeit' | 'manuell' | 'auftrag' | 'name'

/** Non-AS Trupp wording — APP ONLY (09.09., field ask). A work squad reports a task done, not a
 *  radio check, so the app says «Auftrag erledigt» / «Ohne Auftrag» / «Ohne Auftrag seit» for
 *  one, instead of borrowing Atemschutz vocabulary. The handed-over link board (`lite`) keeps
 *  today's words for EVERY Trupp on it, plain ones included — it is the one screen an outside
 *  operator was handed, and it must keep meaning what it always meant.
 *  `truppStatusLabel` (lib/report.ts) stays AS vocabulary — it also prints the Rapport — so this
 *  only swaps its plain «Draussen» result at the view layer, never «Nicht eingesetzt» / «Von
 *  Tafel entfernt», which read true for a work squad exactly as they are. */
function plainWords(t: Trupp, lite: boolean) {
  const az = appConfig.copy.atemschutz
  const plain = !lite && !isAtemschutzTrupp(t)
  return {
    exit: plain ? az.actExitPlain : az.actExit,
    outFor: plain ? az.outForPlain : az.outFor,
    status: (label: string) => (plain && label === az.status.raus ? az.statusPlainOut : label),
  }
}

// The Atemschutzüberwachung surface: the digital Atemschutz-Überwachungstafel. Swiss FKS model
// — one big glanceable card per Trupp whose dominant element is TIME SINCE LAST FUNKKONTAKT, a
// large "Kontakt" reset, and a contact-clock alarm (amber nudge → red überfällig). Pressure is
// set inline and logged. Purely presentational + local UI state — data + mutations via props.
/** the tier every Trupp has on a CLOSED Einsatz — silent (R3) */
const FROZEN_ALARM: TruppAlarm = { sev: 0, reason: null, line: null }

/** The Trupps head's ladder (lib/pageHeadFit, 28.09.2026): what gives first when the one row runs
 *  out — the quiet line's time, then the tiles' words, lowest priority first (a way of LOOKING at
 *  the board before the handover, the handover before the way back to a deleted card, the alarm's
 *  word before the bell's honest state — the ⚠ and its count stay), then «Trupp anmelden» → «Trupp»,
 *  and last «✓ Gespeichert» keeps its ✓ (the sentence stays its `title`; a LOUD state never folds). */
const HEAD_FOLD = { saved: 1, order: 2, share: 3, restore: 4, overdue: 5, bell: 6, newTrupp: 7, savedMark: 8 } as const

/** The room the sticky Notfall stack takes at the top of the board's port (+ the air under it). */
const nfInset = (el: HTMLElement | null) => (el ? el.offsetHeight + 12 : 0)

export function AtemschutzView({
  trupps: allTrupps, truppColors, canEdit, personnel, attendance, muted, onToggleMuted, audioBlocked = false, onUnlockAudio, onAddGuest, order = 'manuell', onOrder, onMove, createTrupp, placeTrupp, placeTargets, markerOptions, adoptMarker, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, transferOutOfTrupp, reactivateTrupp, deleteTrupp, restoreTrupp, removedTrupps: allRemovedTrupps = [], leitungOptions, showTruppLine, truppsWithLine, lineNoOf, unlinkTruppLine, dockedAt,
  intervalMin = atemschutzDoctrine().contactIntervalMin, graceSec = atemschutzDoctrine().contactGraceSec,
  defaultFunkkanal = atemschutzDoctrine().defaultFunkkanal,
  focus, createRequest, onShareLink, shareLinkActive = false, lite, frozenAt, triggerNotfall, endNotfall, placeOf,
  onUndo, onRedo, canUndo = false, canRedo = false, undoLabel, redoLabel,
  syncStatus, lastSyncedAt, clockSkewMs,
}: {
  trupps: Trupp[]
  /** trupp id → the colour it wears on the Lage / plan (useTruppActions · truppColors). Every
   *  Trupp has an entry: placed colour, then decided colour, then its automatic palette slot. */
  truppColors: Record<string, string>
  canEdit: boolean
  /** per-incident Funkkontakt-Intervall (min) + Nachfrist (sec); default = appConfig doctrine */
  intervalMin?: number
  graceSec?: number
  /** synced default Funkkanal new Trupps are seeded with (FKS-Standard: 11) */
  defaultFunkkanal?: number
  /** Mannschaft roster + who is present — the create/edit form offers present people first */
  personnel: Person[]
  attendance: AttendanceState
  /** alarm audibility (per device, scoped to this Einsatz — see useAtemschutzMute). It covers
   *  BOTH channels: the tone and the OS notification. The actual alarm runs app-wide in
   *  useAtemschutzAlarm, so it fires even when this surface is not on screen. */
  muted: boolean
  onToggleMuted: () => void
  /** the browser has not released audio, so the tone cannot play whatever the bell claims. The
   *  bell shows this state instead of «an» and its tap retries the unlock. */
  audioBlocked?: boolean
  onUnlockAudio?: () => void
  /** how the board is arranged (device pref) — überfällig floats regardless, see sortTrupps */
  order?: TruppOrder
  onOrder?: (o: TruppOrder) => void
  /** move a card one slot in the hand-set order; only offered while that order is the one shown */
  onMove?: (id: string, dir: -1 | 1) => void
  createTrupp: (t: Trupp) => void
  /** place a Trupp's marker — targetId is the Lage map or a plan (see App's placeTargets) */
  placeTrupp: (id: string, targetId?: string) => void
  /** where a Trupp can be placed (Lage map / Gebäude / Modul 6) — >1 shows a picker first */
  placeTargets: { id: string; label: string }[]
  /** the Trupp symbols ALREADY standing on the Lage / a plan (lib/placedTrupps · markerOptions),
   *  offered under the placement targets: a «Trupp 2» dropped before anybody was registered is
   *  joined to its Trupp from here, the way a Trupp picks a drawn Leitung. */
  markerOptions: (exceptTruppId?: string) => MarkerOption[]
  /** join one of those symbols to this Trupp (useTruppActions · adoptTruppMarker — it owns the
   *  takeover confirm, so this side just hands over the two ids) */
  adoptMarker: (truppId: string, markerId: string) => void
  focusTruppOnPlan: (id: string) => void
  recordContact: (id: string) => void
  recordPressure: (id: string, bar: number) => void
  /** `exitBar` = the Restdruck asked at «Raus melden» (PressureSheet); absent = without one */
  setTruppStatus: (id: string, status: Trupp['status'], exitBar?: number, opts?: { undoToast?: boolean }) => void
  editTrupp: (id: string, f: TruppFields) => void
  /** Take one person out of the Trupp that still holds them — the «bereits in einem anderen
   *  Trupp» warning's own fix (useTruppActions · transferOutOfTrupp). `toName` is the
   *  Gruppenführer of the Trupp being formed here, so the row it writes can say where they went.
   *  Absent ⇒ the warning keeps the plain sentence it has always had. */
  transferOutOfTrupp?: (fromId: string, personId: string, toName?: string) => boolean
  /** The Atemschutznotfall (F1, 08.10.2026): raise it on a crew inside / end it — both HELD on
   *  the card (AtemschutzNotfall · NotfallHold). Absent ⇒ the board offers neither. */
  triggerNotfall?: (id: string) => void
  endNotfall?: (id: string) => void
  /** where a Trupp was last seen, in words (useTruppActions · truppPlace) — the Notfall's «Ort» */
  placeOf?: (t: Trupp) => string | undefined
  /** `standby` re-registers the Trupp as Reserve (angemeldet) instead of sending it straight in */
  reactivateTrupp: (id: string, f: TruppFields, standby?: boolean) => void
  deleteTrupp: (id: string) => void
  /** undo for deleteTrupp — re-adds the captured Trupp (minus its removed placement) */
  restoreTrupp: (t: Trupp) => void
  /** Trupps taken off the board (types · Trupp.removedAt), newest first — the door behind the
   *  delete's six-second toast. */
  removedTrupps?: Trupp[]
  /** the drawn Leitungen offered in the form, excluding the edited Trupp's own from «taken» */
  leitungOptions: (exceptTruppId?: string) => LeitungOption[]
  /** jump to the Leitung a Trupp works on (Lage or Plan) */
  showTruppLine: (id: string) => void
  /** ids of Trupps whose Leitung is actually drawn somewhere */
  truppsWithLine: ReadonlySet<string>
  /** the Leitung number each Trupp's DRAWN hose carries right now (useTruppActions ·
   *  truppLineNos) — the picture is the source of truth for the number, the Trupp's stored
   *  copy only the fallback for a hose that has since been deleted. */
  lineNoOf?: ReadonlyMap<string, number>
  /** release a Trupp's Leitung — used when another Trupp takes it over (confirmed Ablösung) */
  unlinkTruppLine: (id: string) => void
  /** the symbol a Trupp's map marker is docked to (lib/docking), by Trupp id – «bei «Hydrant»»
   *  on the card's Kennzeile. Absent ⇒ no marker, or a marker standing on its own. */
  dockedAt?: ReadonlyMap<string, string>
  /** put a hand-typed Gast on the Anwesenheit — a Gast under PA was at the Einsatz, and a name
   *  that only ever existed on a Trupp card reaches neither the Personalblatt nor the export */
  onAddGuest?: (name: string) => string | undefined
  /** «point at THAT Trupp» — set by a locked Anwesenheit row. The nonce makes a repeat tap point
   *  again; the card scrolls itself into view and flashes, then the mark clears on its own. */
  focus?: { id: string; nonce: number } | null
  /** «Neuer Trupp» from a loose marker/chip on the Karte or a Plan (TwinTeamPill · TruppJoinMenu):
   *  open the create form; on save the new Trupp adopts `adoptMarkerId` (through `adoptMarker`).
   *  Cancel leaves the marker as it is. Nonce grammar as `focus`. */
  createRequest?: { nonce: number; adoptMarkerId: string } | null
  /** «Überwachung abgeben» — open the Weitergeben sheet on its «Nur Atemschutz» half, so the
   *  Tafel of this Einsatz can be handed to somebody's phone (components/panels · ShareIncident).
   *  Editors only, and never on the handed-over board itself: a link may not mint links. */
  onShareLink?: () => void
  /** …and whether one is currently live. The button's whole «on» state, deliberately: a device
   *  counter was dropped as YAGNI (01.09.), so this says that a link EXISTS and nothing more. */
  shareLinkActive?: boolean
  /**
   * «Tafel pur» — this board IS the whole app for this session (an Atemschutz-Link on somebody's
   * own phone): no NavRail, no TopBar, no context panel, no menus. Same cards, same words, same
   * bell; what goes is everything that points at a surface the session cannot reach — placing a
   * Trupp on the Karte, picking or showing a Leitung, moving a card in the board order, and the
   * order menu itself. `subtitle` replaces the generic one, because the one thing this screen
   * must say and otherwise could not is WHICH Einsatz it is watching.
   *
   * ⚠️ It carries no «Abmelden» and no other way «off» the board (02.09.). The link is the
   * literal page: it owns no login on this phone to end, and the button that stood beside the
   * bell ended the phone's OWN one. Leaving is closing the page; coming back is the link.
   */
  lite?: {
    subtitle: string
    /** The two halves `subtitle` is joined out of. The one-row head (09.09.) cuts the joined
     *  line and hands the whole thing to the detail popover behind it, which prints them apart
     *  — «Stichwort · Adresse» wrapped mid-address reads as one long broken string. Optional:
     *  without them the popover falls back to the joined line, which is still true. */
    title?: string
    address?: string
  }
  /** The app's ONE undo/redo pair, for the handed-over «Tafel pur» that has no TopBar to carry it.
   *  It drives the same global timeline everything else does (lib/undoTimeline) — see the markup
   *  in `headActs` for why it renders only under `lite`. Handed the event so the confirmation
   *  caption can be anchored at the button (lib/undoFlash). */
  onUndo?: (e: MouseEvent<HTMLButtonElement>) => void
  onRedo?: (e: MouseEvent<HTMLButtonElement>) => void
  canUndo?: boolean
  canRedo?: boolean
  /** what ↶ ↷ would take back / put back, in the operator's words — the hold-tooltip reads it off
   *  `aria-label`, so naming it here is the whole promise. */
  undoLabel?: string | null
  redoLabel?: string | null
  /** Epoch ms to read every clock against instead of the running one — the Einsatzende of an
   *  abgeschlossener Einsatz (IncidentWorkspace). Absent while the Einsatz is open, which is the
   *  only state in which a Trupp's time is still passing. */
  frozenAt?: number
  /** The incident's sync lifecycle (useIncidentSync), rendered in the board's OWN header
   *  (safety review 01.09.): the surface a life depends on must say itself whether what it
   *  shows is saved and current — offline or a failing sync has to be visible without the
   *  top-bar pill, which the handed-over Tafel does not even have. Absent = no status line. */
  syncStatus?: SyncStatus
  /** epoch ms of the last save the server accepted — the «Stand» a loud chip dates */
  lastSyncedAt?: number | null
  /** device-vs-server clock offset (ms, positive = device runs ahead; minute-quantized, null
   *  until the first sample — useIncidentSync). Beyond ±CLOCK_SKEW_WARN_MIN it earns its own
   *  warning chip. The clocks on this board are counted in the DEPLOYMENT's time since 02.09.
   *  (lib/serverClock), so the chip is no longer about them — it is about a device that is
   *  minutes out, whose operator will read every other timestamp in the app (Verlauf, Fotos,
   *  Anwesenheit) as if it were right. */
  clockSkewMs?: number | null
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  /* ── «Tafel pur» sees the Atemschutz and NOTHING else (decided 03.09.) ─────────────────────
   * The handed-over board exists to operate the Atemschutzüberwachung — that is what the QR
   * promises, what the link's backend allowlist permits and the whole reason a stranger's phone
   * is looking at this Einsatz at all (see `lite` below). A Verkehrstrupp on it would be a row
   * that carries no clock, cannot be reached from any other surface of that session, and quietly
   * widens what «Überwachung abgeben» hands over. So a link session's board is filtered here,
   * at the source: no section, no rows, and no way to create one (the form's Art chooser is
   * `!lite` too). The Trupps still exist — they are simply not this session's business. */
  const trupps = useMemo(() => (lite ? allTrupps.filter(isAtemschutzTrupp) : allTrupps), [allTrupps, lite])
  const removedTrupps = useMemo(
    () => (lite ? allRemovedTrupps.filter(isAtemschutzTrupp) : allRemovedTrupps),
    [allRemovedTrupps, lite],
  )
  // the shared create / edit / re-deploy form — null when closed
  // `adoptMarkerId`: the loose marker a create form was opened FROM — joined to the Trupp on save
  const [form, setForm] = useState<{ mode: FormMode; trupp?: Trupp; focus?: 'auftrag'; adoptMarkerId?: string; presetAuftrag?: TruppAuftrag } | null>(null)
  /* The mini sheets (26.09.2026, phone card slim-down — components/TruppSheets): one fact of the
   * card, one short sheet, every save through `editTrupp`. Opened from the card's chips on every
   * width (the tablet's Kennzeile entries are the same doors), so the sheet is what a tap on a fact
   * does — the big form stays for Art and Eingangsdruck, behind «Bearbeiten». */
  const [quick, setQuick] = useState<{ id: string; kind: 'kanal' | 'auftrag' | 'trupp' } | null>(null)
  /* The one pressure picker (PressureSheet, 24.09.2026): a Druckmeldung from the phone row or card,
   * and the Restdruck at «Raus melden» on every width. Null when closed. */
  const [pressureAsk, setPressureAsk] = useState<{ id: string; kind: 'pressure' | 'exit' } | null>(null)
  /**
   * personId → the OTHER Trupp that still holds them, for the form's double-assignment warning
   * and the «In diesen Trupp verschieben» behind it.
   *
   * Same rule as `assignedPersonIds`, which is what decides that the warning appears at all: a
   * `raus` Trupp holds nobody, and the Trupp being edited is never its own conflict — so the
   * card this answers with is always the one the sentence is complaining about.
   */
  const truppOfPerson = useMemo(() => {
    const by = new Map<string, Trupp>()
    for (const t of trupps) {
      if (t.status === 'raus' || t.id === form?.trupp?.id) continue
      if (t.leaderPersonId) by.set(t.leaderPersonId, t)
      for (const id of t.memberPersonIds ?? []) by.set(id, t)
    }
    return by
  }, [trupps, form?.trupp?.id])
  /**
   * «zeig mir den» from THIS surface — the header's überfällig badge. The `focus` prop covers
   * the jump in from somewhere else (a locked Anwesenheit row); this is the same mark set from
   * inside, so the badge behaves like the app-wide TopBar chip it mirrors instead of being the
   * one warning on the screen that does nothing when you press it.
   *
   * The later nonce wins, so whichever pointed last is the one the board obeys.
   */
  const [selfFocus, setSelfFocus] = useState<{ id: string; nonce: number; markAll?: boolean } | null>(null)
  // the incoming pointer, minus a nonce this view has already rung the bell for once (module-scope
  // guard against a REMOUNT replaying a stale one — see `lastShownFocusNonce` above). A genuinely
  // NEW nonce — an actual repeat tap, or a fresh jump arriving while this page stays mounted —
  // passes through untouched; TruppRow/TruppCard's own `focusNonce`-keyed effect handles that case
  // exactly as before.
  // `shownNonce` — per MOUNT — is the other half of that: the instant the effect below records the
  // nonce, the bare `!== lastShownFocusNonce` test would turn the pointer stale under its own ring.
  // The per-second tick re-renders inside the 1.9s flash window, so the mark would be yanked back
  // mid-gesture. A nonce THIS mount has already accepted therefore stays accepted until it leaves.
  const shownNonce = useRef<number | null>(null)
  const externalFocus = focus && (focus.nonce === shownNonce.current || focus.nonce !== lastShownFocusNonce)
    ? focus
    : null
  const activeFocus = (selfFocus?.nonce ?? -1) > (externalFocus?.nonce ?? -1) ? selfFocus : externalFocus
  // Mark it seen once this view has actually SHOWN it — a later visit then filters it out above,
  // however long the pointer stays parked upstream. Keyed on the nonce rather than mount-only:
  // IncidentWorkspace sets `truppFocus` while this view is already mounted too (jumping to the tab
  // you are already on leaves the view standing), and a mount-only mark recorded none of those —
  // they were shown and never written down, so the next ordinary visit replayed them, which is
  // exactly the stale ring this guard exists to stop.
  // Reads `externalFocus`, not the raw prop: a pointer that arrived already stale showed nothing,
  // so there is nothing to record — and recording it would let it back in on the next render.
  useEffect(() => {
    if (!externalFocus) return
    shownNonce.current = externalFocus.nonce
    lastShownFocusNonce = externalFocus.nonce
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])
  /**
   * «Passiert, dass ich drücke. Benötigte dann den Code nochmals.» (field feedback, 02.09.,
   * Safari's own ✕). A `beforeunload` confirm is not the fix here: iOS Safari does not reliably
   * show one for a plain tab close, and `useIncidentSync` already dropped `beforeunload`
   * app-wide because it blocks the back/forward cache — adding it back for one surface would
   * regress that for every surface sharing the page. What answers the field report is that the
   * ADDRESS is the way back: opening the same link again — from the message it arrived in, the
   * browser's own history, or the QR held out a second time — puts this exact board back, and
   * the exchange behind it is invisible.
   *
   * ⚠️ It says the LINK, not the device (reworded 02.09.). It used to promise that «this device
   * stays signed in for a few hours», which was true of the cookie and wrong about everything
   * else: a link signs nothing in, and the sentence taught the one thing a handed-over board
   * must never suggest — that scanning somebody's QR did something to this phone's own login.
   * Once per device (localStorage), and only on the handed-over board, which is the only screen
   * whose holder cannot simply reach the rest of the app.
   */
  useEffect(() => {
    if (!lite) return
    const KEY = 'kp.atemschutz.linkReentryHintSeen'
    try {
      if (localStorage.getItem(KEY) === '1') return
      localStorage.setItem(KEY, '1')
    } catch { /* private mode / storage disabled — show it every time rather than never */ }
    toast(az.linkReentryHint, { icon: 'info', duration: 9000 })
    // once per mount only, and `lite` never flips within a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // a Trupp awaiting a Gebäude/Modul-6 placement choice (only when >1 target exists)
  const [placePick, setPlacePick] = useState<string | null>(null)
  const handlePlace = (id: string) => {
    // «Wohin platzieren?» has two kinds of answer: a surface to put a NEW symbol on, and a symbol
    // that is already standing (a «Trupp 2» somebody dropped before this Trupp existed). Both are
    // counted here, so a station with one plan and one loose marker still gets to choose.
    const markers = markerOptions(id)
    // nothing to place on and nothing standing — the EL must first create a Gebäude (from the
    // Umrisse) or there is no Modul 6 for this object. Tell them rather than doing nothing.
    if (placeTargets.length === 0 && markers.length === 0) { toast(az.placeNoTarget, { icon: 'warn', tone: 'warn' }); return }
    if (placeTargets.length + markers.length > 1) setPlacePick(id)
    else if (placeTargets.length) placeTrupp(id, placeTargets[0].id)
    else adoptMarker(id, markers[0].key)
  }

  // per-second tick so the contact clock re-renders (pattern from TopBar's clock). This drives
  // the VISUAL board only; the audible alarm + OS notification run app-wide (useAtemschutzAlarm).
  //
  // ⚠️ `serverNow()`, not `Date.now()` (02.09.): the contact clock is read off the deployment's
  // clock so a phone and a PC watching the same Trupp show the SAME number. They did not — a
  // six-second device-clock difference was six seconds of difference on the board, and the
  // operator has no way to tell which of the two is lying. Offline it IS Date.now().
  /* ⚠️ …and it STOPS at the Einsatzende once the Einsatz is abgeschlossen (`frozenAt`, 04.09.).
   * A closed Einsatz is a record, not a situation: a Trupp that was never reported out kept
   * accumulating Einsatzzeit through the night, so opening the Akte the next morning showed a
   * crew «seit 14:12 im Einsatz» — a number about nothing. Frozen, every clock on the board reads
   * what it read when the Einsatz ended, which is what the paper says too. The tick is not merely
   * ignored but never started: there is nothing left to count. */
  const [tick, setTick] = useState(() => serverNow())
  useEffect(() => {
    if (frozenAt != null) return
    const t = setInterval(() => setTick(serverNow()), 1000)
    return () => clearInterval(t)
  }, [frozenAt])
  const now = frozenAt ?? tick

  // the station's Alarmdruck lines — read as scalars, because atemschutzDoctrine() builds a
  // fresh object on every call and a memo keyed on it would recompute on every render
  const { alarmBar, alarmBarRueckzug } = atemschutzDoctrine()

  // derive every Trupp's live numbers once per tick
  const live = useMemo(
    () => new Map(trupps.map((t) => [t.id, deriveTruppLive(t, now, intervalMin, graceSec)] as const)),
    [trupps, now, intervalMin, graceSec],
  )

  /* …and its TIER, once, from the same fold the tone and the TopBar chip use (lib · truppAlarm).
   * ⚠️ The card, the row, the header badge and the sort all read THIS — not the contact clock.
   * They used to read the clock alone, so a Trupp at the Alarmdruck with a fresh Funkkontakt had
   * the whole app alarming beside a green, unbadged, unsorted card. One number, one board. */
  /* ⚠️ A CLOSED Einsatz alarms nothing (R3, staging 25.09.2026): its clocks stand at the close,
   * and a crew that was overdue then read as a red «1 Alarm» and a red clock on every phone —
   * at 3am, an alarm still running. Frozen, every tier is silent: no badge, no red card, and the
   * band says what the clock shows (the state at the close), in the neutral tone. */
  const alarms = useMemo(
    () => new Map(trupps.map((t) => [t.id, frozenAt != null ? FROZEN_ALARM : truppAlarm(t, live.get(t.id)!, intervalMin, graceSec, { alarmBar, alarmBarRueckzug })] as const)),
    [trupps, live, intervalMin, graceSec, alarmBar, alarmBarRueckzug, frozenAt],
  )
  const sevOf = (id: string): 0 | 1 | 2 => alarms.get(id)?.sev ?? 0

  /* How far past its own line a Trupp is, as one comparable number — the ranking
   * `peakAtemschutzAlarm` uses for the TopBar chip, mirrored here so the header badge jumps to
   * the card the chip points at. Pressure ranks by bar below the line (×60, so it sorts against
   * the seconds of a contact clock); contact ranks by seconds. */
  const urgency = (t: Trupp) => {
    const a = alarms.get(t.id)
    const l = live.get(t.id)
    if (!a || !l) return -1
    // a Notfall stands above every clock (F1) — and the longest-running one first
    if (a.reason === 'notfall') return 1e12 + (t.notfallAt ? now - Date.parse(t.notfallAt) : 0)
    return a.reason === 'pressure' ? ((a.line ?? 0) - l.currentBar) * 60 : l.sinceContactSec ?? 0
  }

  // Trupps in alarm float to the top of the board so one can't hide off-screen, and the header
  // carries a count badge (the alarm may be muted — the visual must not be).
  const alarmTrupps = trupps.filter((t) => sevOf(t.id) >= 2)
  const overdueCount = alarmTrupps.length
  // the one the badge jumps to: the same ranking peakAtemschutzAlarm gives the TopBar chip —
  // a pressure alarm by how far below its line, a contact alarm by how long out of contact —
  // so the badge, the chip and the board's own sort all point at the same card
  const mostOverdue = [...alarmTrupps].sort((a, b) => urgency(b) - urgency(a))[0]
  /* Arriving on the board DURING an alarm lands on the due card, marked. The TopBar chip, the
   * NavRail dot and the OS notification all bring the operator here without saying WHICH card
   * they meant — so the board points itself, with the exact mark the header badge sets: flash +
   * scroll (activeFocus → TruppCard/TruppRow). Once per mount only — a later crossing must not
   * yank the board out from under a working hand (the badge is the hand for that) — and never
   * over an external jump: a `focus` prop present at mount (a locked Anwesenheit row) already
   * names its card and wins.
   *
   * ⚠️ NOT on the demo (isDemoMode): its incident is frozen in a worked state, so a field Trupp
   * drifts überfällig purely because real time passes since the last reset — useAtemschutzAlarm
   * already keeps that visual (the card stays red, honestly), but silences the tone and the OS
   * notification because it is not a real emergency. A mount-time flash+scroll to that card is
   * the same false alarm wearing a different costume — a visitor opening the board sees a ring
   * around a Trupp nobody is actually worried about. Real stations (demoMode off) are unaffected. */
  const seededFocus = useRef(false)
  useEffect(() => {
    if (seededFocus.current) return
    seededFocus.current = true
    // `externalFocus`, not the raw `focus` prop: a STALE pointer (already shown on an earlier
    // visit, filtered out above) must not block this board from pointing at a genuine CURRENT
    // alarm just because something unrelated once pointed here.
    if (!externalFocus && mostOverdue && !isDemoMode()) setSelfFocus({ id: mostOverdue.id, nonce: Date.now() })
    // mount-only by design (see above) — `externalFocus`/`mostOverdue` are read as of arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  /**
   * How the board is arranged:
   *   · «wie gesetzt»  — the DEFAULT: the hand-set order (Trupp.order, synced), so a card keeps
   *                      its slot and «Trupp 2 is the second one» stays true for the whole Einsatz.
   *                      NOTHING moves a row here — not even ÜBERFÄLLIG: whoever chose this mode
   *                      chose stable slots, and an overdue card is already unmissable (red card,
   *                      banner, header badge + jump). A row that teleports out of «its» slot is
   *                      the failure mode this mode exists to prevent.
   *   · «Dringlichkeit» — longest since Funkkontakt first (what the board did before)
   *   · «Auftrag» / «Name» — for a board big enough to look things up in
   * In the DERIVED sorts a Trupp in ALARM still floats to the top before the mode's own key:
   * those orders are recomputed anyway, so the float costs no stability and keeps an alarming
   * card from hiding off-screen. Alarm = the shared tier (`alarms`), so a Trupp at the
   * Alarmdruck floats exactly like one out of contact.
   * The MODE is per-device (a way of looking); the hand-set order is synced (it is data).
   */
  // ⚠️ ONE key space with the writers. `order` is optional, so a Trupp that never got one sorts
  // by its position in this list — and createTrupp/moveTrupp compute against exactly that key
  // (lib/useTruppActions · truppOrderKey), or a new card ties with an existing one and lands
  // mid-board. Also the stable tiebreak for the derived sorts, so two Trupps that compare equal
  // by name/Auftrag keep the slots the hand gave them.
  const orderKey = (t: Trupp) => truppOrderKey(t, trupps.findIndex((x) => x.id === t.id))
  /**
   * How long this crew has been out there, as the tiebreak both derived sorts need — 0 for
   * anybody who is not (04.09., Manuel: «den länger andauernden Einsatz zuerst»).
   *
   * ⚠️ `truppStillDeployed`, not the raw `elapsedSec`. That number is FROZEN at the Austritt and
   * keeps its total, so a crew that worked for an hour and came out would outrank every Trupp
   * actually inside — an urgency sort putting the finished ones on top. Only a running
   * deployment has a length that means anything here.
   */
  const runningSec = (t: Trupp) => (truppStillDeployed(t) ? live.get(t.id)?.elapsedSec ?? 0 : 0)
  /**
   * Where a Trupp stands in the work, as a rank: 0 out there · 1 waiting to go · 2 finished.
   *
   * The «Auftrag» sort is read to answer «who is doing what», and it used to answer it with a
   * plain alphabet — so a Trupp that had come out an hour ago, and one still standing at the
   * vehicle, sat left of the crews actually working (04.09., Manuel). The alphabet still orders
   * within each rank; what changed is that the crews the question is about come first.
   *
   * ⚠️ ONLY in this derived sort. «Wie gesetzt» keeps every card in its slot for the whole
   * Einsatz, finished or not — that is the promise that mode exists for (see the note below).
   */
  const workRank = (t: Trupp) => (truppStillDeployed(t) ? 0 : t.status === 'raus' ? 2 : 1)
  const baseSort = (list: Trupp[]) => [...list].sort((a, b) => {
    if (order !== 'manuell') {
      const alarm = Number(sevOf(b.id) >= 2) - Number(sevOf(a.id) >= 2)
      if (alarm) return alarm
    }
    if (order === 'name') return a.name.localeCompare(b.name, 'de') || orderKey(a) - orderKey(b)
    if (order === 'auftrag') {
      // ⚠️ By the LABEL on the card, not by a list index — which is what keeps this coherent now
      // that there are two Auftrag lists (config · atemschutz.auftrag + .auftragEinfach). Two
      // indices would collide («Retten» and «Verkehr» are both #1); the word the operator reads
      // orders both vocabularies in one alphabet, and the board is split into its PA and
      // non-PA sections anyway, so the two lists never actually interleave. A Trupp with no
      // Auftrag sorts last (￿), an id from the other list sorts by its own word.
      // …behind WHERE the Trupp stands in the work: out there, waiting, finished (`workRank`).
      // A Trupp with no Auftrag at all still sorts last within its own rank (￿).
      const rank = workRank(a) - workRank(b)
      if (rank) return rank
      return (truppAuftragLabel(a.auftrag) ?? '￿').localeCompare(truppAuftragLabel(b.auftrag) ?? '￿', 'de') || orderKey(a) - orderKey(b)
    }
    if (order === 'dringlichkeit') {
      // the tier first, then how far past its own line — the ranking the badge and the TopBar
      // chip use, so «Dringlichkeit» means the same thing everywhere it is spoken
      const tier = sevOf(b.id) - sevOf(a.id)
      if (tier) return tier
      const by = urgency(b) - urgency(a)
      if (by) return by
      // …and among cards that are equally urgent, the deployment that has been RUNNING LONGEST
      // (04.09., Manuel). Under PA the clock above already orders them — this is the answer for
      // everything it cannot see: a Trupp ohne Atemschutz has no Funkkontakt-Intervall, so every
      // one of them tied here and fell back to the board's hand-set order.
      const longest = runningSec(b) - runningSec(a)
      if (longest) return longest
    }
    return orderKey(a) - orderKey(b)
  })

  /* Hold the ARRANGEMENT still for a moment after any change made on this board.
   *
   * The überfällig float above is right and stays (in the derived sorts) — but it means a Kontakt re-sorts the board
   * under the finger. Measured at 1194×834: pressing Kontakt on the card in slot 1 reset its
   * clock, dropped it out of the überfällig group, and slid everything below up, so ~250ms later
   * `elementFromPoint` at the pressed pixel returned a DIFFERENT Trupp's card. With four
   * überfällige and an Überwacher working down the board, every Kontakt reshuffles the rest.
   *
   * Only the ORDER is frozen — clocks, colours, pressures and the überfällig banner keep updating,
   * so nothing is hidden, the cards just don't move out from under the hand. Anything new appears
   * after the frozen ones (stable sort on equal keys) rather than jumping into the middle. */
  const isPhone = useIsPhone()
  // Compact rows vs cards — a NARROW-SCREEN layout, nothing else (decided 16.08.); the long
  // note beside `openRow` below says why, and why a Trupp-count trigger was dropped.
  const compact = isPhone

  const FREEZE_MS = 2000
  const [frozenIds, setFrozenIds] = useState<string[] | null>(null)
  // the thaw: every freeze is a NEW array, so a second tap inside the window restarts the 2 s
  // (the timer used to live in a ref written from `freezeOrder`, which the phone board's extra
  // call sites turned into react-hooks/refs findings — an effect owns it without one)
  useEffect(() => {
    if (!frozenIds) return
    const h = window.setTimeout(() => setFrozenIds(null), FREEZE_MS)
    return () => window.clearTimeout(h)
  }, [frozenIds])

  const sortTrupps = (list: Trupp[]) => {
    const sorted = baseSort(list)
    if (!frozenIds) return sorted
    const rank = new Map(frozenIds.map((id, i) => [id, i]))
    return sorted.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  /* ── A Trupp that came back KEEPS ITS SLOT — on the board and in the list (17.08.) ──
   * There used to be a «Raus»-Abschnitt underneath everything else, and the cards/rows jumped into
   * it the moment a Trupp came out. That cost the one thing this surface is for: a slot that means
   * something. «Trupp 2 steht oben rechts» stopped being true exactly when the Trupp came back,
   * and everything below it moved up — on the surface whose whole promise is that a card does not
   * move out from under the hand (see the freeze note above).
   * ⚠️ It went for the CARD GRID first and for the narrow list a day later, on the same reasoning:
   * the split saves rows, and a row that has moved is worse than a row too many.
   * What the state IS stays readable on the card itself (banner, colour, «Draussen»), the header's
   * sort answers «zeig mir die brauchbaren zuerst», and a Trupp nobody needs on the board any more
   * can be deleted — the Rapport keeps it either way (types · Trupp.removedAt). */
  const board = sortTrupps(trupps)
  /* ── Two sections, one board (mock «Sektionen», decided 03.09.) ────────────────────────────
   * Atemschutz on top with today's cards, entirely untouched, then a ruled «Weitere Trupps» with
   * the plain work squads as single rows. The split is the whole point of this variant: the PA
   * safety signal must not be diluted by rows that carry no clock, and the eye has to know at a
   * glance which half it is in. Sorting happens ONCE, over the whole board (`sortTrupps` above),
   * and the split preserves that order inside each section — so «Dringlichkeit» and the hand-set
   * order mean the same thing they always did, just within their own half. */
  const paBoard = board.filter(isAtemschutzTrupp)
  const plainBoard = board.filter((t) => !isAtemschutzTrupp(t))
  /* Sections appear the moment the board holds a Trupp without Atemschutz, and not before: an
   * Einsatz where everybody went in under PA — every Einsatz recorded until today — gets exactly
   * the board it had, with no headings, no counts and no empty second half to read past. */
  const sectioned = plainBoard.length > 0

  /* ── The PHONE board of the full app (24.09.2026, Übung Allschwilerstrasse 100) ─────────────────
   * ⚠️ Reverses, for the phone only, two earlier decisions: «a Trupp keeps its slot» (17.08.) and
   * «wie gesetzt» as the order that never moves a row (see `baseSort`). On 23.09. one Überwacher
   * ran five Trupps from a phone, the hand-set order hid the overdue ones between the others, and
   * about ten of seventeen contacts came AFTER the alarm. So the phone board is arranged by what
   * the operator has to do next, and the order menu is not offered there:
   *   · Drin — every Atemschutz-Trupp inside, the one due next on top (tier, then how far past its
   *     line, then the longest-running — the same ranking «Dringlichkeit» uses)
   *   · the Sicherungstrupp — standing ready (Auftrag «Sichern»), or a placeholder asking for one
   *     while anybody is inside
   *   · Bereit — registered, not yet in · Draussen — came out
   * The tablet grid, and the handed-over Tafel (one Trupp per screen), keep their arrangement
   * (their CARD is this board's opened row since 29.09.2026 — see TruppCard). The 2 s
   * freeze still holds the order under the finger (`freezeOrder` captures THIS arrangement). */
  const phoneMode = compact && !lite
  const inFieldNow = (t: Trupp) => t.status === 'aktiv' || t.status === 'rueckzug'
  const byHand = (list: Trupp[]) => [...list].sort((a, b) => orderKey(a) - orderKey(b))
  const holdFrozen = (list: Trupp[]) => {
    if (!frozenIds) return list
    const rank = new Map(frozenIds.map((id, i) => [id, i]))
    return [...list].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  const phoneIn = holdFrozen([...paBoard.filter(inFieldNow)].sort((a, b) =>
    (sevOf(b.id) - sevOf(a.id)) || (urgency(b) - urgency(a)) || (runningSec(b) - runningSec(a)) || (orderKey(a) - orderKey(b))))
  const phoneSafety = byHand(paBoard.filter((t) => t.status === 'angemeldet' && t.auftrag === 'sichern'))
  const phoneReady = byHand(paBoard.filter((t) => t.status === 'angemeldet' && t.auftrag !== 'sichern'))
  const phoneOut = byHand(paBoard.filter((t) => t.status === 'raus'))
  /* The Atemschutznotfall (F1, 08.10.2026): who is in one, and who can go in for them — the one
   * model of a READY Sicherungstrupp the board has (lib/atemschutz · safetyReady), in hand order.
   * A closed Einsatz shows none: its Tafel alarms nothing (R3). */
  const notfallTrupps = frozenAt != null ? [] : byHand(paBoard.filter(truppInNotfall))
  const notfallReady = byHand(safetyReady(paBoard))
  const notfallSafetyInside = safetyInside(paBoard)

  // Called from the card's action handlers — i.e. after render, so it simply closes over the
  // arrangement the operator is currently looking at. (A ref would have to be written during
  // render, which is exactly what react-hooks/refs warns about.)
  const freezeOrder = () => {
    setFrozenIds((phoneMode ? [...phoneIn, ...phoneSafety, ...phoneReady, ...phoneOut, ...plainBoard] : board).map((t) => t.id))
  }

  /* ── A Kontakt another device confirmed a moment ago ASKS first (24.09.2026, D1 ⑧a) ──────────
   * On 23.09. the iPad and the phone both answered T1 and the record got two contacts 21 s apart.
   * The synced log says when the last confirmation was and whether this device wrote it
   * (lib/contactEcho); a foreign one under 60 s old turns the tap into «Kontakt wurde vor 21 s
   * schon bestätigt (anderes Gerät). Nochmals / OK». «OK» — and every way of dismissing the
   * question — writes nothing. A second tap on the SAME device is unchanged (no question, the
   * 2 s order freeze).
   * ⚠️ On EVERY board — tablet grid, phone board and the handed-over Tafel (25.09.2026): it guards
   * the ACT, not a layout, and the 23.09. case was an iPad and a phone. «OK» is the default
   * (filled, focused — `ConfirmSpec · safeAnswer`): a reflex tap or an Enter writes nothing. */
  const contactTap = async (id: string): Promise<boolean> => {
    const t = trupps.find((x) => x.id === id)
    const ago = t ? foreignContactAgo(t, serverNow()) : null
    if (t && ago != null) {
      /* Recognition over reading (owner review 26.09.2026): a TITLE that states the fact, one
         short line for which crew and when, the verbs on the buttons. */
      const again = await confirmDialog({
        title: az.contactEchoTitle,
        message: fillTemplate(az.contactEchoMsg, { name: typeof t.no === 'number' ? fillTemplate(az.contactEchoWho, { n: t.no }) : t.name, s: ago }),
        confirmLabel: az.contactEchoAgain,
        cancelLabel: az.contactEchoOk,
        safeAnswer: 'cancel',
      })
      if (!again) return false
    }
    freezeOrder()
    recordContact(id)
    return true
  }

  // roster of everyone already entered on any Trupp (GF + AdF) — offered as quick-select chips
  // in the form so names don't have to be retyped each time.
  const roster = useMemo(() => {
    const seen = new Set<string>()
    for (const t of trupps) {
      for (const n of [t.name, ...(t.members ?? [])]) {
        const v = n?.trim()
        if (v) seen.add(v)
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b, 'de'))
  }, [trupps])

  // present crew (attendance) — offered first in the picker; ids already on another active
  // Trupp get a duplicate-warning badge but stay selectable (real incidents need corrections)
  const presentIds = useMemo(
    () => new Set(Object.entries(attendance).filter(([, a]) => a.status === 'present').map(([id]) => id)),
    [attendance],
  )
  // …and which of them are still at the Magazin. Somebody at the Magazin usually cannot go under
  // PA at all, so the picker says so and sinks them below the crew on scene (see TruppTeam).
  const stationIds = useMemo(
    () => new Set(Object.entries(attendance)
      .filter(([, a]) => isPresent(a) && ortOf(a) === 'station')
      .map(([id]) => id)),
    [attendance],
  )

  // Who is already spoken for: the Bemerkung on their Anwesenheits-Zeile is where a job ends up
  // («Einsatzleiter», «Fahrer TLF» — lib/roleAssignment). Putting the Einsatzleiter under PA is
  // allowed and sometimes right; the picker only says it out loud before it happens.
  const rolesById = useMemo(
    () => new Map(
      Object.entries(attendance)
        .map(([id, a]) => [id, (a.note ?? '').trim()] as const)
        .filter(([, note]) => note.length > 0),
    ),
    [attendance],
  )

  // unlock the alarm tone + ask for OS-notification permission on this gesture, so a later
  // überfällig alert can both sound and reach the tray when the app is backgrounded.
  // ⚠️ NOT on the public demo (06.09.): a visitor poking at Musterdorf gets no browser
  // permission dialog thrown at their first taps — it reads as data grabbing on a demo site.
  // The audio unlock stays (idempotent, no permission involved) — moot on the demo itself,
  // where useAtemschutzAlarm suppresses the audible alarm anyway.
  const openForm = (mode: FormMode, trupp?: Trupp, focus?: 'auftrag', adoptMarkerId?: string, presetAuftrag?: TruppAuftrag) => {
    unlockAlarm(); if (!isDemoMode()) void ensureNotifyPermission(); setForm({ mode, trupp, focus, adoptMarkerId, presetAuftrag })
  }
  // «Neuer Trupp» from a loose marker/chip — opened once per request nonce (see lastOpenedCreateNonce)
  useEffect(() => {
    if (!createRequest || !canEdit || createRequest.nonce === lastOpenedCreateNonce) return
    lastOpenedCreateNonce = createRequest.nonce
    openForm('create', undefined, undefined, createRequest.adoptMarkerId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequest?.nonce])


  /**
   * The FIRST tap ANYWHERE on this board also counts as the audio unlock (field feedback,
   * 02.09.: «Ich erhalte keinen Ton … auf dem PC oder Mobile» over a bell visibly showing «nicht
   * freigegeben»). Browsers only release Web Audio inside a real gesture, and until now the only
   * gesture THIS surface answered was opening the Trupp-Formular — `App.selectIncident` covers
   * the normal «open an Einsatz» tap for the full app, but an Atemschutz-Link session's own
   * first «gesture» is the token exchange during boot, which runs outside any click and leaves
   * the AudioContext quietly `suspended`. Anyone who only watched the board, or only ever
   * pressed Kontakt/Druck, could sit through an entire überfällig alarm in total silence.
   * Idempotent (`primeAudio`/`ensureNotifyPermission` both are) and fires once per mount.
   */
  const primedGesture = useRef(false)
  const primeOnFirstTap = () => {
    if (primedGesture.current) return
    primedGesture.current = true
    // demo: audio only — see openForm for why the permission ask stays off the demo's first taps
    unlockAlarm(); if (!isDemoMode()) void ensureNotifyPermission()
  }

  /**
   * One Leitung, one Trupp. Typing a number that someone else is already on used to save silently
   * and leave two Trupps claiming one hose — the tag then picked one of them and the Überwacher had
   * no way of knowing. Name both and let the operator decide: a takeover IS the normal case
   * (Ablösung), it just has to be said out loud. Cancel returns to the form with everything still
   * typed. ⚠️ ONE helper for every save that can set a Leitung — the form's (`submitForm`) and the
   * Auftrag sheet's (`saveQuick`, 26.09.2026) — so no door around the question exists.
   * `true` when the write may go ahead (the previous Trupp has let go by then) — a plain `true`
   * with no clash, so a save that asks nothing still writes in the same tick it was tapped (the
   * board's tests, and the create form's kept draft, count on that); a Promise only while asking.
   */
  const confirmLineTake = (f: TruppFields, ownId?: string): true | Promise<boolean> => {
    const clash = f.lineNo == null ? undefined
      : trupps.find((t) => t.id !== ownId && t.status !== 'raus' && truppLineNo(t) === f.lineNo)
    if (!clash) return true
    return confirmDialog({
      title: fillTemplate(az.lineTakeTitle, { n: String(f.lineNo) }),
      message: fillTemplate(az.lineTakeMsg, { n: String(f.lineNo), from: clash.name, to: f.name }),
      confirmLabel: az.lineTakeConfirm,
      cancelLabel: appConfig.copy.cancel,
    }).then((ok) => {
      if (!ok) return false
      unlinkTruppLine(clash.id) // the previous Trupp lets go — its Leitung is now this one's
      return true
    })
  }
  /** A mini sheet's save (components/TruppSheets): the same question in front of a Leitung, then
   *  the ONE write path. `true` = written, the sheet closes; `false` = the operator said no and the
   *  sheet stays open with everything still picked. */
  const saveQuick = async (id: string, f: TruppFields): Promise<boolean> => {
    const take = confirmLineTake(f, id)
    if (take !== true && !(await take)) return false
    editTrupp(id, f)
    return true
  }

  /** Resolves `true` once the Trupp is written — the form drops its kept draft only then, so every
   *  «Zurück» / «Abbrechen» on a question in front of the save returns to a form still filled in. */
  const submitForm = async (f0: TruppFields, standby = false, extra?: TruppSubmitExtra): Promise<boolean> => {
    if (!form) return false
    let f = f0
    /* ⚠️ An EDIT is a patch (staging walk-through 25.09.2026: phone B's older open form saved its
     * stale Auftrag over phone A's change). Only the groups this form touched are written, onto
     * the Trupp as it stands NOW; and a touched group that another device changed since the form
     * opened is said in one line first, with «Zurück zum Formular» as the safe, focused answer. */
    if (form.mode === 'edit' && form.trupp && extra) {
      const current = trupps.find((t) => t.id === form.trupp!.id) ?? form.trupp
      const changedElsewhere = truppFieldGroupsChanged(truppFieldsOf(form.trupp), truppFieldsOf(current))
      const conflicts = extra.touched.filter((g) => changedElsewhere.includes(g))
      if (conflicts.length) {
        const ok = await confirmDialog({
          message: conflicts.length === 1
            ? fillTemplate(az.editConflictOne, { field: az.editFieldLabels[conflicts[0]], now: fieldNow(current, conflicts[0]) })
            : fillTemplate(az.editConflictMany, { fields: conflicts.map((g) => az.editFieldLabels[g]).join(', ') }),
          confirmLabel: az.editConflictOverwrite,
          cancelLabel: az.editConflictBack,
          safeAnswer: 'cancel',
        })
        if (!ok) return false
      }
      f = truppEditPatch(current, f0, extra.touched)
    }
    const take = confirmLineTake(f, form.trupp?.id)
    if (take !== true && !(await take)) return false
    // every question is answered — NOW the Gäste typed into the form reach the Anwesenheit
    // (TruppForm · fileGuests), and only if the crew is part of what this save writes
    const fileCrew = () => {
      if (!extra || (form.mode === 'edit' && !extra.touched.includes('crew'))) return
      f = { ...f, ...extra.fileGuests() }
    }
    if (form.mode === 'create') {
      fileCrew()
      const id = newId('tr')
      createTrupp({
        id,
        // ⚠️ WRITTEN ONLY for the new kind. Absent means «unter Atemschutz» (types · TruppKind),
        // and stamping the default onto every new Trupp would make the blob claim a decision
        // nobody made — and make every pre-03.09. record look different from a fresh one.
        ...(f.kind === 'einfach' ? { kind: f.kind } : {}),
        name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNo: f.lineNo, funkkanal: f.funkkanal,
        leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds, equipment: f.equipment,
        entryPressureBar: f.pressure, entryTime: '', lastContactTime: '', lowestBar: f.pressure,
        status: 'angemeldet',
        // an Eingangsdruck set on purpose opens the log as a MEASURED Anmeldung, so the first
        // Druckmeldung never «corrects» it (lib/atemschutz · entryPressureConfirmed); the default
        // one leaves the log to createTrupp, as ever
        readings: f.pressureMeasured && f.kind !== 'einfach'
          ? [{ t: serverNowIso(), bar: f.pressure, kind: 'registered', measured: true }] : [],
      })
      // The phone focus board («ein Trupp, ein Bildschirm») otherwise left the PREVIOUS Trupp
      // selected — a new Trupp existed, but the operator was still looking at somebody else's
      // card. `picked` is declared further down; this is a closure reference, resolved by the
      // time submitForm actually runs (it is only ever called from an event handler, never
      // during this render). Harmless on the tablet grid too — nothing reads `picked` there.
      setPicked(id)
      // opened from a loose marker/chip: the record joins the picture in the same go
      if (form.adoptMarkerId) adoptMarker(id, form.adoptMarkerId)
    } else if (form.mode === 'edit' && form.trupp) {
      /* Turning the Überwachung OFF on a crew that is inside is the one change in this form that
       * takes a safety watch away, so it is said out loud first. Only while the Trupp is actually
       * in the field: correcting an Art on a Trupp that has come out, or one still at the door,
       * costs nobody anything and needs no dialog. Cancel returns to the form with the tile still
       * on «ohne Atemschutz», so the operator can put it back rather than start over. */
      if (f.kind === 'einfach' && truppInField(form.trupp)) {
        const ok = await confirmDialog({
          title: fillTemplate(az.kindOffTitle, { name: form.trupp.name }),
          message: az.kindOffMsg,
          confirmLabel: az.kindOffConfirm,
          cancelLabel: appConfig.copy.cancel,
          danger: true,
        })
        if (!ok) return false
      }
      fileCrew()
      editTrupp(form.trupp.id, f)
    } else if (form.mode === 'redeploy' && form.trupp) {
      fileCrew()
      reactivateTrupp(form.trupp.id, f, standby)
    }
    setForm(null)
    return true
  }

  /* Compact rows vs cards — a NARROW-SCREEN layout, nothing else (decided 16.08.).
   *
   * A card is ~641px tall against a 575px scroll port on a phone, so a single Trupp's clock and
   * its Rückzug/Raus row can never be on screen at once — that is what the rows exist for. A row
   * opens its own card on tap, so nothing is unreachable, it is one tap deeper.
   *
   * A Trupp-count trigger was tried and dropped: it flipped a 1920px screen to rows at 4 Trupps
   * where five cards fitted comfortably. The board CAN still under-report on a wide screen (6
   * Trupps, 3 columns, no scroll cue) — that is a real and separate finding, and the fix for it
   * belongs on the card grid (a total in the header, a fade at the edge), not in this switch. */
  const [openRow, setOpenRow] = useState<string | null>(null)

  /* «Ein Trupp, ein Bildschirm» — the handed-over board on a PHONE (decided 02.09.): a strip with
   * one tab per Trupp and its live clock on top, and ONE Trupp filling the rest of the screen —
   * the clock as large as the screen allows, a Kontakt the thumb cannot miss, every other clock
   * still in view in the strip. A tablet keeps the card grid. An überfällig Trupp pulls itself
   * forward the moment it becomes one; a tap on a tab is a deliberate choice that stands until
   * the next alarm or an external jump (`focus`). */
  const focusMode = !!lite && compact
  // the pair's word IS its promise — the hold-tooltip reads it off `aria-label` (lib/holdTooltip)
  const undoWord = undoLabel ? fillTemplate(appConfig.copy.undoNamed, { action: undoLabel }) : appConfig.copy.undo
  const redoWord = redoLabel ? fillTemplate(appConfig.copy.redoNamed, { action: redoLabel }) : appConfig.copy.redo
  const [picked, setPicked] = useState<string | null>(null)
  /* The handed-over phone board OPENS on the crew that needs the Überwacher first — the most
   * urgent one inside (the «Drin» order: tier, how far past its line, longest running) — never
   * simply the first Trupp of the board (staging walk-through r2, N18: it opened on a Trupp that
   * was out, its biggest control «Wieder in den Einsatz», while another crew was inside). With
   * nobody inside it is the board's first Trupp, as before. */
  const firstFocus = focusMode
    ? [...board.filter((t) => isAtemschutzTrupp(t) && inFieldNow(t))].sort((a, b) =>
      (sevOf(b.id) - sevOf(a.id)) || (urgency(b) - urgency(a)) || (runningSec(b) - runningSec(a)))[0] ?? board[0]
    : undefined
  const focusId = focusMode
    ? (picked && board.some((t) => t.id === picked) ? picked : firstFocus?.id ?? null)
    : null
  const lastOverdue = useRef<string | null>(null)
  const mostOverdueId = mostOverdue?.id ?? null
  useEffect(() => {
    if (mostOverdueId && mostOverdueId !== lastOverdue.current) setPicked(mostOverdueId)
    lastOverdue.current = mostOverdueId
  }, [mostOverdueId])
  useEffect(() => { if (activeFocus?.id) setPicked(activeFocus.id) }, [activeFocus?.id, activeFocus?.nonce])

  /* Park an opened card at the top of the scroll port — and buy exactly enough room to do it.
   *
   * ⚠️ The first version padded the list with a flat 62dvh whenever a card was open. That let the
   * operator scroll clean past the card into an empty screen: the board looked as if every Trupp
   * had vanished. The room needed is knowable — port height minus card height — so it is measured
   * instead of guessed, and a card taller than the port gets none at all.
   *
   * This lives here rather than in TruppCard because the spacer has to exist BEFORE the scroll:
   * child effects run before the parent's, so a card parking itself would run out of list to
   * scroll against. */
  const bodyRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /* The Notfall banners' sticky stack (AtemschutzNotfall · NotfallBanner) covers the top of the
   * port, so «the top of the port» is BELOW it while one runs: its height (+ the air under it) is
   * `--nf-h` on the port — the port's scroll padding for every scroll-into-view — and the parking
   * scroll below reads it too. Before (owner screenshot 10.10.2026) the opened card parked under
   * the banner with its name chips cut off. Measured, because the banner's height is its words. */
  const nfStackRef = useRef<HTMLDivElement>(null)
  const hasNotfall = notfallTrupps.length > 0
  useLayoutEffect(() => {
    const port = bodyRef.current, el = nfStackRef.current
    if (!port) return
    if (!el) { port.style.removeProperty('--nf-h'); return }
    const set = () => port.style.setProperty('--nf-h', `${nfInset(el)}px`)
    set()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(set)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [hasNotfall])
  const openRowStatus = trupps.find((t) => t.id === openRow)?.status
  // pointing at the card that is already open («Zum Trupp» twice, an alarm on it) parks it again
  const openFocusNonce = activeFocus && activeFocus.id === openRow ? activeFocus.nonce : undefined
  useEffect(() => {
    const list = listRef.current, port = bodyRef.current
    if (!list || !port) return
    for (const el of list.querySelectorAll('[data-az-fab-foot]')) el.removeAttribute('data-az-fab-foot')
    if (!compact || !openRow) { list.style.removeProperty('--az-open-pad'); return }
    const card = list.querySelector<HTMLElement>('[data-az-open]')
    if (!card) return
    // Parked at the top of the port, a card about a port tall ends in the FAB's corner, and the
    // circle sat on its Verlauf row's chevron (field checks 24.09.2026). That ROW — and only it —
    // then keeps the FAB's column free (Atemschutz.module.css · data-az-fab-foot), for exactly as
    // long as it really stands under the circle: measured where it IS, never assumed. So it is
    // re-measured on everything that moves one against the other — the card changing height (the
    // Verlauf opening, a crew row, a warning; that also resizes the spacer), the port changing
    // height or scrolling (the parking scroll itself is smooth, so its end arrives as scroll
    // events), and the window or visual viewport resizing (the FAB is `position: fixed`). Scroll
    // and resize are folded into one measurement per frame.
    const measure = () => {
      list.style.setProperty('--az-open-pad', `${Math.max(0, port.clientHeight - nfInset(nfStackRef.current) - card.offsetHeight - 16)}px`)
      const row = card.querySelector<HTMLElement>('[data-az-foot]')
      const fab = document.querySelector('.fab-entry')?.getBoundingClientRect()
      if (!row) return
      const r = row.getBoundingClientRect()
      row.toggleAttribute('data-az-fab-foot', !!fab && r.top < fab.bottom && r.bottom > fab.top)
    }
    let frame = 0
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    measure()
    // …parked under the Notfall banners while one runs, never beneath them (`--nf-h` above)
    const top = port.scrollTop + card.getBoundingClientRect().top - port.getBoundingClientRect().top - nfInset(nfStackRef.current)
    if (typeof port.scrollTo === 'function') port.scrollTo({ top, behavior: 'smooth' })
    else port.scrollTop = top
    port.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    ro?.observe(card)
    ro?.observe(port)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      port.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      ro?.disconnect()
    }
  }, [compact, openRow, openRowStatus, openFocusNonce])

  /* WHICH cards the current pointer marks — and which one the board scrolls to.
   *
   * ⚠️ The header badge counts EVERY Trupp in alarm, so pressing it rings every one of them
   * (05.09.): «2 Alarme» that ringed a single card said the opposite of the number on it, and
   * the answer to «welche denn?» was still a scroll. The scroll stays on the one card the badge
   * ranks first (`activeFocus.id`, = the TopBar chip's pick) — two smooth scrolls fired at once
   * fight each other and land wherever the last one happened to render. */
  const markAll = !!(selfFocus && activeFocus === selfFocus && selfFocus.markAll)
  // Which (Trupp, nonce) pairs have already COMPLETED their ring. Expand/collapse swaps
  // TruppRow ⇄ TruppCard under the same key, i.e. a REMOUNT — without this memory the fresh
  // mount replayed the ring + scroll on every collapse, long after the gesture that pointed
  // there (Feldtest 08.09., «Trupp Schmid blinkt nach collapse»). A ref, not state: recording a
  // finished flash must not itself re-render the board. ⚠️ It is therefore read only in the
  // card's flash EFFECT (`flashSeen` / `onFlashed`), never here while rendering — `cards()` runs
  // during render, and a ref read there is what react-hooks/refs counts once per call site.
  const flashSeen = useRef(new Map<string, number>())
  const focusNonceOf = (id: string) =>
    activeFocus && (activeFocus.id === id || (markAll && sevOf(id) >= 2)) ? activeFocus.nonce : undefined

  const cards = (list: Trupp[]) => list.map((t) => {
    const nonce = focusNonceOf(t.id)
    const seen = nonce == null ? undefined : () => flashSeen.current.get(t.id) === nonce
    const flashed = nonce == null ? undefined : () => flashSeen.current.set(t.id, nonce)
    return (
    compact && !focusMode && openRow !== t.id ? (
      <TruppRow
        key={t.id} t={t} live={live.get(t.id)!} alarm={alarms.get(t.id)!} now={now} color={truppColors[t.id]} canEdit={canEdit}
        focusNonce={nonce} focusScroll={activeFocus?.id === t.id} flashSeen={seen} onFlashed={flashed}
        onContact={(id) => { void contactTap(id) }}
        onPressure={(id) => setPressureAsk({ id, kind: 'pressure' })}
        onOpen={() => setOpenRow(t.id)}
        lite={!!lite}
      />
    ) : (
    // Every mutation that can move a card between slots freezes the arrangement first (FREEZE_MS).
    //
    // ⚠️ `onMove` is withheld in row mode. Seven controls do not fit the banner at 375px —
    // `.cardActs` wraps, and the wrapped «Zur Übersicht» landed directly under «Entfernen» at the
    // same x, recreating the exact open-then-delete collision that moving it was meant to prevent.
    // The ‹ › pair is the right one to drop: in row mode the card is a detail view, not a board
    // slot (and those arrows are separately known to move the wrong card).
    <TruppCard
      key={t.id} t={t} live={live.get(t.id)!} alarm={alarms.get(t.id)!} now={now} color={truppColors[t.id]} canEdit={canEdit}
      intervalMin={intervalMin} frozen={frozenAt != null}
      // the phone's opened row is PARKED by the board (the effect around `--az-open-pad`), below
      // the Notfall banners — a centring scroll of its own fought that and won (10.10.2026)
      focusNonce={nonce} focusScroll={activeFocus?.id === t.id && !(compact && !focusMode)} flashSeen={seen} onFlashed={flashed}
      onContact={(id) => { void contactTap(id) }}
      onStatus={(id, s) => { freezeOrder(); setTruppStatus(id, s) }}
      onStandDown={(id) => { freezeOrder(); setTruppStatus(id, 'raus', undefined, { undoToast: true }) }}
      // the Restdruck question at «Raus melden» — every width (24.09.2026, see PressureSheet)
      onAskExit={(id) => setPressureAsk({ id, kind: 'exit' })}
      // …and the card's Druck is the same picker, on EVERY board since 29.09.2026 (the tablet's
      // ± stepper went with the tablet card — see TruppCard)
      onAskPressure={(id) => setPressureAsk({ id, kind: 'pressure' })}
      // the phone board's section heads say Drin / Bereit / Draussen; everywhere else the card does
      headed={phoneMode}
      onEdit={(focus) => openForm('edit', t, focus)} onReenter={() => openForm('redeploy', t)}
      onQuick={canEdit ? (kind) => setQuick({ id: t.id, kind }) : undefined}
      onDelete={deleteTrupp} onPlace={handlePlace} onShowPlan={focusTruppOnPlan}
      // ⚠️ never on a work squad. The arrows move one GLOBAL order while the board renders two
      // filtered sections, so a step can swap a Trupp past the section boundary and look like it
      // did nothing — and these Trupps never had them (they lived on `PlainTruppRow`, which had
      // no such control at all). See the note on `.cardActs`' old ‹ › pair above.
      onMove={order === 'manuell' && !compact && isAtemschutzTrupp(t) ? onMove : undefined}
      onShowLine={showTruppLine} hasLine={truppsWithLine.has(t.id)} drawnLineNo={lineNoOf?.get(t.id)} dockedAt={dockedAt?.get(t.id)}
      // «Tafel pur»: everything that points at the Karte or a drawn Leitung is unreachable from
      // this session, and a control that will fail is worse than no control (see `lite` above).
      lite={!!lite}
      onCollapse={compact && !focusMode ? () => setOpenRow(null) : undefined}
      // the Atemschutznotfall's two held doors (F1) — a closed Einsatz raises and ends nothing
      onNotfall={canEdit && triggerNotfall && frozenAt == null ? () => { freezeOrder(); triggerNotfall(t.id) } : undefined}
      onNotfallEnd={canEdit && endNotfall && frozenAt == null ? () => { freezeOrder(); endNotfall(t.id) } : undefined}
    />
    )
  )})

  /* ── The due clocks stay in view while a Trupp is being registered (24.09.2026, D1 ⑥) ──────────
   * On 23.09. T4 and T5 were registered on a full-screen form while T3, T1 and T2 went überfällig
   * one after the other behind it. On the phone board the form is a bottom sheet now, and ABOVE
   * it stand the Trupps that are due or overdue — at most two, the most urgent first (the «Drin»
   * order), each with its live clock and a live «Kontakt» that confirms without leaving the form.
   * Nothing due ⇒ nothing pinned. After a tap the pinned set holds for the same 2 s the board's
   * order does: the tapped row drops out of «due» the instant its clock resets, and the row below
   * would otherwise slide up under the finger that is about to tap again. */
  // …and the row just confirmed shows «✓ Bestätigt», disabled, for that hold (review 25.09.2026):
  // it stays under the finger, and a second tap on it was a second Kontakt from the same device
  const [pinHeld, setPinHeld] = useState<{ ids: string[]; done: string[] } | null>(null)
  useEffect(() => {
    if (!pinHeld) return
    const h = window.setTimeout(() => setPinHeld(null), FREEZE_MS)
    return () => window.clearTimeout(h)
  }, [pinHeld])
  const pinnedDue: Trupp[] = !phoneMode || !form ? []
    : pinHeld ? pinHeld.ids.map((id) => trupps.find((t) => t.id === id)).filter((t): t is Trupp => !!t && inFieldNow(t))
    : phoneIn.filter((t) => isAtemschutzTrupp(t) && sevOf(t.id) >= 1).slice(0, 2)
  const pinnedRows = pinnedDue.length > 0 ? (
    <div className={s.formPinned} role="region" aria-label={az.pinnedLabel} data-swipe-ignore="">
      {pinnedDue.map((t) => (
        <PinnedRow key={t.id} t={t} live={live.get(t.id)!} alarm={alarms.get(t.id)!} color={truppColors[t.id]}
          confirmed={!!pinHeld?.done.includes(t.id)}
          onContact={(id) => {
            // marked at once (a double tap lands in the same frame), taken back if the double-contact
            // question was answered «OK» and nothing was written
            setPinHeld({ ids: pinnedDue.map((x) => x.id), done: [...(pinHeld?.done ?? []), id] })
            void contactTap(id).then((ok) => {
              if (!ok) setPinHeld((h) => (h ? { ...h, done: h.done.filter((x) => x !== id) } : h))
            })
          }} />
      ))}
    </div>
  ) : null

  /* «Bestimmen» at the SICHERUNGSTRUPP head (24.09.2026, D1 ⑦; a section head like DRIN /
   * DRAUSSEN since 26.09.2026, phone card slim-down — the dashed «Kein Sicherungstrupp · Ein Trupp
   * ist drin» box said in two sentences what an empty section under its own head says by itself):
   * take one of the Trupps standing ready (its Auftrag becomes «Sichern» — an ordinary edit: its
   * own Verlauf row, its own ↶), or register a new one with «Sichern» preset. With nobody ready it
   * is the form directly. */
  const safetyPickNew = () => openForm('create', undefined, undefined, undefined, 'sichern')
  const safetyPickButton = (
    <button type="button" className={s.sectAct} onClick={phoneReady.length ? undefined : safetyPickNew}>
      {az.safetyPick}
    </button>
  )

  // What the bell says of itself. The order matters: «nicht freigegeben» only applies while the
  // alarm claims to be on — a muted bell promises no tone anyway, so two warnings about the same
  // silence would be one too many (useAtemschutzMute already folds that into `audioBlocked`).
  // ⚠️ «sonst meldet nur die Benachrichtigung» (alarmBlocked) is a PROMISE this browser must be
  // able to keep — a plain Safari tab on iOS never gets a `Notification` global at all (field
  // feedback, 02.09.: «Ich erhalte keinen Ton oder Vibration … »), so telling that operator a
  // fallback exists is worse than saying nothing: it reads as «something will still alert me»
  // when NOTHING will until the tone itself is unlocked. `notificationsSupported()` is a static
  // capability check (permission aside), so this never flickers with permission state.
  // ⚠️ Appended, not swapped in, on the DEMO only: the demo mutes tone + OS notification
  // everywhere (useAtemschutzAlarm's `demo` gate — its incident is frozen in a worked state, so
  // a real alarm here would be a false one wearing the app's own voice), and a tester who
  // presses «Kontakt» and hears nothing has no way to tell «broken» from «deliberately quiet»
  // without being told (field question, 02.09.: «Wie sollte dieser Alarm erfolgen?»). The
  // button's own honest state (an / stumm / nicht freigegeben) still reads first.
  const bellLabel = (muted ? az.alarmMuted
    : audioBlocked ? (notificationsSupported() ? az.alarmBlocked : az.alarmBlockedNoFallback)
    : az.alarmArmed) + (isDemoMode() ? ` · ${az.alarmDemoNote}` : '')

  // What the QR beside the bell says of itself — the same rule as the bell: the state that is
  // TRUE now, not what the press would do.
  const shareLabel = shareLinkActive ? az.shareLinkOn : az.shareLink

  // ⚠️ ONE bell, THREE honest states — and every one of them says what is TRUE now, not what the
  // press would do (see `bellLabel` above). Rendered as ONE element so the header (every board)
  // and the lite/phone bottom rail (mock 03 · focusMode) share the exact same button rather than
  // two copies that could drift.
  const bellButton = (
    <button
      className={cx(s.muteBtn, muted && s.muteOn, audioBlocked && s.muteBlocked)}
      data-fold={HEAD_FOLD.bell}
      onClick={audioBlocked ? onUnlockAudio : onToggleMuted}
      aria-pressed={muted}
      aria-label={bellLabel} title={bellLabel}
    >
      <Icon id={muted ? 'bell-off' : 'bell'} />
      {/* the WORD wherever the head has room (22.09.2026; measured since 28.09.2026 — the head's
          ladder, `HEAD_FOLD`): three unlabelled squares beside «Trupp anmelden» were a guess for
          anybody who had not held them. Where the row runs out the bell gives it up last of the
          tiles — it is its honest state — and the hold-tooltip is the way of asking. The focus
          board keeps the square: its row belongs to the Einsatz name. */}
      {!focusMode && <span className="fold-long">{muted ? az.alarmMutedWord : audioBlocked ? az.alarmBlockedWord : az.alarmWord}</span>}
    </button>
  )

  /* ── The board's own sync/clock line, under the subtitle ──────────────────────────────────
   * Same vocabulary as the incident switcher (its copy, its chip classes — learned once):
   * quiet while the record is safe (tick / amber dot + «Gespeichert um HH:MM» in the
   * subtitle's voice, so it never competes with a Trupp card), a LOUD chip for
   * offline/error/storage — the case this line exists for — dated with the last synced
   * Stand, and an independent chip when this device's clock is minutes off (every contact
   * clock here is device-local time). */
  const cpSync = appConfig.copy.incidentSwitcher
  const savedAtText = lastSyncedAt != null
    ? fillTemplate(cpSync.savedAt, { t: formatTime(new Date(lastSyncedAt)) })
    : cpSync.saved
  const syncShort: Record<'offline' | 'error' | 'storage', string> = {
    offline: cpSync.offlineShort, error: cpSync.errorShort, storage: cpSync.storageShort,
  }
  const syncLong: Record<'offline' | 'error' | 'storage', string> = {
    offline: cpSync.badgeOffline, error: cpSync.badgeError, storage: cpSync.badgeStorage,
  }
  const skewMin = clockSkewMs != null ? Math.round(clockSkewMs / 60_000) : null
  const skewLoud = skewMin != null && Math.abs(skewMin) > CLOCK_SKEW_WARN_MIN
  /* ⚠️ A <span>, not a <div> (09.09.): on the phone focus board this whole line rides INSIDE the
   * title's popover trigger, and a <button> may only contain phrasing content. `.az-syncline` is
   * `display: flex`, which a span wears exactly as a div does — the tablet header is unchanged. */
  const syncLine = (syncStatus || skewLoud) && (
    <span className="az-syncline" data-fit-check>
      {syncStatus === 'synced' || syncStatus === 'pending' ? (
        <span className={cx('az-sync-quiet', syncStatus === 'pending' && 'az-sync-pending')}
          data-fold={focusMode ? undefined : `${HEAD_FOLD.saved} ${HEAD_FOLD.savedMark}`}
          title={syncStatus === 'pending' ? cpSync.badgePending : savedAtText}>
          {syncStatus === 'synced' ? <Icon id="check" /> : <span className="ip-status-dot" />}
          {/* ⚠️ On the phone focus board the QUIET state is the mark ALONE — no «18:05» beside
              it (09.09., maintainer review of the one-row head). It shrank to the bare time on
              03.09. because there was no room for the sentence; on a one-row head there is no
              room for the time either, and a naked clock in a header is the one thing on this
              screen that could be read as an operational time rather than a save stamp.
              ⚠️ The Stand is NOT gone: it stands in full — «Gespeichert um 18:05» — behind the
              Einsatz title beside it (`headDetail`), and in `title` here. The 01.09. safety rule
              is that this surface says ITSELF whether what it shows is saved; the mark still
              says it, at a glance, and so do the LOUD states below, which keep printing their
              Stand inline because they are the states that rule exists for. */}
          {/* …and on the full board the word loses its time FIRST when the head runs out of room
              (owner, staging 26.09.2026: «Gespeichert um 14:49» was cut to «Gespeichert um …» —
              the time lost anyway, the sentence broken). Measured since 28.09.2026: the first rung
              of the head's ladder (`HEAD_FOLD.saved`); the time stands in `title` either way. */}
          {!focusMode && (
            <span>
              <span className="fold-long">{savedAtText}</span>
              <span className="fold-short">{cpSync.saved}</span>
            </span>
          )}
        </span>
      ) : syncStatus ? (
        <span className={cx('ip-offline-chip', syncStatus !== 'offline' && 'ip-error-chip')}
          title={syncLong[syncStatus]} aria-label={syncLong[syncStatus]}>
          {syncStatus === 'offline' ? <span className="ip-status-dot" /> : <Icon id="warn" />}
          <span>{lastSyncedAt != null
            ? fillTemplate(az.syncStand, { status: syncShort[syncStatus], t: formatTime(new Date(lastSyncedAt)) })
            : syncShort[syncStatus]}</span>
        </span>
      ) : null}
      {skewLoud && (
        <span className="ip-offline-chip"
          title={fillTemplate(cpSync.clockSkewToast, { n: Math.abs(skewMin) })}
          aria-label={fillTemplate(cpSync.clockSkewToast, { n: Math.abs(skewMin) })}>
          <Icon id="warn" />
          <span>{fillTemplate(az.clockSkewChip, { d: skewMin > 0 ? `+${skewMin}` : String(skewMin) })}</span>
        </span>
      )}
    </span>
  )

  /* ── What the cut-off title opens (09.09., mock 01) ────────────────────────────────────────
   * The one-row head buys its row by cutting the Einsatz name, so the cut part needs a door —
   * and the title itself is the only place anybody would knock. What stands behind it is
   * exactly what the two-row head used to print and nothing more: the Stichwort and the
   * Adresse whole (wrapping, never ellipsized — this panel has the room the row does not), and
   * the sync state in its LONG voice, «Gespeichert um 18:05» rather than the bare time the row
   * shrank it to. Anything else here would be a second Einsatz-Karte on a board whose whole
   * point is that it shows Trupps.
   * ⚠️ `title`/`address` come from the same two fields `subtitle` is joined out of
   * (IncidentWorkspace) — printed apart here, because a wrapped «Stichwort · Adresse» breaks
   * at whatever character the width happens to land on. The join stays the fallback, so an
   * older caller that only passes `subtitle` still says something true. */
  const headDetail = (
    <div className="az-hd">
      <p className="az-hd-title">{lite?.title ?? lite?.subtitle ?? az.boardTitle}</p>
      {lite?.address && <p className="az-hd-addr">{lite.address}</p>}
      {(syncStatus || skewLoud) && (
        <div className="az-hd-sync">
          {syncStatus === 'synced' || syncStatus === 'pending' ? (
            <span className={cx('az-sync-quiet', syncStatus === 'pending' && 'az-sync-pending')}>
              {syncStatus === 'synced' ? <Icon id="check" /> : <span className="ip-status-dot" />}
              <span>{syncStatus === 'pending' ? cpSync.badgePending : savedAtText}</span>
            </span>
          ) : syncStatus ? (
            <span className={cx('ip-offline-chip', syncStatus !== 'offline' && 'ip-error-chip')}>
              {syncStatus === 'offline' ? <span className="ip-status-dot" /> : <Icon id="warn" />}
              <span>{syncLong[syncStatus]}</span>
            </span>
          ) : null}
          {skewLoud && (
            <span className="ip-offline-chip">
              <Icon id="warn" />
              <span>{fillTemplate(cpSync.clockSkewToast, { n: Math.abs(skewMin) })}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )

  // ONE ROW (lib/pageHeadFit): the head folds words — the quiet line's time, the tiles' words,
  // «Trupp anmelden» → «Trupp» — until it fits, re-measured whenever what it carries changes
  const headRef = useRef<HTMLElement>(null)
  usePageHeadFit(headRef, [
    focusMode, overdueCount > 0 && overdueCount, removedTrupps.length > 0, trupps.length > 1, muted, audioBlocked,
    shareLinkActive, syncStatus, lastSyncedAt, skewLoud, canEdit,
  ].join('|'))

  return (
    // `az-tafel`: the global hook the Meldeleiste folds itself to one row for, and moves the
    // Tafel below itself on (08-toasts · staging r3)
    <div className={cx(s.surface, lite && s.surfaceLite, frozenAt != null && s.surfaceFrozen, 'az-tafel')} onPointerDownCapture={primeOnFirstTap}>
      <header ref={headRef} className={cx(s.head, focusMode && s.headCompact)}>
        <div className={cx(s.headTitles, focusMode && s.headTitlesCompact)}>
          {focusMode ? (
            /* mock 03: the kicker is GONE here — «Atemschutzüberwachung» cost a whole row's
               height to repeat what the whole screen is already for, and the strip below already
               reads «Trupp». Only the Einsatz's own name earns this line, alongside the shrunk
               sync state (see `syncLine` above); the bell stays right of it, in `.headActs`. */
            <div className={s.headRow}>
              {/* focusMode is `lite && compact`, so this is always the Einsatz — the fallback
                  exists only so the line can never render empty.
                  ⚠️ …and the line is now a DOOR (09.09., mock 01). One row means the name is cut
                  where the buttons begin — «Brand PV Anlage · Amselstr…» — so the part that was
                  cut has to be reachable, and the truncated title is the one place anybody would
                  look for it. It opens the same three facts the two-row head used to print in
                  full: Stichwort, Adresse, und ob der Stand gespeichert ist. */}
              {/* the one title that is SUPPOSED to be cut — its door opens the rest */}
              <h2 className={s.headTitleH} data-fit-free>
                <Popover
                  side="bottom" align="start" popupClassName="az-head-detail"
                  ariaLabel={az.headDetailTitle}
                  /* ⚠️ `--z-popover` (01-tokens.css · 60) as a number, because the Positioner
                     takes an inline z-index. The popup is portalled to <body> and would
                     otherwise sit at `auto` UNDER this very surface, which is `--z-surface` 20. */
                  zIndex={60}
                  trigger={
                    /* ⚠️ ONE target, and the sync mark is INSIDE it (09.09., maintainer review).
                       The ✓ lost its time in this pass, and a bare mark sitting beside a door is
                       the kind of ornament a thumb aims at and nothing happens — while the thing
                       it stands for (the full «Gespeichert um 18:05») is exactly what the door
                       opens. So the mark travels with the title, the whole line is the button,
                       and `--tap` keeps it a real target rather than a line of text.
                       ⚠️ The a11y NAME stays the door's — «Einsatzangaben anzeigen». The mark is
                       `aria-hidden` inside it: read out, «Häkchen» in the middle of a button
                       label names neither the button nor the state, and the state is spoken in
                       full by the panel the button opens. */
                    <button type="button" className={s.headTitleBtn}
                      title={az.headDetailOpen} aria-label={az.headDetailOpen}>
                      <span>{lite?.subtitle ?? az.boardTitle}</span>
                      {syncLine && <span className={s.headTitleSync} aria-hidden="true">{syncLine}</span>}
                      <Icon id="chevron-down" className="chev" />
                    </button>
                  }
                >
                  {headDetail}
                </Popover>
              </h2>
            </div>
          ) : (
            <>
              {/* ⚠️ «Trupps» in the full app, «Atemschutzüberwachung» on the handed-over Tafel
                  (03.09.). The board carries both sections now, and the old title over a row
                  reading «Verkehr» would have named something that is not there. The link
                  session sees only the Atemschutz, so for it the old title stays TRUE — and it
                  is the one screen whose holder has nothing else telling them what they are
                  looking at. */}
              {lite ? (
                /* the handed-over Tafel: the kicker and the sync state share the quiet top line, the
                   Einsatz its own below — two lines, like every other head (28.09.2026; it stood three) */
                <>
                  <span className={s.liteKicker}><h2>{az.title}</h2>{syncLine}</span>
                  {/* ⚠️ The second line exists only on the handed-over Tafel, and it is the EINSATZ.
                      Nothing else on that screen names it, and «welcher Einsatz ist das» is the first
                      question somebody scanning a code from a stranger's tablet has.
                      In the full app there is no second line: it used to carry a sentence about what
                      the board is for («Lückenlose Überwachung jedes Atemschutztrupps»), which is a
                      claim the operator standing at the board has already made — dropped 04.09. */}
                  <p title={lite.subtitle}>{lite.subtitle}</p>
                </>
              ) : (
                <>
                  <h2>{az.boardTitle}</h2>
                  {syncLine}
                </>
              )}
            </>
          )}
        </div>
        {/* ⚠️ ONE group, not four siblings. `.head` used to wrap, and as direct children the badge,
            the sort menu, the mute toggle and «Trupp anlegen» wrapped INDIVIDUALLY — on a phone the
            filter stayed up beside the title while the other two dropped to a second row. Grouped,
            they stand as one block at the right end of the one row, and on the ladder's last step
            (lib/pageHeadFit) they move to the second row together. */}
        <div className={s.headActs}>
        {/* not in focus mode: the red tab and the red card already say it, and the badge cost the
            header a whole extra row on a phone */}
        {mostOverdue && !focusMode && (
          /* ⚠️ A BUTTON. It used to be a <div>: the loudest thing on the screen, saying that a
              Trupp is out of contact, and pressing it did nothing — so on a board with eight
              cards the answer to «welcher denn?» was still a scroll. It now points at the same
              card the app-wide TopBar chip points at (the most overdue one, which is also the
              one sortTrupps floats to the top), and a repeat press points again. */
          <button
            /* muted (27.09.2026): the same tile in plain grey — the count still counts, the
               head just does not shout a tone it has promised not to play */
            type="button" className={cx(s.overdueBadge, muted && s.overdueQuiet)} data-fold={HEAD_FOLD.overdue}
            aria-live="assertive"
            title={fillTemplate(az.overdueBadgeGo, { name: mostOverdue.name })}
            aria-label={fillTemplate(az.overdueBadgeGo, { name: mostOverdue.name })}
            onClick={() => setSelfFocus({ id: mostOverdue.id, nonce: Date.now(), markAll: true })}
          >
            <Icon id="warn" /><span className="fold-long">{az.overdueBadge(overdueCount)}</span>
            {/* a crowded head keeps the ⚠ and the number (the head's ladder, `HEAD_FOLD`) */}
            <span className="fold-short" aria-hidden="true">{overdueCount}</span>
          </button>
        )}
        {/* ⚠️ The way back that does not expire. Deleting a Trupp raises a «Rückgängig» toast for six
            seconds; miss it — gloves, 3am, a second Trupp overdue — and the card was unreachable,
            even though the record itself keeps it (types · Trupp.removedAt). Shown only while there
            IS something to bring back, so an ordinary board never carries it.
            ⚠️ BEFORE the sort filter (05.09.): the two icons sat the other way round, and the one
            that undoes something belongs nearer the badge than the one that only changes how the
            board is looked at.
            ⚠️ #archive, not #undo (08.09.2026). This header carries a REAL ↶ ↷ pair now, and two
            undo arrows in one row meaning two different things is the kind of guess nobody should
            be making at 3am. Archive is also the truer word: these cards were taken off the board
            and are still in the record, which is exactly what the menu offers back. */}
        {canEdit && removedTrupps.length > 0 && (
          <Menu
            trigger={
              <button type="button" className={s.orderBtn} data-fold={HEAD_FOLD.restore} aria-label={az.restoreMenu} title={az.restoreMenu}>
                <Icon id="archive" /><span className="fold-long">{az.restoreMenu}</span>
              </button>
            }
            popupClassName="rp-print-menu"
            itemClassName={() => 'rp-print-menu-item'}
            items={[
              { kind: 'head' as const, label: az.restoreMenu },
              ...removedTrupps.map((t) => ({
                label: fillTemplate(az.restoreItem, { name: t.name }),
                onClick: () => restoreTrupp(t),
              })),
            ]}
          />
        )}
        {/* ⚠️ The handed-over Tafel has no TopBar at all (IncidentWorkspace · «Tafel pur»), so the
            app's one ↶ ↷ pair has to live here — driving the SAME global timeline (lib/undoTimeline),
            not a second history of its own. Only trupp actions can reach this session's stack, so
            what it takes back is always something on this board.
            ⚠️ `lite` only: in the full app the TopBar carries the pair, and a second door beside it
            would be two controls for one history — the mistake AnwesenheitView documents. And the
            pair is WHOLE: a ↶ without its ↷ makes the step back the one thing that cannot itself
            be taken back. */}
        {lite && canEdit && onUndo && onRedo && (
          <>
            <button type="button" className={s.orderBtn} onClick={onUndo} disabled={!canUndo}
              aria-label={undoWord} title={undoWord}>
              <Icon id="undo" />
            </button>
            <button type="button" className={s.orderBtn} onClick={onRedo} disabled={!canRedo}
              aria-label={redoWord} title={redoWord}>
              <Icon id="redo" />
            </button>
          </>
        )}
        {/* ⚠️ A MENU, not a segmented control. Four options laid out in full needed ~380px in a
            header that also carries a title, a subtitle, an überfällig badge, the alarm toggle and
            «Neuer Trupp» — so it grew over the subtitle and covered the sentence explaining what
            the board is. A way of LOOKING at the board is not worth a permanent strip of the one
            screen that exists to show overdue Trupps; behind its own icon it costs 44px and the
            current choice still shows as a tick when it is opened. */}
        {/* not on the phone board: its arrangement is fixed (see `phoneMode`) */}
        {trupps.length > 1 && onOrder && !lite && !phoneMode && (
          <Menu
            trigger={
              <button type="button" className={s.orderBtn} data-fold={HEAD_FOLD.order} aria-label={az.orderLabel} title={az.orderLabel}>
                <Icon id="filter" /><span className="fold-long">{az.orderLabel}</span>
              </button>
            }
            popupClassName="rp-print-menu"
            itemClassName={() => 'rp-print-menu-item'}
            items={[
              { kind: 'head' as const, label: az.orderLabel },
              {
                kind: 'radio' as const,
                value: order,
                onChange: (v: string) => onOrder(v as TruppOrder),
                options: [
                  { value: 'manuell', label: az.orderManual },
                  { value: 'dringlichkeit', label: az.orderUrgency },
                  { value: 'auftrag', label: az.orderAuftrag },
                  { value: 'name', label: az.orderName },
                ],
              },
            ]}
          />
        )}
        {/* «Überwachung abgeben»: the QR, beside the bell, because the realistic handover in an
            Einsatz is «Handy scannen lassen» and the FU is standing on THIS page when they
            decide to. Green while a link is live — the same 44px square as the two controls
            beside it, so the header's right end stays a row of equal targets. */}
        {onShareLink && (
          <button
            type="button"
            className={cx(s.orderBtn, shareLinkActive && s.shareOn)} data-fold={HEAD_FOLD.share}
            onClick={onShareLink}
            aria-label={shareLabel} title={shareLabel}
          >
            <Icon id="qr" /><span className="fold-long">{az.shareLink}</span>
          </button>
        )}
        {/* ⚠️ Stays HERE even on the lite/phone focus board (maintainer correction, 03.09.): an
            earlier pass moved it down beside the strip, but the review put it back — top row,
            right side, beside the shrunk «Gespeichert» check. Only the chip strip and the
            compact «+» actually belong in the bottom rail. */}
        {bellButton}
        {/* in focus mode «+ Trupp» lives in the rail beside the strip — not a second one up here */}
        {canEdit && !focusMode && (
          <button className={s.newBtn} data-fold={HEAD_FOLD.newTrupp} onClick={() => openForm('create')} aria-label={az.newTrupp} title={az.newTrupp}>
            {/* the full word where it fits, the short one where the head's ladder has run out of
                everything else — never a bare «+» (AGENTS.md: every button on the ASÜ board has a word) */}
            <Icon id="plus-bold" /><span className="fold-long">{az.newTrupp}</span><span className="fold-short">{az.newTruppShort}</span>
          </button>
        )}
        </div>
      </header>

      <div className={cx(s.body, focusMode && s.bodyFocus)} ref={bodyRef}>
        {/* The Atemschutznotfall stands at the TOP of the board, on every board, however it is
            sorted (F1, 08.10.2026) — the strip's row steps aside here, this is its place. Not on
            a closed Einsatz: its Tafel alarms nothing (R3). */}
        {notfallTrupps.length > 0 && <div className={s.nfStack} ref={nfStackRef}>{notfallTrupps.map((t) => (
          <NotfallBanner key={t.id} t={t} now={now} place={placeOf?.(t)} canEdit={canEdit} dense={notfallTrupps.length > 1}
            ready={notfallReady} inside={notfallSafetyInside}
            onDeploySafety={(id) => { freezeOrder(); setTruppStatus(id, 'aktiv') }}
            pickSafety={(trigger) => (
              <Menu trigger={trigger} popupClassName="rp-print-menu" itemClassName={() => 'rp-print-menu-item'}
                items={[
                  { kind: 'head' as const, label: az.notfall.sitrPickTitle },
                  ...notfallReady.map((x) => ({
                    label: [x.name, ...(x.members ?? [])].map((n) => n.trim()).filter(Boolean).join(' / '),
                    onClick: () => { freezeOrder(); setTruppStatus(x.id, 'aktiv') },
                  })),
                ]} />
            )}
            onDefineSafety={safetyPickNew}
            defineSafety={phoneReady.length === 0 ? undefined : (trigger) => (
                <Menu trigger={trigger} popupClassName="rp-print-menu" itemClassName={() => 'rp-print-menu-item'}
                  items={[
                    { kind: 'head' as const, label: az.safetyPickTitle },
                    ...phoneReady.map((x) => ({
                      label: [x.name, ...(x.members ?? [])].map((n) => n.trim()).filter(Boolean).join(' / '),
                      onClick: () => editTrupp(x.id, truppFieldsOf(x, { auftrag: 'sichern' })),
                    })),
                    { kind: 'sep' as const },
                    { label: az.safetyPickNew, onClick: safetyPickNew },
                  ]} />
              )}
            onGo={(id) => {
              if (compact && !focusMode) setOpenRow(id)
              setPicked(id)
              setSelfFocus({ id, nonce: Date.now() })
            }} />
        ))}</div>}
        {trupps.length === 0 ? (
          <div className={s.empty}>
            <Icon id="warn" />
            <p>{az.empty}</p>
            <span>{az.emptyHint}</span>
            {/* The door the empty board is asking for (staging walk-through 25.09.2026): the big
                round «+» at the bottom right is the app's Verlauf-Eintrag, and on an empty board it
                is the one a first-timer taps. On the handed-over phone board «+ Trupp» is the
                bottom rail's own cell, so it is not repeated here. */}
            {canEdit && !focusMode && (
              <Button variant="primary" size="lg" className={s.emptyAct} icon={<Icon id="plus-bold" />} onClick={() => openForm('create')}>
                {/* the whole «Trupp anmelden» (newTrupp): `start` is the form's one-verb footer since 27.09.2026 */}
                {az.newTrupp}
              </Button>
            )}
          </div>
        ) : focusMode ? (
          /* top-aligned: the card takes only what it needs, never stretched to fill the port
             (`.focusCard`'s own `align-items: flex-start`) — the strip that used to sit above it
             moved to the bottom rail below (mock 03: «status where the eyes land, actions where
             the thumb lives»). */
          <div className={s.focusCard}>{cards(board.filter((t) => t.id === focusId))}</div>
        ) : phoneMode ? (
          // `.phoneBoard`: the one rule for the air above every section after the first (30.09.2026)
          <div ref={listRef} className={cx(s.phoneBoard, openRow && s.rowListOpen)}>
            {phoneIn.length > 0 && (
              <>
                <div className={s.sect}><span className={s.sectTitle}>{az.phoneSectionIn}</span><span className={s.sectCount}>{phoneIn.length}</span></div>
                <div className={s.rowList}>{cards(phoneIn)}</div>
              </>
            )}
            {/* the Sicherungstrupp keeps ONE place: under the crews inside, above everybody else —
                ALWAYS, filled or empty (D1 ⑦, 24.09.2026). Since 26.09.2026 (phone card slim-down)
                it is a section head like DRIN / DRAUSSEN — «SICHERUNGSTRUPP ——— Bestimmen» — with
                the standing Trupp as an ordinary row under it, or nothing: the empty section IS the
                statement, and the head's title turns amber the moment a crew is inside and nobody
                stands ready (`sectDue`, a hint in the warn tone — the alarm rules do not know it).
                The dashed box with «Kein Sicherungstrupp · Ein Trupp ist drin» went with the
                slim-down: two sentences for what the empty section says by itself.
                ⚠️ Not once every Trupp is OUT (review 25.09.2026): with nobody in and nobody
                waiting there is nothing to secure, and «Bestimmen» would register a crew for an
                Einsatz that is winding down. */}
            {(phoneIn.length > 0 || phoneReady.length > 0 || phoneSafety.length > 0) && (
              <div className={cx(s.rowList, s.safetyZone)}>
                <div className={cx(s.sect, s.sectSafety, phoneSafety.length === 0 && phoneIn.length > 0 && s.sectDue)}>
                  <span className={s.sectTitle}>{az.safetyTitle}</span>
                  {phoneSafety.length > 0 && <span className={s.sectCount}>{phoneSafety.length}</span>}
                  {canEdit && phoneSafety.length === 0 && (phoneReady.length === 0 ? safetyPickButton : (
                    <Menu
                      trigger={safetyPickButton}
                      // the app's shared menu skin (13-incident.css — despite its name, every
                      // Atemschutz menu and the audio picker wear it)
                      popupClassName="rp-print-menu"
                      itemClassName={() => 'rp-print-menu-item'}
                      items={[
                        { kind: 'head' as const, label: az.safetyPickTitle },
                        ...phoneReady.map((t) => ({
                          label: [t.name, ...(t.members ?? [])].map((n) => n.trim()).filter(Boolean).join(' / '),
                          onClick: () => editTrupp(t.id, truppFieldsOf(t, { auftrag: 'sichern' })),
                        })),
                        { kind: 'sep' as const },
                        { label: az.safetyPickNew, onClick: safetyPickNew },
                      ]}
                    />
                  ))}
                </div>
                {phoneSafety.map((t) => (openRow === t.id ? cards([t]) : (
                  // «Einsetzen» is an ordinary Eintritt; its Verlauf row says «Sicherungstrupp
                  // eingesetzt» because the Trupp is on «Sichern» (useTruppActions · setTruppStatus)
                  <SafetyRow key={t.id} t={t} canEdit={canEdit}
                    onDeploy={(id) => { freezeOrder(); setTruppStatus(id, 'aktiv') }}
                    onOpen={() => setOpenRow(t.id)} />
                )))}
              </div>
            )}
            {phoneReady.length > 0 && (
              <>
                <div className={s.sect}><span className={s.sectTitle}>{az.phoneSectionReady}</span><span className={s.sectCount}>{phoneReady.length}</span></div>
                <div className={s.rowList}>{cards(phoneReady)}</div>
              </>
            )}
            {phoneOut.length > 0 && (
              <>
                <div className={s.sect}><span className={s.sectTitle}>{az.phoneSectionOut}</span><span className={s.sectCount}>{phoneOut.length}</span></div>
                <div className={s.rowList}>{cards(phoneOut)}</div>
              </>
            )}
            {plainBoard.length > 0 && (
              <>
                <div className={cx(s.sect, s.sectSecond)}>
                  <span className={s.sectTitle}><Icon id="people" />{az.sectionPlain}</span>
                  <span className={s.sectCount}>{plainBoard.length}</span>
                </div>
                <div className={s.rowList}>{cards(plainBoard)}</div>
              </>
            )}
          </div>
        ) : !sectioned ? (
          <div ref={listRef} className={cx(compact ? s.rowList : s.grid, compact && openRow && s.rowListOpen)}>
            {cards(paBoard)}
          </div>
        ) : (
          /* ⚠️ ONE scroll wrapper around both sections, and it is what carries `listRef`. The
             open-card spacer measures the card marked `data-az-open` inside this element — with
             the ref on the first section's list, opening a Trupp in the SECOND one found no card
             and bought no room, so the card parked itself against a list that could not scroll. */
          <div ref={listRef} className={cx(compact && openRow && s.rowListOpen)}>
            <div className={s.sect}>
              <span className={s.sectTitle}><Icon id="gauge" />{az.sectionAtemschutz}</span>
              <span className={s.sectCount}>{paBoard.length}</span>
            </div>
            {paBoard.length === 0 ? (
              // in-context empty state: the head alone over nothing reads as a bug, and «nobody
              // is under PA right now» is a fact the Überwacher wants stated, not implied
              <p className={s.sectEmpty}>{az.sectionAtemschutzEmpty}</p>
            ) : (
              <div className={compact ? s.rowList : s.grid}>{cards(paBoard)}</div>
            )}
            <div className={cx(s.sect, s.sectSecond)}>
              <span className={s.sectTitle}><Icon id="people" />{az.sectionPlain}</span>
              <span className={s.sectCount}>{plainBoard.length}</span>
            </div>
            {/* ⚠️ The SAME rows and the same cards as above (03.09.). They used to be their own
                half-height `PlainTruppRow` with its controls on the row, on the argument that a
                Trupp without a contact clock has nothing further to open. It does: its Verlauf.
                And on a phone two different footprints in one scroll taught the eye that these
                are two kinds of object, when the point of the section head is that they are one
                board. What keeps them apart is the card's own restraint — no tint, no clock, no
                Kontakt — not a second layout. */}
            <div className={compact ? s.rowList : s.grid}>{cards(plainBoard)}</div>
          </div>
        )}
      </div>

      {/* ── Bottom rail (mock 03, maintainer correction 03.09. — twice: the bell was tried down
          here and put back in the header) ────────────────────────────────────────────────────
          The chip strip and «+ Trupp» move down here, into the thumb zone, mirroring the app's
          own phone bottom bars (`--rail-h`, src/styles/15-mobile.css): status/selection where
          the eyes land (the content above), actions where the thumb already rests. Rendered
          regardless of `trupps.length` so «+ Trupp» is always reachable even on an empty board —
          the strip's own grid then simply draws no tabs. Generous bottom padding
          (`env(safe-area-inset-bottom)`) keeps a thumb reaching for Kontakt or a tab away from
          Safari's own bottom chrome. */}
      {focusMode && (
        <div className={s.bottomRail}>
          <div className={s.strip} role="tablist" aria-label={az.title}>
            {board.map((t) => {
              const lv = live.get(t.id)!
              const sev = alarms.get(t.id)!.sev
              return (
                <button
                  key={t.id} type="button" role="tab" aria-selected={t.id === focusId}
                  className={cx(s.tab, t.id === focusId && s.tabOn, sev === 1 && s.tabWarn, sev >= 2 && s.tabCrit,
                    // idle grey = no crew inside (out, or still at the door) — an out AS-Trupp's
                    // break clock ticks in this quiet tone, same as the card's quiet band
                    (lv.status === 'raus' || lv.status === 'angemeldet') && s.tabIdle)}
                  onClick={() => setPicked(t.id)}
                >
                  {/* ⚠️ NO Truppfarbe dot here (round 2 review): the lite board drops every
                      colour accent — the Lage/plan identity a colour normally carries means
                      nothing on a screen that never shows the Lage or the plan. The full name
                      is what identifies the Trupp here, so it wraps rather than clips (a name
                      like «Binggeli Michael» was cut mid-word against this chip's width).
                      No «#N» badge either (Bastian, 14.09.): on a chip this narrow the number
                      fought the wrapped name for space and added nothing the card below does
                      not say – the badge stays on the card head, the phone row and the map. */}
                  <span className={cx(s.tabName, s.tabNameWrap)}>{t.name}</span>
                  {/* the same collapsed-time split the list row and the card make (collapsedClock) */}
                  <span className={s.tabClock}><ClockVal val={collapsedClock(t, lv).val} /></span>
                </button>
              )
            })}
            {/* «+ Trupp» — the LAST CELL OF THE SAME GRID (05.09.). It used to be a 44px icon
                button in a fixed column of its own beside the strip, which made it the one thing
                on the rail that was neither as wide nor as tall as a chip, and it ate width the
                names needed («Stich Markus» clipped against it). In the grid it is one more cell:
                same width, same row height, and it flows on after the last Trupp instead of
                hanging off the top-right corner. It is a plain action inside the tablist for the
                same reason a browser's own tab strip carries one — the thing that adds a tab
                belongs where the tabs are. The bell stays in the header (03.09.). */}
            {canEdit && (
              // ⚠️ «+ Trupp», with its word (29.09.2026, T9): the Add rule says «+ word» wherever there
              // is room, and this is a full cell — a bare «+» on the one screen a stranger gets
              <button type="button" className={cx(s.tab, s.tabAdd)} onClick={() => openForm('create')}
                aria-label={az.newTrupp} title={az.newTrupp}>
                <span className={s.tabName}><Icon id="plus-bold" />{az.newTruppShort}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {form && (
        <TruppForm
          mode={form.mode} initial={form.trupp} presetAuftrag={form.presetAuftrag} focusSection={form.focus} roster={roster} defaultFunkkanal={defaultFunkkanal}
          personnel={personnel} presentIds={presentIds} stationIds={stationIds} rolesById={rolesById}
          /* ⚠️ NOBODY is bound while a Trupp that has come OUT is being corrected (09.09.).
             «Einer, ein Trupp» is a rule about who is deployed NOW: a finished record shares its
             people with the live board by definition — the AdF whose Trupp came out at 15:40
             stands in the next one at 15:50. Measured against the live board, correcting the
             Auftrag on the old card hit `assignedConflict`, Speichern went dead, and the
             correction was lost. `redeploy` is not this case and keeps the check: that Trupp is
             going back IN. (`assignedPersonIds` already ignores every OTHER raus Trupp, so a
             finished crew never blocks a live form either.) */
          assignedIds={form.mode === 'edit' && form.trupp?.status === 'raus' ? NO_ASSIGNED
            : assignedPersonIds(trupps.filter((t) => t.id !== form.trupp?.id))}
          /* …and the way OUT of that conflict, in one tap (11.09.). Both halves read the same
             `truppOfPerson` index, so the state the warning shows and the Trupp the move writes
             to can never be two different cards. */
          transferState={(personId) => truppTransferState(truppOfPerson.get(personId), personId)}
          onTransfer={transferOutOfTrupp && ((personId, toName) => {
            const from = truppOfPerson.get(personId)
            if (from) transferOutOfTrupp(from.id, personId, toName)
          })}
          leitungOptions={leitungOptions(form.trupp?.id)}
          lite={!!lite}
          // ⚠️ EVERY phone, not only the handed-over one (03.09.). `compact` is `useIsPhone`, so a
          // tablet — where the whole form stands in one glance — keeps the single screen; the
          // stack exists for the 375px case, where the single screen puts the fields that start
          // the safety clock below a fold nobody knows is there. Outside the link the sections
          // additionally carry the «Art des Trupps» tiles and the Ltg-Nr. (both gated `!lite`),
          // and EVERY Art of Trupp gets the same three sections — a Trupp ohne Atemschutz simply
          // has no Druck row inside «Luft & Funk» — see TruppForm.
          stack={compact}
          // the phone board's bottom sheet with the due clocks above it (D1 ⑥) — never on the
          // handed-over Tafel's phone board, which keeps its full-screen form
          sheet={phoneMode}
          pinned={pinnedRows}
          onAddGuest={onAddGuest}
          onCancel={() => setForm(null)} onSubmit={submitForm}
        />
      )}

      {pressureAsk && (() => {
        const t = trupps.find((x) => x.id === pressureAsk.id)
        // the Trupp went out (or away) on another device while the sheet stood open — nothing to ask
        if (!t || !inFieldNow(t)) return null
        const lv = live.get(t.id)!
        const close = () => setPressureAsk(null)
        return pressureAsk.kind === 'exit' ? (
          <PressureSheet t={t} title={az.exitSheetTitle} hint={az.exitSheetHint}
            last={lv.currentBar} alarmBar={alarmBarFor(t, atemschutzDoctrine())} onClose={close}
            onPick={(bar) => { freezeOrder(); setTruppStatus(t.id, 'raus', bar); close() }}
            footer={{ label: az.exitNoBar, onClick: () => { freezeOrder(); setTruppStatus(t.id, 'raus'); close() } }} />
        ) : (
          /* ⚠️ The first reading within minutes of the Eintritt REPLACES the Eingangsdruck
             (useTruppActions · recordPressure) — and the sheet says so in words instead of a
             promise it does not keep (staging walk-through 25.09.2026). It still counts as a
             Kontakt. An Eingangsdruck set on purpose is never replaced, and then the ordinary
             line stands (lib/atemschutz · earlyEntryCorrection). */
          <PressureSheet t={t} title={az.pressureSheetTitle}
            hint={earlyEntryCorrection(t, serverNow()) ? fillTemplate(az.pressureSheetFirst, { bar: t.entryPressureBar }) : az.pressureSheetHint}
            last={lv.currentBar} alarmBar={alarmBarFor(t, atemschutzDoctrine())} onClose={close}
            onPick={(bar) => { freezeOrder(); recordPressure(t.id, bar); close() }} />
        )
      })()}

      {quick && (() => {
        const t = trupps.find((x) => x.id === quick.id)
        // the Trupp left the board on another device while the sheet stood open — nothing to edit
        if (!t) return null
        const close = () => setQuick(null)
        const save = (f: TruppFields) => saveQuick(t.id, f)
        return quick.kind === 'kanal'
          ? <KanalSheet t={t} onSave={save} onClose={close} />
          : quick.kind === 'auftrag'
          ? <AuftragSheet t={t} leitungOptions={leitungOptions(t.id)} lite={!!lite}
              onSave={save} onClose={close} />
          /* the crew and the Ausrüstung — the same roster, presence and «one person, one Trupp»
             answers the form gets (see TruppForm's props below); a Trupp that has come OUT binds
             nobody, for the reason given there */
          : <TruppSheet t={t} personnel={personnel} legacyRoster={roster} presentIds={presentIds} stationIds={stationIds} rolesById={rolesById}
              assignedIds={t.status === 'raus' ? NO_ASSIGNED : assignedPersonIds(trupps.filter((x) => x.id !== t.id))}
              transferState={(personId) => truppTransferState(truppOfPerson.get(personId), personId)}
              onTransfer={transferOutOfTrupp && ((personId, toName) => {
                const from = truppOfPerson.get(personId)
                if (from) transferOutOfTrupp(from.id, personId, toName)
              })}
              onAddGuest={onAddGuest} onSave={save} onClose={close} />
      })()}

      {placePick && (() => {
        // the symbols already standing, minus this Trupp's own (see lib/placedTrupps · markerOptions)
        const markers = markerOptions(placePick)
        return (
        <Overlay open onClose={() => setPlacePick(null)} className={cx(s.modal, s.placeModal)} ariaLabel={az.placeWhere}>
          <div className={s.modalHead}><h3>{az.placeWhere}</h3>
            <button className="ip-x" aria-label={az.cancel} onClick={() => setPlacePick(null)}><Icon id="close" /></button>
          </div>
          <div className={s.placeOpts}>
            {placeTargets.map((tgt) => (
              <button key={tgt.id} className={s.placeOpt} onClick={() => { placeTrupp(placePick, tgt.id); setPlacePick(null) }}>
                <Icon id={tgt.id === 'lage' ? 'map' : 'doc'} /><span>{tgt.label}</span>
              </button>
            ))}
            {/* …or take over a Trupp that is ALREADY standing somewhere — the twin of the Trupp
                form's «Gezeichnet:» Leitung quick-picks: the thing is already in the picture, so
                the app offers it instead of making somebody place a second symbol for one crew.
                A symbol somebody else holds stays pickable and says so; the confirm is in the
                action (useTruppActions · adoptTruppMarker). */}
            {markers.length > 0 && (
              <>
                <div className={s.placeSep}>{az.markerPick}</div>
                {markers.map((m) => (
                  <button key={m.key} className={cx(s.placeOpt, s.placeOptMarker)}
                    onClick={() => { adoptMarker(placePick, m.key); setPlacePick(null) }}>
                    <span>
                      <span className={s.placeOptCap} style={{ background: m.color || appConfig.drawing.teamColors[0] }} aria-hidden />
                      {m.name}
                    </span>
                    <span className={s.placeOptWhere}>
                      {/* the holder only where it says something the title does not — a Trupp's
                          own marker already carries its name (lib/placedTrupps · markerHolderNote) */}
                      {(() => {
                        const holder = markerHolderNote(m)
                        return `${m.where}${holder ? ` · ${fillTemplate(az.markerOptTaken, { name: holder })}` : ''}`
                      })()}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </Overlay>
        )
      })()}
    </div>
  )
}

/** re-entry within this many minutes of the Austritt asks «gleiche oder neue Flasche?» */
const BOTTLE_ASK_MIN = 10

/** The Sicherungstrupp standing ready, on the phone board (24.09.2026): its own row in its own
 *  place, with the one action it exists for. The whole row opens its card, like every other row.
 *  Since 26.09.2026 (phone card slim-down) it stands under a SICHERUNGSTRUPP head, so the row
 *  leads with the NAME like every other row and the Eingangsdruck under it — the head says what
 *  it is, the row said it a second time. */
function SafetyRow({ t, canEdit, onDeploy, onOpen }: {
  t: Trupp; canEdit: boolean; onDeploy: (id: string) => void; onOpen: () => void
}) {
  const az = appConfig.copy.atemschutz
  return (
    <button type="button" className={cx(s.trow, s.trowSafety)} onClick={onOpen} aria-label={`${az.safetyTitle}: ${t.name}`}>
      <span className={s.trowId}>
        <span className={s.trowName}><span className={s.trowNameTxt}>{truppHeadName(t)}</span></span>
        {t.entryPressureBar ? <span className={s.trowSafetyWho}>{t.entryPressureBar} bar</span> : null}
      </span>
      <span className={s.trowAct}>
        {canEdit && (
          <span role="button" tabIndex={0} className={s.safetyDeploy}
            onClick={(e) => { e.stopPropagation(); onDeploy(t.id) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onDeploy(t.id) } }}>
            {az.actEnter}
          </span>
        )}
      </span>
    </button>
  )
}

/** What the Trupp form hands the board besides its fields: the groups the operator touched (an
 *  edit writes only those) and the door that files its Gäste, called once every question in
 *  front of the save is answered (AtemschutzView · submitForm). */
type TruppSubmitExtra = {
  touched: TruppFieldGroup[]
  fileGuests: () => Pick<TruppFields, 'leaderPersonId' | 'memberPersonIds'>
}

/** One field group of a Trupp as it reads NOW — the value the edit-conflict line names. */
function fieldNow(t: Trupp, g: TruppFieldGroup): string {
  const az = appConfig.copy.atemschutz
  switch (g) {
    case 'crew': return truppLogName({ name: t.name, members: t.members })
    case 'auftrag': return truppAuftragLabel(t.auftrag) ?? '–'
    case 'ziel': return t.ziel?.trim() || '–'
    case 'lineNo': return t.lineNo != null ? String(t.lineNo) : '–'
    case 'funkkanal': return t.funkkanal != null ? String(t.funkkanal) : '–'
    case 'pressure': return `${t.entryPressureBar} bar`
    case 'kind': return isAtemschutzTrupp(t) ? az.kindAtemschutz : az.kindPlain
    case 'equipment': return truppEquipmentLabels(t.equipment).join(', ') || '–'
  }
}

/** A due or overdue Trupp pinned ABOVE the phone's Trupp form (24.09.2026, D1 ⑥): name and state,
 *  the live clock, and a worded «Kontakt» that confirms without leaving the form. ONE line, not
 *  the board row's two: the form needs the height, and these rows carry exactly one action. Not a
 *  button as a whole — opening a card from here would close the form over a half-typed Trupp. */
function PinnedRow({ t, live, alarm, color, confirmed, onContact }: {
  t: Trupp; live: TruppLive; alarm: TruppAlarm; color?: string
  /** confirmed a moment ago on this form — the button says so and takes no second tap */
  confirmed: boolean
  onContact: (id: string) => void
}) {
  const az = appConfig.copy.atemschutz
  const sev = alarm.sev
  // ⚠️ Confirmed a moment ago, the row says only THAT (staging walk-through 25.09.2026): «✓
  // Bestätigt» beside an amber «0:01 Kontakt fällig» — the tier the hold kept from before the
  // tap — read as two answers at once. A pressure alarm is not answered by a Kontakt and stays.
  const done = confirmed && alarm.reason !== 'pressure'
  const word = done ? az.clockOk : alarm.reason === 'notfall' ? az.notfall.title : alarm.reason === 'pressure' ? az.clockAlarmPressure : sev >= 2 ? az.clockOverdue : az.clockWarn
  // ⚠️ «Überfällig» / «Kontakt fällig» are not SHOWN (owner, 29.09.2026: «red is already pretty
  // obvious» — the same call as the card's state line): the row's red or amber and its Kontakt say
  // it; the word stays for a screen reader. «Alarmdruck» and «Bestätigt» stay: colour can't say those.
  const tierOnly = !done && alarm.reason !== 'pressure' && alarm.reason !== 'notfall'
  return (
    <div className={cx(s.pinRow, done ? s.pinRowDone : sev >= 2 ? s.trowCrit : s.trowWarn)}>
      <span className={s.pinName}>
        {color && <span className={s.trowDot} style={{ background: color }} aria-hidden />}
        <span className={s.pinNameTxt}>{t.name}</span>
      </span>
      <span className={s.pinTime}>
        <span className={s.pinClock}>{fmtClock(live.sinceContactSec)}</span>
        <span className={tierOnly ? 'sr-only' : s.pinState}>{word}</span>
      </span>
      {confirmed ? (
        <button type="button" className={cx(s.kontaktBtn, s.pinKontakt, s.pinDone)} disabled
          aria-label={`${az.contactDone}: ${t.name}`}>
          <Icon id="check" /><span>{az.contactDone}</span>
        </button>
      ) : (
        <button type="button" className={cx(s.kontaktBtn, s.pinKontakt, sev === 1 && s.kontaktWarn, sev >= 2 && s.kontaktCrit)}
          onClick={() => onContact(t.id)} aria-label={`${az.actContact}: ${t.name}`}>
          <Icon id="radio" /><span>{az.actContact}</span>
        </button>
      )}
    </div>
  )
}

// (`PressureStepper` and `FunkkanalStepper`, the form's ± steppers, went on 30.09.2026: the form's
// rows open the Druck sheet's grid and the Kanal sheet's pad — TruppSheets · PressureSheet /
// KanalPickSheet, where the Kanal stepper lives on for a range too wide for a pad.)
// (`PressureInline`, the tablet card's ± Druck stepper with its own «Bestätigen», went on
// 29.09.2026 with the tablet card: every board's Druck is the pressure tile → PressureSheet.)
/** A day-long clock drawn compact (30.09.2026, owner: «the group leader name needs more space»):
 *  «3 d 9 h» in the clock's mono spent a full character on every space and every unit, the widest
 *  thing on the card's head after the name. The digits stay mono; each unit is a small letter in
 *  the body face hard against its number, and the groups stand a third of an em apart — «3d 9h»,
 *  about two thirds the width. Every other clock passes through as it is. The card's foot draws its
 *  day-long Einsatzzeit / «Draussen seit» through here too, so one card never shows both spellings;
 *  mm:ss and «17:00 min» are untouched. */
function ClockVal({ val }: { val: string }) {
  const m = /^(\d+) d (\d+) h$/.exec(val)
  if (!m) return <>{val}</>
  // the space rides in the unit's small face, so the text (and what a screen reader reads) is «3d 9h»
  return <>{m[1]}<span className={s.clockUnit}>d </span><span className={s.clockGroup}>{m[2]}<span className={s.clockUnit}>h</span></span></>
}

/** What a Trupp's clock says — the phone row, every card's first line (RowLine) and the
 *  focus-strip tab all read it here, so no two views of one Trupp ever disagree: a crew inside ticks its own clock (Kontakt under PA, Einsatzzeit on a work
 *  squad), an Atemschutz-Trupp that is out ticks «Draussen seit» in the quiet tone, a work squad
 *  that is out says nothing, and «Nicht eingesetzt» keeps its static Anmeldezeit. */
function collapsedClock(t: Trupp, live: TruppLive): { val: string; sub: string } {
  const az = appConfig.copy.atemschutz
  const out = live.status === 'raus'
  if (!isAtemschutzTrupp(t)) {
    if (out) return { val: '', sub: '' }
    return { val: fmtElapsedFull(t.entryTime ? live.elapsedSec : null), sub: az.elapsed }
  }
  if (out) {
    if (truppNeverDeployed(t)) {
      const reg = truppRegisteredAt(t)
      return reg != null
        ? { val: fmtTime(new Date(reg).toISOString()), sub: az.bandRegisteredAt }
        : { val: '', sub: '' }
    }
    return live.outSec != null ? { val: fmtElapsedFull(live.outSec), sub: az.outFor } : { val: '', sub: '' }
  }
  if (live.status === 'angemeldet') return { val: fmtClock(null), sub: az.elapsed }
  return { val: fmtClock(live.sinceContactSec), sub: az.sinceContact }
}

function TruppRow({
  t, live, alarm, color, canEdit, onContact, onPressure, onOpen, focusNonce, focusScroll = true, flashSeen, onFlashed, lite,
}: {
  t: Trupp; live: TruppLive; now: number; color?: string; canEdit: boolean
  /** the shared tier (lib · truppAlarm) — the SAME number the tone, the chip and the card use */
  alarm: TruppAlarm
  onContact: (id: string) => void
  /** open the PressureSheet for this Trupp — the row's second action since 24.09.2026 */
  onPressure: (id: string) => void
  onOpen: () => void
  focusNonce?: number
  /** ring, but do NOT scroll — the badge marks every alarmed Trupp and only ONE of them may own
   *  the scroll port (see `focusNonceOf`); two smooth scrolls at once land nowhere in particular */
  focusScroll?: boolean
  /** the ring has run its full 1.9s — the board writes the nonce down so a later expand/collapse
   *  REMOUNT of this Trupp does not replay a gesture that already landed (see `focusNonceOf`) */
  onFlashed?: () => void
  /** …and this is where the remount reads it back: true = this nonce already rang here */
  flashSeen?: () => boolean
  /** the handed-over «Tafel pur» (see TruppCard) — only gates plain-Trupp WORDING here
   *  (AtemschutzView · plainWords); the row itself carries no lite-only controls. */
  lite: boolean
}) {
  const az = appConfig.copy.atemschutz
  const status = live.status
  const words = plainWords(t, lite)
  // the same derivations the card makes, so a row and its card never disagree about state
  const inField = t.status === 'aktiv' || t.status === 'rueckzug'
  // forced to 0 off the Atemschutz section — see TruppCard for why no work squad may ever wear
  // one of the alarm tones, whatever a future alarm rule computes for it
  const sev = isAtemschutzTrupp(t) ? alarm.sev : 0
  const monitored = isAtemschutzTrupp(t)
  /* ⚠️ The row says NAME and TIME, nothing else (24.09.2026, maintainer: «drop the blabla, just
   * the time»). The Schätzung line, the state word and the clock caption went: the section
   * heading carries in/ready/out, and the pressure is one tap away on the card. What the row
   * gained is the second action — «Druck» — and words on both buttons, which is why a Trupp inside
   * takes TWO lines on the phone (`.trowTwo`): at 360px a full name, a clock and two worded
   * buttons do not share one.
   * ⚠️ …except the TIER (B5, 08.10.2026): fällig / überfällig / Alarmdruck stand in colour alone,
   * which is no answer in direct sun or to a colour-blind reader. A glyph now sits under the
   * clock (RowLine · tierMark), inside the clock cell: no new row. Glyph only, no word (owner,
   * 09.10.2026: «Symbol only»); the word is in the row's aria-label. */
  const acts = monitored && canEdit && inField
  // ⚠️ «Draussen» and «angemeldet» are NOT one tone. They were both `trowIdle` (blue) while the
  // list still had a «Raus»-Abschnitt to tell them apart — and that section is gone (17.08.), so a
  // spent Trupp now sits between two running ones and has to say so by itself. Grey and dimmed,
  // the same reading the card gives it (.st-raus); blue stays what it means everywhere else on
  // this board: registered, still to come.
  // ⚠️ A Trupp WITHOUT Atemschutz gets the SAME row — same height, same columns, same tap — so a
  // phone board reads as one list rather than two kinds of thing. What differs is only what the
  // row can truthfully say: its clock is the Einsatzzeit, not a contact clock; it carries no
  // Schätzung and no «Kontakt», because there is nothing to check in and no cylinder to run down.
  const tone = rowTone(t, status, sev)
  const tier = tierMark(alarm, sev, true)
  const rowRef = useRef<HTMLButtonElement>(null)
  // A nonce, not a boolean: tapping the same alarm again must replay the pointing gesture.
  // `onFlashed` rides in a ref so its (per-render) identity never restarts the flash effect.
  const onFlashedRef = useRef(onFlashed)
  const flashSeenRef = useRef(flashSeen)
  useEffect(() => { onFlashedRef.current = onFlashed; flashSeenRef.current = flashSeen }, [onFlashed, flashSeen])
  useEffect(() => {
    const el = rowRef.current
    if (focusNonce == null || !el || flashSeenRef.current?.()) return
    if (focusScroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove(s.cardFlash)
    void el.offsetWidth
    el.classList.add(s.cardFlash)
    const timer = window.setTimeout(() => { el.classList.remove(s.cardFlash); onFlashedRef.current?.() }, 1900)
    // ⚠️ the cleanup UNDOES the mark, it does not merely cancel its removal: an interrupted flash
    // (focusNonce changing — or going away — inside the 1.9s window) would otherwise drop the timer
    // and leave the class on. Under prefers-reduced-motion `.cardFlash` is a STATIC ring with no
    // animation to end, so that stuck class is a permanent one.
    return () => { window.clearTimeout(timer); el.classList.remove(s.cardFlash) }
  }, [focusNonce, focusScroll])
  return (
    <button ref={rowRef} type="button" className={cx(s.trow, acts ? s.trowTwo : s.trowOne, tone)} onClick={onOpen}
      aria-label={[t.name, tier?.text, words.status(status === 'raus' ? truppStatusLabel(t) : (az.status[status] ?? status))]
        .filter((w, i, all) => w && all.indexOf(w) === i).join(' — ')}>
      <RowLine t={t} live={live} color={color} lite={lite} tier={tier} />
      {/* ⚠️ always rendered, even when there is no button in it: these are fixed grid tracks, so a
          missing cell would pull every column after it out of line on that one row */}
      <span className={cx(s.trowAct, acts && s.trowActs)}>
        {/* nested: the row itself opens the card, and the two things you must be able to do
            without opening anything are the Druckmeldung and the radio check */}
        {acts && <TruppPair t={t} live={live} sev={sev} nested onPressure={onPressure} onContact={onContact} />}
      </span>
      {/* DOWN, not right: this expands the card in place, it does not navigate anywhere. The
          collapse control it turns into points back up, so the pair reads as one toggle. */}
      <span className={s.trowChevron}><Icon id="chevron-down" /></span>
    </button>
  )
}

/** The phone row's tone (left edge + wash) — the collapsed row's and, since 26.09.2026, the opened
 *  card's too, so a Trupp keeps its colour when it is opened. See TruppRow for why each is what it is. */
function rowTone(t: Trupp, status: TruppLive['status'], sev: number): string {
  const inField = t.status === 'aktiv' || t.status === 'rueckzug'
  if (!isAtemschutzTrupp(t)) return status === 'raus' ? s.trowOut : status === 'angemeldet' ? s.trowIdle : s.trowPlain
  return sev >= 2 ? s.trowCrit : sev === 1 ? s.trowWarn : inField ? '' : status === 'raus' ? s.trowOut : s.trowIdle
}

/** The phone row's first line — dot · name, and the clock — drawn by the collapsed row AND by the
 *  opened card's head (26.09.2026, owner: «keep the same UI whether the card is collapsed or
 *  not»). One drawing, so opening a Trupp never moves, resizes or recolours the line the thumb
 *  just pressed; the chevron beside it is the caller's, because it points the other way. */
function RowLine({ t, live, color, lite, tier }: { t: Trupp; live: TruppLive; color?: string; lite: boolean
  /** the tier as glyph + word under the clock (tierMark) — null/absent while silent */
  tier?: TierMark | null
}) {
  const az = appConfig.copy.atemschutz
  const words = plainWords(t, lite)
  const team = (t.members ?? []).filter(Boolean).join(' / ')
  const clock = collapsedClock(t, live)
  // ⚠️ Defence in depth: `collapsedClock`'s own `!isAtemschutzTrupp` branch already returns an
  // empty sub for a plain Trupp that is out (it has no break clock to show — see the function's
  // doc comment), so this swap is a no-op today. It stays here so a future edit to that branch
  // cannot silently leak «Draussen seit» onto a work squad's row without also failing the app-only
  // wording test below.
  const clockSub = clock.sub === az.outFor ? words.outFor : clock.sub
  return (
    <>
      <span className={s.trowId}>
        <span className={s.trowName}>
          {/* no colour, no dot: the handed-over Tafel never shows the Lage, so a Truppfarbe there
              carries no identity (round 2 review) — and an empty 11px slot would indent the name */}
          {color && <span className={s.trowDot} style={{ background: color }} />}
          <span className={s.trowNameTxt}>{truppHeadName(t)}</span>
          {/* ⚠️ Name only — no «#N», no «SiTr», on the row AND the opened card (owner, staging
              26.09. and 30.09.2026: «the group leader name needs more space … drop the number #»).
              The number stays in the TruppFinder and in the Verlauf's «Trupp N» rows. */}
        </span>
        {team && <span className={s.trowTeam}>{team}</span>}
      </span>
      {/* one derivation with the card's band (collapsedClock) — the row used to freeze a work
          squad's Einsatzzeit after the exit and show «–:––» for an out crew's break clock */}
      <span className={s.trowClock}>
        <span className={s.trowClockVal}><ClockVal val={clock.val} /></span>
        <span className={s.trowSub}>{clockSub}</span>
        {/* the glyph only (owner, 09.10.2026: «Symbol only»); aria-hidden because the row's own
            aria-label and the card's status line already speak the word, and the title shows it
            on hover */}
        {tier && (
          <span className={cx(s.trowTier, tier.crit && s.trowTierCrit)} aria-hidden title={tier.text}>
            <Icon id={tier.icon} />
          </span>
        )}
      </span>
    </>
  )
}

/** The tier as a GLYPH, not colour alone (B5, 08.10.2026: sunlight, colour-blind). A different
 *  glyph per tier, so the SHAPE tells them apart: the clock for «Fällig» (the radio check is due),
 *  the warning triangle for «Überfällig» and for the Alarmdruck. Only the glyph is drawn (owner,
 *  09.10.2026: «Symbol only»); `text` is the word for the row's aria-label and the hover title,
 *  and a pressure alarm never says «Überfällig» (see `TruppAlarm.reason`). `withPressure` false
 *  where the caller says the Alarmdruck in words already (the card's state line, with its limit). */
interface TierMark { icon: string; text: string; crit: boolean }
function tierMark(alarm: TruppAlarm, sev: number, withPressure: boolean): TierMark | null {
  const az = appConfig.copy.atemschutz
  if (sev <= 0) return null
  if (alarm.reason === 'pressure') return withPressure ? { icon: 'warn', text: az.clockAlarmPressure, crit: true } : null
  return sev >= 2 ? { icon: 'warn', text: az.clockOverdue, crit: true } : { icon: 'clock', text: az.rowDue, crit: false }
}

/** «⌓ 240 bar» | «Kontakt» — the two things a Trupp inside needs from the phone board, drawn ONCE
 *  for the collapsed row and the opened card (26.09.2026): same tiles, same sizes, same colours,
 *  same place, so opening a Trupp only ADDS what stands below them. The pressure tile carries the
 *  last reported bar behind the Manometer glyph (red at or under this Trupp's line) — it is the one
 *  number the band used to show beside it, and on the row it answers «how much air» without
 *  opening. ⚠️ No word «Druck» on it since the slim-down (26.09.2026 evening, owner's screenshot):
 *  «unit, verb, value» — a number with its unit behind a gauge IS the pressure, and the word only
 *  made the tile wider than its neighbour. The word stays its accessible name.
 *  `nested`: inside the row's own button a <button> may not stand, so there they are spans with
 *  the button role, and a tap on them does not also open the card. */
function TruppPair({ t, live, sev, nested = false, onPressure, onContact }: {
  t: Trupp; live: TruppLive
  /** the shared tier — the Kontakt colour, identical on the row and on the card */
  sev: number
  nested?: boolean
  onPressure: (id: string) => void
  onContact: (id: string) => void
}) {
  const az = appConfig.copy.atemschutz
  const low = pressureAlarm(live.currentBar, alarmBarFor(t, atemschutzDoctrine()))
  const pressCls = cx(s.kontaktBtn, s.trowPressBtn)
  const kontaktCls = cx(s.kontaktBtn, s.trowKontakt, sev === 1 && s.kontaktWarn, sev >= 2 && s.kontaktCrit)
  const press = <><Icon id="manometer" /><b className={cx(s.pairBar, low && s.pairBarLow)}>{live.currentBar} bar</b></>
  // the spoken name keeps the word the tile dropped («Druck 240 bar»)
  const pressName = `${az.actPressure} ${live.currentBar} bar`
  const kontakt = <><Icon id="radio" /><span>{az.actContact}</span></>
  if (!nested) {
    return (
      <div className={s.trowActs}>
        <button type="button" className={pressCls} aria-label={pressName} onClick={() => onPressure(t.id)}>{press}</button>
        <button type="button" className={kontaktCls} onClick={() => onContact(t.id)}>{kontakt}</button>
      </div>
    )
  }
  const act = (fn: (id: string) => void) => ({
    role: 'button', tabIndex: 0,
    onClick: (e: MouseEvent) => { e.stopPropagation(); fn(t.id) },
    onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); fn(t.id) } },
  })
  return (
    <>
      <span className={pressCls} aria-label={pressName} {...act(onPressure)}>{press}</span>
      <span className={kontaktCls} {...act(onContact)}>{kontakt}</span>
    </>
  )
}

/**
 * One Trupp as a card — ONE arrangement, at every width and on every board (03.09.), and since
 * 29.09.2026 ONE DRAWING too: the phone's opened row is the card everywhere.
 *
 * There used to be three drawings of this object: this card, `cardBig` for the handed-over phone
 * board, and `PlainTruppRow` for a Trupp without Atemschutz. Three drawings of one thing drift
 * apart, and these had begun to. This is the card; what varies is only what a Trupp actually HAS.
 *
 * ⚠️ The tablet grid wore its own card until 29.09.2026 (owner: «for the trupps things you can
 * assimilate the tablet / desktop view closer / equal to the mobile view»): a head with the ⋯,
 * a grey Kennzeile sentence with a blue Auftrag, a framed band with the clock in 40px, a
 * full-width Kontakt, a ± Druck stepper with its own Bestätigen, a loud amber «Rückzug melden»
 * beside a ghost «Raus melden», and a Sockel line over a «Verlauf · zuletzt: 11:52 Druck 300 bar»
 * preview — the bar said three times on one card. The phone had slimmed all of that away on
 * 26./27.09. and the owner reviewed that version, so it is the reference and the tablet takes it
 * whole, top to bottom:
 *
 *   1 line       dot · name · #N · the clock (RowLine) — the collapse toggle on the phone board
 *   2 tiles      «⌓ 240 bar | Kontakt» (TruppPair), then Rückzug | Raus in the same tile shape
 *   3 state      the tier in words where colour alone would say it (`stateLine`)
 *   4 Hinweis    the Alarmdruck note, for the case where only the projection has crossed
 *   5 facts      crew · Auftrag · Kanal … as chips, each the door to its sheet (the ⋯ ends the foot)
 *   6 foot       Einsatzzeit · Schätzung, the whole line the Verlauf's toggle
 *
 * What the tablet keeps because it has the room: every card open at once in a grid (the phone
 * opens one row at a time because a card is taller than its port), the hand-set order with ‹ ›
 * in the ⋯ (the phone board is arranged by urgency and has none), and its cards' own state words
 * (`headed`: the phone's section heads say Drin / Bereit / Draussen, the grid has no such heads).
 * The Druck is the same `PressureSheet` everywhere — 20-bar steps, a tap saves.
 *
 * ⚠️ In the lifecycle tiles the order is the order the Einsatz runs: Rückzug, then Raus.
 *
 * ⚠️ The secondary controls are a MENU with words, not a row of glyphs. Every one of them
 * already had a German name that only ever surfaced in a `title`: «Platzieren», «Leitung
 * wählen», «Nach oben holen». That a footprint means «platzieren» and a droplet means
 * «Leitung» is exactly the knowledge that is gone after six months without practice.
 */
function TruppCard({
  t, live, alarm, now, color, canEdit, intervalMin, frozen = false, focusNonce, focusScroll = true, flashSeen, onFlashed, onContact, onStatus, onStandDown, onAskExit, onAskPressure, onEdit, onQuick, onReenter, onDelete, onPlace, onShowPlan, onMove, onShowLine, hasLine, drawnLineNo, dockedAt, onCollapse, headed = false, lite = false, onNotfall, onNotfallEnd,
}: {
  /** the held «Notfall» on a crew inside, and the held «Notfall beendet» on a crew in one (F1,
   *  AtemschutzNotfall · NotfallHold). Absent for a viewer and on a closed Einsatz. */
  onNotfall?: () => void
  onNotfallEnd?: () => void
  /** the mini sheets (26.09.2026 — components/TruppSheets): a tap on the Kanal opens the Kanal
   *  sheet, a tap on the Auftrag / Ziel / a missing Auftrag the Auftrag sheet, a tap on the crew or
   *  the Ausrüstung the Trupp sheet. Absent for a viewer. */
  onQuick?: (kind: 'kanal' | 'auftrag' | 'trupp') => void
  t: Trupp; live: TruppLive; now: number; canEdit: boolean
  /** the shared tier (lib · truppAlarm) — the SAME number the tone, the chip and the row use */
  alarm: TruppAlarm
  /** the Funkkontakt-Intervall (min) — the Verlauf's timing head names the next due time */
  intervalMin: number
  /** the Einsatz is closed: the clock stands at the close and the band says so (R3) */
  frozen?: boolean
  /** the colour this Trupp wears on the Lage / plan (useTruppActions · truppColors) — set for
   *  every Trupp, automatic ones included */
  color?: string
  onContact: (id: string) => void
  onStatus: (id: string, status: Trupp['status']) => void
  /** «Nicht eingesetzt» — the stand-down of a Trupp that never went in, with its undo toast */
  onStandDown: (id: string) => void
  /** «Raus melden» asks the Restdruck first (PressureSheet) — absent = straight out, as before */
  onAskExit?: (id: string) => void
  /** the pressure tile's door: the PressureSheet (24.09.2026 on the phone, every board since
   *  29.09.2026 — the tablet's inline ± stepper is gone) */
  onAskPressure?: (id: string) => void
  /** the board's own section heads name the lifecycle state (the phone board's Drin / Bereit /
   *  Draussen) — then the card does not say «Bereit» / «Draussen» a second time. The tablet grid
   *  and the handed-over Tafel have no such heads, so their cards do. */
  headed?: boolean
  /** this is the card somebody was just sent to — scroll it under their eyes and mark it */
  focusNonce?: number
  /** ring, but do NOT scroll — the header badge marks every alarmed Trupp and only ONE of them
   *  may own the scroll port (see `focusNonceOf`) */
  focusScroll?: boolean
  /** see TruppRow — the completed ring reports back so a remount does not replay it */
  onFlashed?: () => void
  flashSeen?: () => boolean
  onEdit: (focus?: 'auftrag') => void
  onReenter: () => void
  onDelete: (id: string) => void
  /** present only while the hand-set order is the one on screen (see AtemschutzView) */
  onMove?: (id: string, dir: -1 | 1) => void
  onPlace: (id: string) => void
  onShowPlan: (id: string) => void
  /** jump to the drawn Leitung (Lage or Plan) — the counterpart of «auf Plan zeigen» */
  onShowLine: (id: string) => void
  /** is there actually a hose drawn for this Trupp? Decides whether the chip is a jump or plain
   *  text — a button that goes nowhere is worse than no button. */
  hasLine: boolean
  /** the symbol the Trupp's marker is docked to («bei «Hydrant»») – see AtemschutzView.dockedAt */
  dockedAt?: string
  /** the number the Trupp's drawn hose carries right now — wins over the stored copy */
  drawnLineNo?: number
  /** set only on the phone board, where this card was opened from a row — collapses back to it:
   *  the card's first line is then the toggle, with the chevron in the pixel that opened it */
  onCollapse?: () => void
  /** the handed-over «Tafel pur» (see AtemschutzView · lite): drop every control that points at
   *  a surface this session cannot reach — Platzieren, auf Plan zeigen, Leitung zeigen,
   *  and the board-order rows. Kontakt, Druck, Rückzug, Draussen, Bearbeiten and Entfernen all
   *  stay: they are what the board was handed over FOR. */
  lite?: boolean
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  const status = live.status
  /* A Trupp WITHOUT Atemschutz has no contact clock, no Druck and no Schätzung. It gets this same
   * card with those zones empty — and never a tint, never an alarm colour, never a «Kontakt»
   * button. That restraint is the statement: nothing on it may look like something being
   * monitored. What it does have — who, what, where, how long — sits exactly where the monitored
   * card carries the same facts, so the two read as one board rather than two. */
  const monitored = isAtemschutzTrupp(t)
  const words = plainWords(t, lite)
  // «Draussen» on a Trupp that never went under PA claims it came out of something. Only that
  // one word differs — the state, the section and the actions are the same (truppNeverDeployed).
  // ⚠️ `words.status` swaps ONLY the plain «Draussen» result, app-side, into «Ohne Auftrag» —
  // see `plainWords`.
  const statusLabel = words.status(status === 'raus' ? truppStatusLabel(t) : (az.status[status] ?? status))
  const [logOpen, setLogOpen] = useState(false)
  // ⚠️ The jump has to LAND. Switching to the Überwachung and leaving a wall of cards was the
  // complaint: on a long list the Trupp somebody was sent to was off-screen, so the answer to
  // «why can I not tick this person» was still a search. The nonce replays both scroll and ring
  // when the same notification is tapped again while this card remains mounted.
  const cardRef = useRef<HTMLDivElement>(null)
  // `onFlashed` rides in a ref so its (per-render) identity never restarts the flash effect.
  const onFlashedRef = useRef(onFlashed)
  const flashSeenRef = useRef(flashSeen)
  useEffect(() => { onFlashedRef.current = onFlashed; flashSeenRef.current = flashSeen }, [onFlashed, flashSeen])
  useEffect(() => {
    const el = cardRef.current
    if (focusNonce == null || !el || flashSeenRef.current?.()) return
    if (focusScroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove(s.cardFlash)
    void el.offsetWidth
    el.classList.add(s.cardFlash)
    const timer = window.setTimeout(() => { el.classList.remove(s.cardFlash); onFlashedRef.current?.() }, 1900)
    // ⚠️ same as TruppRow: the cleanup must REMOVE the class, not just clear the timer. A flash cut
    // short (focusNonce changing or clearing inside the 1.9s window) otherwise leaves the mark on
    // the card for good — visibly so under prefers-reduced-motion, where `.cardFlash` is a static
    // ring rather than an animation that ends by itself.
    return () => { window.clearTimeout(timer); el.classList.remove(s.cardFlash) }
  }, [focusNonce, focusScroll])
  const inField = t.status === 'aktiv' || t.status === 'rueckzug'
  const auftrag = truppAuftragLabel(t.auftrag)
  // ⚠️ forced to 0 off the Atemschutz section rather than trusted from `alarm`: every tint, every
  // border and every button colour on this card keys off `sev`, and a work squad must never be
  // able to wear one of them, whatever a future alarm rule decides to compute for it.
  const sev = monitored ? alarm.sev : 0
  const dz = atemschutzDoctrine()
  // Planungshilfe: measured consumption history wins; the configured assumption is used only
  // until enough confirmed Druck values exist. It never replaces a reading or drives an alarm.
  const estimate = monitored && inField ? estimatePressure(t, now, dz.cylinderLiters, dz.estConsumptionLPerMin) : null
  const readings = t.readings ?? []
  // Alarmdruck – EITHER the logged Druck or the expected-pressure Schätzung is enough. Air burns
  // down between radio checks, so a reading that still looked fine at the last Kontakt is exactly
  // how a Trupp slips past its turn-back pressure unnoticed. Visual only: the contact clock stays
  // the single audible alarm (see lib/atemschutz).
  // …against THIS Trupp's line: in Rückzug it is the lower one (lib/atemschutz · alarmBarFor)
  const line = alarmBarFor(t, dz)
  const pressureLow = monitored && pressureAlarm(live.currentBar, line)
  const estimateLow = pressureAlarm(estimate?.bar ?? null, line)
  /* The MEASURED crossing is the alarm and it lives in the band above, where the card's loudest
   * element is. This strip is what is left: the case where only the PROJECTION has crossed — a
   * Planungshilfe, which must never look like a logged reading and must never raise the tier
   * (lib/atemschutz · truppAlarm). */
  const airNote = monitored && inField && estimateLow && !pressureLow
    ? fillTemplate(az.alarmNoteEst, { bar: line })
    : null


  /* The state words (29.09.2026: there is no band any more, on any board — see the zone list
   * above). The clock stands on the card's first line, its colour and the Kontakt tile's carry the
   * tier, and what colour may never carry ALONE is said in words, once, under the tiles. */
  const pressureCrit = monitored && alarm.reason === 'pressure'
  const preEntry = status === 'angemeldet'
  /* ⚠️ «Draussen» does NOT get a contact word. A Trupp that has come out has no running clock
     (deriveTruppLive) and no tier; its first line carries the break clock in the quiet tone
     (RowLine · collapsedClock, `.trowOut`) — for ATEMSCHUTZ only: a crew that has been under PA
     cannot go back in until it has rested, so «wie lange ist der schon draussen» is the next
     operational question about it. A work squad has no such rule and no clock stands there. */
  const out = status === 'raus'
  /* ⚠️ «Nicht eingesetzt» gets NO running clock (04.09.): a Sicherungstrupp stood down without
     ever going under PA shows the moment it was announced, a TIME that does not tick
     (collapsedClock · truppRegisteredAt), and its state line says «Nicht eingesetzt». */
  const neverDeployed = out && truppNeverDeployed(t)

  /* What the band said in WORDS — the tier as text, which colour may never carry alone — is ONE
   * line directly under the tiles (`stateLine`; 26.09.2026 on the phone, every board since
   * 29.09.2026), and only where there is something to say: fällig / überfällig / Alarmdruck, the
   * stopped clock of a closed Einsatz, «Nicht eingesetzt» (the one out state the «Draussen»
   * heading cannot say), and a work squad's state (its section has no state headings).
   * «Kontakt ok» says nothing the green does not, and «Rückzug» is a fact chip of its own.
   * ⚠️ On a board WITHOUT state heads (`!headed`: the tablet grid, the handed-over Tafel) the card
   * also says «Bereit» and «Draussen» in the quiet tone — on the phone those are the section it
   * stands in, and there they would be the same word twice. */
  const rowMode = !!onCollapse
  /* ⚠️ 29.09.2026 (owner on staging): «drop the überfällig – if the card is red it's pretty obvious»,
   * and «the draussen subtitle is probably not even required». So fällig / überfällig are not a
   * state LINE: since B5 (08.10.2026) they are a glyph under the clock on the card's first
   * line (RowLine · tierMark), so colour is not the only carrier, and this line stays
   * for a screen reader only (`hidden`). An out Trupp's «Draussen» goes on every board — its card
   * is the grey one with «Wieder in den Einsatz» on it. What stays in words is what colour cannot
   * carry: the Alarmdruck with its limit, the stopped clock, «Nicht eingesetzt», «Bereit», a work
   * squad's state. */
  const rowWord: { text: string; tone?: string; hidden?: boolean } | null = !monitored ? { text: statusLabel, tone: s.kennQuiet }
    // the Notfall in words, with the moment it was raised — red is not enough to say «Notfall» (F1)
    : alarm.reason === 'notfall' && t.notfallAt ? { text: fillTemplate(az.notfall.stateWord, { time: fmtTime(t.notfallAt) }), tone: s.kennCrit }
    : out ? (neverDeployed ? { text: statusLabel, tone: s.kennQuiet } : null)
    : preEntry ? (headed ? null : { text: az.phoneSectionReady, tone: s.kennQuiet })
    : frozen ? { text: az.clockFrozen, tone: s.kennQuiet }
    : pressureCrit ? { text: `${az.clockAlarmPressure} · ${fillTemplate(az.clockAlarmLimit, { bar: line })}`, tone: s.kennCrit }
    : sev >= 2 ? { text: az.clockOverdue, hidden: true }
    : sev === 1 ? { text: az.clockWarn, hidden: true }
    : null

  // The Leitung chip: the numeric field, else the free text an older record still carries. Shown
  // as typed either way — an incident is a legal record, so nothing rewrites what was entered.
  // ⚠️ The DRAWN hose's number wins over the Trupp's stored copy: renumbering the Leitung in the
  // picture used to leave this chip saying «Ltg 1» beside a hose tagged «Ltg 3» (19.08.). The
  // copy stays the fallback — a Trupp whose hose was deleted keeps the number it worked on —
  // and an older record's free-text designation is still never rewritten.
  const lineTag = drawnLineNo != null ? String(drawnLineNo)
    : t.lineNo != null ? String(t.lineNo) : t.lineNumber?.trim()

  // «Raus» happens immediately, no blocking dialog. The way back is the global ↶ pair (the
  // undo lives in the action, setTruppStatus, so it restores the full pre-raus Trupp — status
  // + clocks — not just re-open a dead-ended card).
  // ⚠️ …except for ONE question on a crew under Atemschutz: its Restdruck (24.09.2026). On 23.09.
  // there was nowhere to put it, so it went into «Eingangsdruck korrigieren» and the Rapport
  // printed entries of 60 and 180 bar. The sheet saves on the tap of a number, and «Ohne Druck
  // raus» is its own button, so the exit still costs one more tap at most and never blocks.
  const askExit = () => (monitored && onAskExit ? onAskExit(t.id) : onStatus(t.id, 'raus'))
  // delete-now, no blocking dialog and — since 09.09. — no Rückgängig toast either: the board
  // raised a pill over itself for every action, and the steady popping read as noise. The two
  // doors back are the global ↶ pair (deleteTrupp registers there) and the non-expiring
  // «Entfernte Trupps» menu; both restore the full record, only the plan/map placement is gone.
  // ONE ask since 11.09. (field wish): an angemeldeter Atemschutz-Trupp that never went in is
  // offered «nicht eingesetzt» first — the honest close-out for a Sicherungstrupp that stood
  // ready (the same stand-down the card's «Nicht eingesetzt» action performs, same gate:
  // preEntry && monitored, so it logs and prints as one). «Entfernen» stays a button away for
  // the erroneous Anmeldung; dismissing does nothing.
  const doDelete = async () => {
    // a Trupp in a Notfall leaves the board only after «Notfall beendet» (useTruppActions · deleteTrupp)
    if (truppInNotfall(t)) { toast(az.notfall.removeBlocked, { icon: 'warn', tone: 'warn' }); return }
    /* ⚠️ A crew that is INSIDE is asked about first (staging walk-through 25.09.2026, N4): one tap
       on «Entfernen» took a crew under PA off the board and out of every alarm, with no question.
       What the operator almost always means is «they are out» — so «Raus melden» is the filled,
       focused answer, and removing them anyway is the quiet one. */
    if (inField) {
      const a = await confirmDialog({
        title: fillTemplate(az.removeInsideTitle, { name: t.no != null ? `${t.no}` : t.name }),
        message: az.removeInsideMsg,
        confirmLabel: az.remove,
        altLabel: words.exit,
        cancelLabel: az.cancel,
        safeAnswer: 'alt',
      })
      if (a === 'alt') { askExit(); return }
      if (a !== true) return
      onDelete(t.id)
      return
    }
    if (preEntry && monitored) {
      const a = await confirmDialog({
        title: az.removeUnusedTitle,
        message: fillTemplate(az.removeUnusedMsg, { name: t.name }),
        confirmLabel: az.actNotDeployed,
        altLabel: az.remove,
        altDanger: true,
      })
      if (a === true) { onStandDown(t.id); return }
      if (a !== 'alt') return
    }
    onDelete(t.id)
  }

  /* ── the ⋯ menu ────────────────────────────────────────────────────────────────────────────
   * The same conditions the four icon buttons carried, now as sentences. Two of them are PAIRS
   * that used to share one glyph and mean opposite things depending on state — nothing placed
   * yet ⇒ put it down, placed ⇒ go there — which is precisely the kind of thing an icon cannot
   * say and a word says for free.
   *
   * «Entfernen» is last, behind a rule, and red. */
  /* ⚠️ «Bearbeiten» in EVERY status, `raus` included (09.09., Feldentscheid). The other two
   * gates below act on a LIVE deployment — placing a symbol for a crew that has come out, or
   * handing it a hose — and keep theirs. This one edits the RECORD, and the record is exactly
   * what stays wrong otherwise: a crew member never entered, a typo in the Auftrag, the wrong
   * Gruppenführer — all of it prints on the Rapport, and the Trupp is `raus` by the time
   * anybody reads it back. Correcting an Eingangsdruck here rewrites the finished run's entry
   * reading, which is the point (useTruppActions · editTrupp · pressurePatch, and the form
   * says so under the field). Everything it writes reaches the Verlauf exactly as a live edit
   * does — one `logEditFields` row naming what changed.
   * ⚠️ On the PHONE it is the LAST resort, not the first row (26.09.2026, phone card slim-down ⑤):
   * every fact the form edits has its own chip and sheet on that card — the crew, the Auftrag,
   * the Ziel, the Leitung, the Kanal, the Ausrüstung — so the form is left for what has no sheet,
   * the Art and the Eingangsdruck-Korrektur. It stands after the jumps,
   * above the rule that separates the closing actions — on the tablet too since 29.09.2026, which
   * wears the same chips (it kept «Bearbeiten» first while its Kennzeile was a sentence). */
  const editItem = canEdit ? [{ label: az.edit, onClick: () => onEdit() }] : []
  const menuItems = [
    ...(lite ? [] : (t.annoId || t.entityId)
      ? [{ label: t.entityId ? az.showOnMap : az.showOnPlan, onClick: () => onShowPlan(t.id) }]
      : canEdit && status !== 'raus' ? [{ label: az.place, onClick: () => onPlace(t.id) }] : []),
    // «Leitung wählen» (tap a hose on the Karte) is gone (15.09.): a Leitung is joined from the
    // form's Ltg-Nr. quick-picks, from the line's own editor, or by snapping a hose end to the
    // Trupp's marker – never from an armed, invisible tap mode.
    ...(lite || !hasLine ? [] : [{ label: az.lineShow, onClick: () => onShowLine(t.id) }]),
    ...editItem,
    // Only while the hand-set order is the one on screen: moving a card under any other sort
    // would rearrange something the sort is about to rearrange back.
    ...(onMove && canEdit && !lite ? [
      { kind: 'sep' as const },
      { label: az.moveBack, onClick: () => onMove(t.id, -1) },
      { label: az.moveForward, onClick: () => onMove(t.id, 1) },
    ] : []),
    /* («Nicht eingesetzt» is a visible button on its own row again — see the Aktionen zone; the
     * ⋮ no longer carries it, owner review 26.09.2026.) */
    ...(canEdit ? [{ kind: 'sep' as const }, { label: az.remove, onClick: doDelete, danger: true }] : []),
  // ⚠️ a separator may never LEAD. On a Trupp that has come out and was never placed, every row
  // above «Entfernen» is withheld and the menu opened on a bare rule.
  ].filter((it, i, all) => !('kind' in it && it.kind === 'sep') || all.slice(0, i).some((p) => !('kind' in p)))

  const crewNames = t.members?.filter(Boolean) ?? []
  const crew = crewNames.join(' · ')
  /** the Ausrüstung as Kürzel (copy · equipmentShort), in the order it was recorded; an id
   *  without a Kürzel prints the word the Rapport prints (lib/report · truppEquipmentLabels) */
  const equipmentTags = (t.equipment ?? []).map((id) => ({ id, tag: az.equipmentShort[id] ?? truppEquipmentLabels([id])[0] ?? id }))

  /* ── The one line the Sockel leaves standing (09.09.) ──────────────────────────────────────
   * See the markup at «6 + 7» below for what folded and why. This is the part that may not:
   * the two clocks-and-numbers somebody reads WHILE a Trupp is inside, in one compact,
   * label-and-value line instead of four stacked rows.
   * ⚠️ The aktueller Druck joins it only where the pressure tile is NOT showing it. That is not
   * a saving, it is the guard on one: hiding a viewer's only pressure readout behind a chevron
   * would make this pass cost exactly the kind of number it exists to keep in view.
   * ⚠️ Built as data rather than markup so the separators are the LINE's business (CSS), not
   * four call sites each remembering to print a «·» — and so «what stays out» is one list to
   * read when somebody asks that question again. */
  const sockelLine: { key: string; label: string; value: string; alarm?: boolean; labelled?: boolean; title?: string }[] = [
    ...(monitored && t.entryTime
      // a DURATION that says so — «23:39» read at 23:58 was taken for a clock time (staging r4)
      ? [{ key: 'elapsed', label: az.elapsed, value: fmtDuration(live.elapsedSec) }] : []),
    ...(live.outSec != null && !out
      ? [{ key: 'out', label: words.outFor, value: fmtDuration(live.outSec), labelled: true }] : []),
    ...(monitored && !(canEdit && inField)
      ? [{ key: 'bar', label: az.currentPressure, value: `${live.currentBar} bar`, alarm: pressureLow }] : []),
    ...(estimate
      ? [{
        key: 'est',
        label: az.estimatedShort,
        value: `≈ ${estimate.bar} bar`,
        alarm: estimateLow,
        // …and it keeps its WORD on the terse line (29.09.2026): on a line that can also carry a
        // MEASURED «240 bar», an unnamed «≈ 0 bar» is exactly the mix-up this guards against — the
        // word does it now, not a dimmed grey that also made the number easy to read past
        labelled: true,
        // the Planungshilfe caveat travels with the number, exactly as it did on the old row
        title: estimate.source === 'history'
          ? az.estimatedHintHistory
          : fillTemplate(az.estimatedHint, { liters: dz.cylinderLiters, rate: dz.estConsumptionLPerMin }),
      }] : []),
  ]
  /* ⚠️ A Trupp WITHOUT Atemschutz has no cylinder, so every row of its log carries a bar of 0 —
   * the `entryPressureBar` a work squad was never asked for (useTruppActions · createTrupp). The
   * Verlauf printed «Eingerückt 0 bar» on a card that otherwise says nothing about pressure at
   * all, which reads as a measurement rather than as the absence of one. The Rapport already
   * leaves these Trupps off the Atemschutz page for exactly this reason (lib/reportPdfDirect);
   * the board now says as little about their Druck as the paper does. The rows themselves stay:
   * angemeldet / eingerückt / draussen is this Trupp's chronology and the log is the record.
   * ⚠️ The zero check inside `readingBarShown` is what carries this after an UPGRADE: those same
   * 0-bar rows survive into a Trupp that IS monitored now, where `monitored` no longer hides
   * them (useTruppActions · editTrupp · kindPatch). */
  const barShown = (r: Pick<TruppReading, 'kind' | 'bar' | 'measured'>) => monitored && readingBarShown(r)
  /**
   * What a reading row is CALLED — «Eingerückt», and on a Trupp without Atemschutz «Eingerückt –
   * ohne Atemschutz» (04.09., Feldtest Manuel: «Atemschutz beendet» and then a bare «Eingerückt»
   * left the reader unable to say what had gone in).
   *
   * ⚠️ The ENTRY row only, and by the Trupp's CURRENT Art. The same two decisions the Verlauf
   * line makes (copy · atemschutz.logEntryNoAs, readingNoAs): every row would be wallpaper, and a
   * Trupp whose Art was changed mid-run carries `paOn`/`paOff` rows right there in this list,
   * which say it more precisely than a re-labelled Eintritt could.
   */
  const readingLabel = (r: Pick<TruppReading, 'kind' | 'crew'>, idx: number) => {
    // a crew row IS its names — «Meier Anna / Frei Nina» says who the Trupp was from then on
    if (r.kind === 'crew' && r.crew) return [r.crew.name, ...r.crew.members].map((n) => n.trim()).filter(Boolean).join(' / ')
    // …and the close of a run that never went in is «Nicht eingesetzt», never an «Austritt» (N8)
    if (isStandDownExit(readings, idx)) return az.statusNotDeployed
    const what = az.readingKind[r.kind] ?? r.kind
    return !monitored && r.kind === 'entry' ? fillTemplate(az.readingNoAs, { what }) : what
  }
  // the folded timing rows: they were a tap ZONE on the clock itself, findable only by knowing
  // that five grey characters at the band's edge meant «tap me». They are now the head of the
  // Verlauf, behind a word — and the band went back to being a display, not a button.
  const timesShown = monitored && live.sinceContactSec != null
  const lastContactAt = live.sinceContactSec != null ? now - live.sinceContactSec * 1000 : null
  const hm = (ms: number) => fmtTime(new Date(ms).toISOString())
  /* The two conditional groups of the opened Verlauf's look-up panel, named here so the markup
   * below can ask ONE question per row and the panel itself can ask «is there anything at all».
   * ⚠️ `lowestShown` is deliberately narrow: the tiefster Druck is only a fact of its own once
   * the Trupp has come back UP (a fresh bottle after «Wieder in den Einsatz»). While it is still
   * descending, `lowestBar === currentBar` and the row would restate the number the card already
   * shows in 19px mono. */
  const lowestShown = monitored && live.lowestBar < live.currentBar
  const timingShown = timesShown && lastContactAt != null && !lite

  const menu = menuItems.length > 0 && (
    <Menu
      trigger={
        <button type="button" className={s.footMore} aria-label={az.cardMenu} title={az.cardMenu}>
          <Icon id="more" />
        </button>
      }
      popupClassName="rp-print-menu"
      itemClassName={() => 'rp-print-menu-item'}
      items={menuItems}
    />
  )
  /* ── The facts as CHIPS (26.09.2026 evening, phone card slim-down, ③; every board 29.09.2026) ──
   * The entries the tablet's grey Kennzeile sentence carried until 29.09.2026 («Meier Anna· Löschen·
   * 2. OG· Kanal 11», its Auftrag in blue), each a 36px chip with one 1px edge and no colour of
   * its own — a strip of things to TAP, where the sentence was a line to read: the crew → Trupp
   * sheet, «Löschen · Test» → Auftrag sheet, «Kanal 11» → Kanal sheet, «Ltg 1» → the drawn hose
   * (else the Auftrag sheet), the Ausrüstung → Trupp sheet (the ⋯ moved to the foot line on 29.09.2026). The one
   * thing allowed a colour is the GAP: a dashed amber «+ Auftrag» where the Auftrag is missing —
   * a Trupp with no job is a question the Überwacher must be able to see. No chip for a missing
   * Leitung (it lives in the Auftrag sheet), no small-caps labels, no «#N» (that is on the head).
   * `chip(key, node, onTap, cls)`: a button when it has somewhere to go, a plain chip otherwise
   * (a viewer's card, the lite board's jumps).
   * ⚠️ «Rückzug» leads as a FACT, and it is not a tier: a Trupp on its way out with a calm clock
   * shows no state word, and for a viewer — who has no Rückzug tile — this chip is the only thing
   * saying so. It also lowers the turn-back pressure (alarmBarFor), so it is never colour alone. */
  const chip = (key: string, node: ReactNode, onTap?: () => void, cls?: string) => onTap
    ? <button key={key} type="button" className={cx(s.fact, cls)} onClick={onTap}>{node}</button>
    : <span key={key} className={cx(s.fact, cls)}>{node}</span>
  const facts = (
    <div className={s.facts}>
      {monitored && status === 'rueckzug' && chip('state', statusLabel, undefined, s.factState)}
      {!!crewNames.length && chip('crew', <span className={s.factTxt}>{crew}</span>, onQuick && (() => onQuick('trupp')))}
      {auftrag
        ? chip('auftrag', <span className={s.factTxt}>{auftrag}{t.ziel ? ` · ${t.ziel}` : ''}</span>, onQuick && (() => onQuick('auftrag')))
        : <>
            {chip('auftrag', az.auftragAdd, () => (onQuick ? onQuick('auftrag') : onEdit('auftrag')), s.factDash)}
            {t.ziel && chip('ziel', <span className={s.factTxt}>{t.ziel}</span>, onQuick && (() => onQuick('auftrag')))}
          </>}
      {dockedAt && chip('docked', <>{fillTemplate(az.dockedAt, { host: dockedAt })}{!lite && <Icon id="chevron" />}</>,
        lite ? undefined : () => onShowPlan(t.id), s.factGo)}
      {lineTag && chip('line', <>{fillTemplate(az.lineChip, { n: lineTag })}{hasLine && !lite && <Icon id="chevron" />}</>,
        hasLine && !lite ? () => onShowLine(t.id) : onQuick && (() => onQuick('auftrag')), hasLine && !lite ? s.factGo : undefined)}
      {t.funkkanal != null && chip('kanal', `${az.funkkanalUnit} ${t.funkkanal}`, onQuick && (() => onQuick('kanal')))}
      {equipmentTags.map(({ id, tag }) => chip(`eq-${id}`, tag, onQuick && (() => onQuick('trupp'))))}
    </div>
  )
  /* the card says in WORDS what its line and its Kontakt say in colour — one line under the tile
   * grid, red or amber with the tier (26.09.2026 — see `rowWord`) */
  const stateLine = rowWord && (rowWord.hidden
    ? <span className="sr-only" role="status">{rowWord.text}</span>
    : <div className={cx(s.stateLine, rowWord.tone)} role={monitored ? 'status' : undefined}>{rowWord.text}</div>)
  const noteZone = (
    <>
      {/* ── 4 Hinweis ─────────────────────────────────────────────────────────────────────────
          Usually empty, and then it costs nothing (`.noteZone:empty`). */}
      <div className={s.noteZone}>
        {monitored && preEntry && <div className={s.preHint}>{az.preEntryHint}</div>}
        {airNote && (
          <div className={s.airNote} role="status" aria-live="polite">
            <Icon id="warn" /><span>{airNote}</span>
          </div>
        )}
      </div>
    </>
  )
  const actZone = (
    <>
      {/* ── 5 Aktionen: the lifecycle bar stays explicit — only these buttons commit a status ── */}
      <div className={s.actZone}>
        {canEdit && preEntry && (
          <div className={s.actions}>
            {/* ⚠️ IN THE ORDER THE EINSATZ RUNS (07.09., Feldtest Manuel — same rule as the
                in-field row below): «Im Einsatz» first, because deploying is what usually happens
                to a waiting Trupp, and the stand-down right — where «Raus melden» also lives, so
                the exit is always the right-hand column. «Im Einsatz» keeps its primary weight. */}
            <button className={cx(s.actBtn, s.actEnter)} onClick={() => onStatus(t.id, 'aktiv')}>
              <Icon id="flag" /><span>{az.actEnter}</span>
            </button>
          </div>
        )}
        {/* «Nicht eingesetzt» — VISIBLE, but never beside «Im Einsatz» (owner review 26.09.2026,
            after staging N8 had put it behind ⋮): two equal buttons side by side, one of which
            closes the Trupp in a tap, are a reflex away from the wrong one, and hidden behind ⋮
            nobody found it. So: its own row, a quiet secondary at the far edge, a full 44 px,
            and the tap answers with a confirm-with-undo toast («Trupp N: nicht eingesetzt ·
            Rückgängig»). The row it writes still says «nicht eingesetzt», never «Austritt». */}
        {canEdit && preEntry && monitored && (
          <div className={s.standDownRow}>
            <Button variant="quiet" icon={<Icon id="logout" />} onClick={() => onStandDown(t.id)}>
              {az.actNotDeployed}
            </Button>
          </div>
        )}
        {canEdit && inField && (
          <div className={s.actions}>
            {/* ⚠️ IN THE ORDER THE EINSATZ RUNS (04.09., Feldtest Manuel): Rückzug first, «Raus
                melden» after it — the crew is called back, then it comes out. It used to be the
                other way round, on the argument that the exit belongs in the quiet left column;
                but this row is read while both steps are still ahead, and a row that runs
                backwards is read backwards. Each button keeps its own weight and icon, so nothing
                about which is which changed. On a Trupp without Atemschutz «Raus melden» is still
                the only button, and then it takes the whole row.
                Rückzug is an Atemschutz manoeuvre — it lowers the turn-back pressure (alarmBarFor)
                and there is no pressure to lower on a Trupp without a cylinder. */}
            {/* ⚠️ These are the second row of the tile grid (26.09.2026 on the phone, every board
                since 29.09.2026 — T11): the same 48px tiles as «⌓ 240 bar | Kontakt» above them,
                the verb alone («Rückzug», «Raus» — `tileRueckzug`/`tileExit`; the long form stays
                the spoken name), both framed grey, and colour only by state — Rückzug amber-tinted
                while the Trupp is at or under its Alarmdruck (`actAlarm`), nothing else tinted.
                The tablet's always-amber «Rückzug melden» beside a ghost «Raus melden» said
                «warning» about a Trupp at 300 bar. */}
            {monitored && (t.status === 'aktiv' ? (
              <button className={cx(s.actBtn, s.actRueckzug, pressureLow && s.actAlarm)} aria-label={az.actRueckzug}
                onClick={() => onStatus(t.id, 'rueckzug')}>
                <Icon id="undo" /><span>{az.tileRueckzug}</span>
              </button>
            ) : (
              <button className={cx(s.actBtn, s.actContinue)} onClick={() => onStatus(t.id, 'aktiv')}>
                <Icon id="redo" /><span>{az.actContinue}</span>
              </button>
            ))}
            <button className={cx(s.actBtn, s.actExit)} aria-label={monitored ? words.exit : undefined} onClick={askExit}>
              <Icon id="logout" /><span>{monitored ? az.tileExit : words.exit}</span>
            </button>
          </div>
        )}
        {/* ── The Atemschutznotfall's door (F1, 08.10.2026): ONE held tile under the lifecycle row,
            the full width — «Notfall» on a crew inside, «Notfall beendet» on a crew in one. Held,
            never tapped (AtemschutzNotfall · NotfallHold): the loudest act on this board must not
            be a reflex away, and neither may silencing it. Under Rückzug | Raus, never beside
            Kontakt: the thumb working the radio checks must not land on it. */}
        {(onNotfall && monitored && notfallOffered(t)) || (onNotfallEnd && truppInNotfall(t)) ? (
          <div className={cx(s.actions, s.nfRow)}>
            {truppInNotfall(t) ? <NotfallHold end onFire={onNotfallEnd!} /> : <NotfallHold onFire={onNotfall!} />}
          </div>
        ) : null}
        {/* No exit timestamp line here: the exit event is in the per-Trupp Verlauf and on the
            Rapport, and what the Überwacher needs NOW is the running break clock in the band. */}
        {status === 'raus' && canEdit && (
          <div className={s.actions}>
            <button className={cx(s.actBtn, s.actReenter)} onClick={onReenter}>
              {/* a crew that was never in goes «In den Einsatz», not «wieder» (N8) */}
              <Icon id="flag" /><span>{neverDeployed ? az.actEnterFirst : az.actReenter}</span>
            </button>
          </div>
        )}
      </div>
    </>
  )
  const footZone = (
    <>
      {/* ── 6 + 7 Sockel und Verlauf, EIN Block (09.09., Maintainer-Entscheid) ────────────────
          The Sockel used to be a standing stack of look-up rows between the actions and the
          Verlauf — «Einsatzzeit», «Geschätzter Druck» with its provenance line under it,
          «Druck», «Tiefster» — ~70px that were permanently on screen on a card that does not
          fit a 375×667 phone. It is the quiet end of the card by its own description: things
          one LOOKS UP, not things one reads while a Trupp is inside.
          So it folds into the expander that was already sitting under it, and what stays out is
          one compact line:
            · the Einsatzzeit, because it is the second clock of this card;
            · the geschätzter Druck, because it is safety-adjacent and must never be a tap away
              (mock 02 kept it as a chip for exactly this reason — here it keeps its own words);
            · the aktueller Druck, but ONLY where nothing else on the card shows it (a viewer, or
              a Trupp that is out) — where the ± block above is live, the number is already there
              in 19px mono and saying it twice on one card is what this pass exists to stop.
          Behind the tap: the Schätzung's provenance («aus 2 Druckwerten · Stand 18:03»), the
          tiefster Druck, and the timing rows that were already there.
          ⚠️ The break clock stays OUT of the fold: it is a ticking number, and the one record it
          appears for (exitTime set while the status is not `raus`, legacy data) is exactly the
          case the band does not cover. A running clock behind a chevron is not a readout.
          ⚠️ The line WRAPS rather than ellipsizing. Three items only meet on a read-only card,
          and a cut «≈ 20…» is a wrong number where a second line is merely a second line. */}
      <div className={s.vfoot}>
        {/* ⚠️ The Sockel line and the Verlauf head are ONE line (26.09.2026 on the phone, every board
            since 29.09.2026 — T2): «8:18 min · Schätzung ≈ 241 bar ⌄» — the values with their
            units, no «Einsatzzeit» / «Verlauf» words, no «zuletzt: 11:52 Druck 300 bar» preview (its
            content is the Verlauf's first row anyway, and its bar was the pressure tile's number a
            second time), and the whole line is the tap that opens the Verlauf. A viewer's Druck
            and «Draussen seit» join in the same terse form. With nothing to say (a Trupp at the
            door) the line says «Verlauf», so the tap still has a word.
            ⚠️ The Schätzung KEEPS its word and full ink (owner, 29.09.2026: «we still need the
            schätzung clearly visible»): it is the one number on the card that is not a reading,
            and «≈ 0 bar» dimmed at the card's foot was easy to read past. The word is what keeps
            it from being taken for a logged Druck — the dimming that used to do that is gone. */}
        {/* ⚠️ The ⋯ ends THIS line (29.09.2026, owner pick B): as the facts' last chip it wrapped
            onto a row of its own on most cards, 44px of height for one glyph. Beside the Verlauf's
            ⌄ it costs nothing, stands at the same place on every card and every board, and the
            FAB guard (`data-az-foot` on the row, AtemschutzView · the parking effect) keeps both
            clear of the Eintrag button. */}
        <div className={s.vfootRow} data-az-foot="">
        <button type="button" className={cx(s.vrow, s.vrowTerse)} aria-expanded={logOpen} aria-label={az.verlauf}
          onClick={() => setLogOpen((o) => !o)}>
          <span className={s.metaLine}>
            {sockelLine.length > 0 ? sockelLine.map((it) => (
              <span key={it.key} title={it.title}>
                {it.labelled && <i>{it.label}</i>}
                {/* the Einsatzzeit / «Draussen seit» past a day in the head's compact «3d 10h» — one card, one spelling */}
                <b className={cx(it.alarm && s.metaAlarm)}><ClockVal val={it.value} /></b>
              </span>
            )) : <span><i>{az.verlauf}</i></span>}
          </span>
          <Icon id={logOpen ? 'chevron-up' : 'chevron-down'} className={s.logChev} />
        </button>
        {menu}
        </div>
            {logOpen && (
              <div className={s.vopen}>
                {/* ── ONE panel of look-up rows, then the list (09.09., maintainer review) ────
                    It was two panels and a floating footnote, and it said the Schätzung twice
                    within 80px: «≈ 31 bar» on the line above and «Geschätzter Druck ≈ 31 bar»
                    here. A number stated twice at the same moment is a number somebody will one
                    day read as two.
                    So the value is said ONCE — up on `.metaLine`, where it also survives the
                    collapse — and this panel carries only what the line cannot: where the
                    Schätzung comes FROM, how deep the Trupp has already been, and (on the FU
                    tablet) the contact timing. The provenance is that row's own value, sitting
                    against the label it explains instead of floating under both.
                    ⚠️ «Tiefster» is conditional and stays that way: `lowestBar < currentBar` is
                    only true once a Trupp has come back UP — a fresh bottle after «Wieder in den
                    Einsatz». On a normal descent the tiefster Druck IS the current one, and a
                    row restating it would be the very duplication this rework removes.
                    ⚠️ The timing rows keep their `!lite` gate (08.09., field ask): the phone at
                    the Eingang works off the ticking clock on the card. */}
                {(estimate || lowestShown || timingShown) && (
                  <div className={s.zonePanel}>
                    {estimate && (
                      <div className={s.zonePanelRow}>
                        <span>{az.estimatedShort}</span>
                        <em className={s.zoneNote} title={estimate.source === 'history'
                          ? az.estimatedHintHistory
                          : fillTemplate(az.estimatedHint, { liters: dz.cylinderLiters, rate: dz.estConsumptionLPerMin })}>
                          {estimate.source === 'history'
                            ? fillTemplate(az.estimatedSourceHistory, { count: estimate.sampleCount, time: fmtTime(estimate.basedAt) })
                            : fillTemplate(az.estimatedSourceFallback, { rate: dz.estConsumptionLPerMin, time: fmtTime(estimate.basedAt) })}
                        </em>
                      </div>
                    )}
                    {lowestShown && (
                      <div className={s.zonePanelRow}>
                        <span>{az.lowestPressure}</span><b>{live.lowestBar} bar</b>
                      </div>
                    )}
                    {timingShown && (
                      <>
                        <div className={s.zonePanelRow}><span>{az.lastContactAt}</span><b>{hm(lastContactAt!)}</b></div>
                        <div className={s.zonePanelRow}><span>{az.nextContactDue}</span><b>{hm(lastContactAt! + intervalMin * 60_000)}</b></div>
                        <div className={s.zonePanelRow}><span>{az.contactIntervalLabel}</span><b>{fillTemplate(az.contactIntervalValue, { min: intervalMin })}</b></div>
                      </>
                    )}
                  </div>
                )}
                {readings.length > 0 && (() => {
                  // ⚠️ The log spans EVERY deployment since 18.08. («Wieder einrücken» appends
                  // rather than starting a new one, so the first bottle still prints on the
                  // Rapport). The card's own numbers, though, are about the crew that is inside
                  // NOW — Eingangsdruck, tiefster Druck. Without a boundary the two contradict
                  // each other: «tiefster Druck 300» over a row reading 120. Everything before
                  // the current run is dimmed and gets a line.
                  const from = currentRunStart(readings)
                  return (
                    <>
                      {/* ⚠️ No «ABLESUNGEN» head since 09.09. (field review). The list is the
                          only list this fold contains and every row of it carries a time and a
                          bar — it names itself. What the head really did was draw the rule
                          between the look-up panel and the readings, so `.logList` draws that
                          rule now and the section keeps its seam without its title. */}
                      <ul className={s.logList}>
                        {[...readings].reverse().map((r, i) => {
                          const idx = readings.length - 1 - i
                          return (
                            <li key={idx} className={cx(s.logRow, idx < from && s.logRowPast, idx === from && from > 0 && s.logRowRunStart)}>
                              <span className={s.logTime}>{fmtTime(r.t)}</span>
                              {/* …and the same on the board: a Kontakt shows no bar, because the
                                  one it carries is the last reported value, not a fresh reading —
                                  and a Trupp without Atemschutz shows none at all (barShown) */}
                              <span className={s.logBar}>{barShown(r) ? `${r.bar} bar` : ''}</span>
                              <span className={s.logKind}>{readingLabel(r, idx)}</span>
                            </li>
                          )
                        })}
                      </ul>
                    </>
                  )
                })()}
              </div>
            )}
      </div>
    </>
  )

  /* ── The card IS the phone's row, grown downwards (26.09.2026, owner on staging) ─────────────────
   * «Keep the same UI whether the card is collapsed or not.» The card used to swap the row's line
   * and its «Druck | Kontakt» pair for a head, a band with the clock again in 40px, a full-width
   * Kontakt and a Druck row — the same two buttons in a second shape, one tap after the first.
   * Now the card IS the row, grown downwards: the same frame and tone, the same line (RowLine),
   * the same pair (TruppPair), at the same place; opening only adds what stands below.
   * On the phone board the line itself is the collapse control, as the row was the open control,
   * so the chevron stays in the pixel the thumb just pressed; on the tablet grid and the handed-
   * over Tafel nothing collapses (every card stands open) and the line is just the line.
   * ⚠️ ORDER since the slim-down (26.09.2026 evening, owner: «unit, verb, value»): the line, then
   * ONE 2×2 tile grid — the pair on top, Rückzug / Raus under it (`actZone`, styled as the same
   * tiles here) — then the state in words where there is one, the note, the facts with the ⋯,
   * and the one-line foot. The actions stand ABOVE the facts: what a thumb does on this card is
   * the four tiles, and they stand together under the clock.
   * ⚠️ ONE drawing on every board since 29.09.2026 — see the zone list above TruppCard. */
  // the opened card keeps the row's line, tier mark included (B5) — but not for the Alarmdruck,
  // which its state line already says in words with the limit; and never on a stopped clock
  const headTier = frozen ? null : tierMark(alarm, sev, false)
  const head = rowMode ? (
    <button type="button" className={s.trowHead} aria-expanded="true" onClick={onCollapse}
      aria-label={`${t.name} — ${az.collapse}`}>
      <RowLine t={t} live={live} color={lite ? undefined : color} lite={lite} tier={headTier} />
      <span className={s.trowChevron}><Icon id="chevron-up" /></span>
    </button>
  ) : (
    <div className={cx(s.trowHead, s.trowHeadStatic)}>
      <RowLine t={t} live={live} color={lite ? undefined : color} lite={lite} tier={headTier} />
    </div>
  )
  return (
    <div ref={cardRef} data-az-open={rowMode ? '' : undefined} className={cx(s.trow, s.trowCard, rowTone(t, status, sev))}>
      {head}
      {monitored && canEdit && inField && (
        <TruppPair t={t} live={live} sev={sev} onPressure={(id) => onAskPressure?.(id)} onContact={onContact} />
      )}
      {actZone}
      {stateLine}
      {noteZone}
      {facts}
      {footZone}
    </div>
  )
}

/**
 * ONE shared form for create / edit / re-deploy, in one of two shapes.
 *
 * ⚠️ The rule used to be «single screen, never a wizard» (3am tenet). It is now narrower than
 * that, because the screen it was written for is not the only one any more — but the WIZARD is
 * gone again (04.09.), and what replaced it is closer to the original rule than the two steps
 * ever were:
 *   · On anything with room — tablet, desktop — it is ONE screen. Nothing is behind a section,
 *     nothing has to be walked to, and the whole Trupp is visible while it is being formed.
 *   · On a PHONE it is a STACK of three sections (`stack`): Mannschaft · Luft & Funk · Auftrag &
 *     Leitung. All three are on screen at all times; exactly one is open and the other two read
 *     their own answers out beside their titles («Unter Atemschutz · 300 bar · Kanal 5»), so the
 *     closed stack IS the form rather than a table of contents for it. Sections can be opened in
 *     any order and closed again — three answered lines is a legitimate, and useful, state.
 *   · ⚠️ It was a two-STEP wizard from 02.09. to 04.09., and the reason it went is not that the
 *     fold it fixed came back — it did not. It is that the wizard grew its OWN fold: step 2
 *     carried seven fields (Art · Druck · Kanal · Auftrag · Ziel · Leitung · Farbe) and ran off
 *     the bottom of a 375px screen, while the common Trupp — GF + 2, full cylinder, default
 *     channel — still had to walk a «Weiter» that asked nothing it had not already answered. The
 *     stack has no step to walk and no fold to fall off: what does not fit scrolls, and the one
 *     control that starts the Trupp is pinned in the footer the whole time.
 *   · ⚠️ EVERY kind of Trupp gets the same three sections (03.09., and unchanged by the rework).
 *     The Art may add or drop the Druck row inside «Luft & Funk» — ordinary form behaviour — but
 *     it must never change the SHAPE of the form. Collapsing to one screen under the thumb that
 *     had just tapped «Ohne Atemschutz» was the jarring part, not the length of a step.
 *   · ⚠️ «Art des Trupps» rides with the fields it GOVERNS (03.09.): on one screen it spans the
 *     form above both columns, on the stack it leads «Luft & Funk». Section 1 is the Mannschaft
 *     alone, because who is in the Trupp is the one thing the Art does not decide.
 *
 * Leads with the AUFTRAG (what the Trupp is sent to do — the order you check them against on every
 * Kontakt), then the Trupp; the Druck section belongs to Atemschutz alone, and «Art des Trupps»
 * is asked once, at creation, because it cannot be changed afterwards (types · Trupp.kind).
 *
 * ⚠️ There is NO colour picker any more (04.09.), on any layout. The colour is still per-Trupp
 * and still automatic — the field simply stopped being asked; see `color` in `submit`.
 */

/**
 * Is `el` already fully visible inside the box that scrolls it?
 *
 * ⚠️ The point is what NOT to do: a smooth `scrollIntoView` on an element that is already in
 * view still starts an animation, and iOS spends the next tap on stopping it. Ringing a field
 * that never moved therefore cost the operator their first tap on the chip beside it.
 * Falls back to the viewport when nothing above the element scrolls; an element with no layout
 * (jsdom, a sheet that has not painted yet) counts as out of view, so the scroll still happens.
 */
function inScrollPort(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return false
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 1) {
      const pr = p.getBoundingClientRect()
      return r.top >= pr.top && r.bottom <= pr.bottom
    }
  }
  return r.top >= 0 && r.bottom <= window.innerHeight
}

/** What a kept edit / re-entry draft belongs to (TruppForm · draftKey): the sortie and every field
 *  the form writes, as one short string. Pure; the draft store is per session and per incident. */
function truppDraftStamp(t: Trupp): string {
  const last = t.readings?.[t.readings.length - 1]
  const s = JSON.stringify([t.status, t.entryTime, t.exitTime ?? '', last?.t ?? '', last?.kind ?? '',
    t.name, t.members ?? [], t.auftrag ?? '', t.ziel ?? '', t.lineNo ?? null, t.lineNumber ?? '', t.funkkanal ?? null,
    t.entryPressureBar, t.kind ?? '', t.equipment ?? []])
  // FNV-1a — only has to tell two states apart, never to be read
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(36)
}

function TruppForm({
  mode, initial, presetAuftrag, focusSection, roster, defaultFunkkanal, personnel, presentIds, stationIds, assignedIds, transferState, onTransfer, rolesById, leitungOptions, lite = false, stack = false, sheet = false, pinned, onAddGuest, onCancel, onSubmit,
}: {
  mode: FormMode
  initial?: Trupp
  /** a NEW Trupp's Auftrag, chosen by the door it came through — «Sicherungstrupp bestimmen»
   *  opens the form on «Sichern» (24.09.2026). Ignored for edit/redeploy, which have their own. */
  presetAuftrag?: TruppAuftrag
  /** A card gap opened this form — point directly at the field that resolves it. */
  focusSection?: 'auftrag'
  roster: string[]
  defaultFunkkanal: number
  personnel: Person[]
  presentIds: Set<string>
  stationIds: Set<string>
  assignedIds: Set<string>
  /** …and whether the double assignment can be UNDONE from here: `ready` earns the warning its
   *  «In diesen Trupp verschieben», `deployed` says instead that the other crew is out there,
   *  `blocked` leaves the plain sentence (lib/atemschutz · truppTransferState). */
  transferState?: (personId: string) => TruppTransferState
  /** move that person out of the Trupp they are still in — `toName` is the Gruppenführer this
   *  form is forming, so the other Trupp's Verlauf row can say where they went */
  onTransfer?: (personId: string, toName: string) => void
  /** who already holds a job on this Einsatz (Anwesenheits-Bemerkung), so the picker can say
   *  «schon: Einsatzleiter» beside a name — a hint, never a block */
  rolesById: Map<string, string>
  onCancel: () => void
  /** the Leitungen drawn on either surface (lib/truppLines · leitungOptions) — offered as
   *  quick-picks so the number is chosen from what exists, not typed blind */
  leitungOptions: LeitungOption[]
  /** the handed-over «Tafel pur» (see AtemschutzView · lite): drops the ENTIRE Ltg-Nr. row
   *  (reverted, round 2 review — briefly shown 02.09.) and the «Art des Trupps» chooser. A link
   *  holder has no picture to read a hose number off and no surface to draw one on, so the field
   *  could only ever be a number typed blind — and one Leitung, one Trupp is enforced against
   *  what is actually drawn regardless (see submitForm's takeover confirm). The FU sets it on
   *  the KP tablet. (It used to drop the Farbe picker too; there is no picker any more.) */
  lite?: boolean
  /** three sections instead of one scroll — set for ANY phone, and for any Art of Trupp. See the
   *  two-shapes note above the component: nothing about the Art may change the SHAPE of the
   *  form, only what «Luft & Funk» contains. */
  stack?: boolean
  /** The phone board's frame (24.09.2026, D1 ⑥): a BOTTOM SHEET instead of the full-screen form,
   *  so the due clocks stay in view above it. With it come the grab bar and push-down-to-close —
   *  it is a real bottom sheet now (AGENTS.md · overlays), and closing it that way is «not now»:
   *  every entry is kept (draftKeep) until «Abbrechen» or the save. */
  sheet?: boolean
  /** the due / overdue Trupps pinned ABOVE the sheet (AtemschutzView · pinnedRows), or nothing */
  pinned?: ReactNode
  /** record a hand-typed Gast on the Anwesenheit as well — being put in a Trupp IS being here */
  onAddGuest?: (name: string) => string | undefined
  /** `standby` (re-deploy only) parks the Trupp as Reserve instead of sending it straight in */
  /** resolves `true` once the Trupp is written — the draft is dropped only then */
  onSubmit: (f: TruppFields, standby?: boolean, extra?: TruppSubmitExtra) => Promise<boolean> | void
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  // ⚠️ The typed Trupp survives a mis-tap. Only «Abbrechen» throws it away — an ✕ or a tap on
  // the backdrop is «not now», and losing three names and a Ziel to a fat finger at 3am is the
  // expensive half of that pair (see lib/draftKeep, the same rule the Gast name follows).
  /* ⚠️ …but a draft belongs to ONE state of the Trupp (review 25.09.2026). Keyed on the id alone,
   * a re-entry abandoned after one sortie handed its «Gleiche Flasche · 120 bar» to the NEXT
   * sortie's re-entry, and an edit draft wrote back a Leitung somebody had linked on the Karte in
   * between. So an edit / re-entry draft is keyed on the Trupp as the form opened it — its
   * sortie (status, Eintritt, Austritt, last log row) and every field the form writes
   * (`truppDraftStamp`): anything that changed since makes it a fresh form. A new Trupp has no
   * such state, and its draft stays keyed on «new». */
  const draftKey = `atemschutz:trupp:${mode}:${initial ? `${initial.id}:${truppDraftStamp(initial)}` : 'new'}`
  /* «Sicherungstrupp bestimmen» opens the create form on «Sichern» (`presetAuftrag`) — and that
   * door is the answer, so it wins over a kept create draft's Auftrag. Written into the draft
   * store BEFORE the Auftrag's own state reads it (a lazy initializer runs once, at mount). */
  useState(() => { if (mode === 'create' && presetAuftrag) keepDraft(`${draftKey}:auftrag`, presetAuftrag); return 0 })
  // The two roster indexes the slot resolution needs: name → id, and id → Person (to check that
  // a stored positional id really belongs to the name beside it — see lib/personnel · truppSlots).
  const rosterByName = useMemo(() => rosterIdByName(personnel), [personnel])
  const rosterById = useMemo(() => rosterFromList(personnel), [personnel])

  const [auftrag, setAuftrag, clearAuftrag] = useKeptState<Trupp['auftrag'] | null>(`${draftKey}:auftrag`, initial?.auftrag ?? presetAuftrag ?? null)
  const [ziel, setZiel, clearZiel] = useKeptState(`${draftKey}:ziel`, initial?.ziel ?? '')
  // Ausrüstung (types · Trupp.equipment): the ids ticked, kept as a draft like the Auftrag. Only
  // a Trupp under Atemschutz is asked (see `equipmentField`); the list is the station's.
  const [equipment, setEquipment, clearEquipment] = useKeptState<string[]>(`${draftKey}:equipment`, initial?.equipment ?? [])
  const toggleEquipment = (id: string) =>
    setEquipment(equipment.includes(id) ? equipment.filter((x) => x !== id) : [...equipment, id])
  // Leitung: numeric since 2026-08-05. A Trupp carrying only the old free text starts empty and
  // keeps that text visible underneath — the record stays as its Überwacher typed it, and a
  // legacy «1» still auto-matches the drawn Leitung 1 (lib/truppLines · truppLineNo).
  // ⚠️ KEPT like the crew and the Auftrag (24.09.2026): the phone form is a bottom sheet now, and
  // pushing it down is «not now» — the same as the ✕ and the backdrop, which never threw these
  // away either… except that they did, for Ltg-Nr., Kanal, Art and Druck, the four fields that
  // were plain state. Only «Abbrechen» and the save drop a draft (`dropDraft`).
  const [lineNo, setLineNo, clearLineNo] = useKeptState<number | null>(`${draftKey}:lineNo`, initial?.lineNo ?? null)
  const legacyLine = initial?.lineNo == null ? initial?.lineNumber?.trim() : undefined
  const [funkkanal, setFunkkanal, clearFunkkanal] = useKeptState<number>(`${draftKey}:funkkanal`, initial?.funkkanal ?? defaultFunkkanal)
  // ⚠️ Read, never written (04.09.): the picker is gone from every layout. `null` means
  // «automatic» — the station colour for this Auftrag, else the next free palette colour (see
  // Trupp.color) — and that is what every new Trupp gets. A Trupp created while the picker
  // existed keeps its colour because the form hands the stored value straight back; editing one
  // must not repaint a Trupp that is already drawn on the Lage and on the plan.
  const color = initial?.color ?? null
  // ONE list, leader first (see TruppTeam): `team[0]` IS the Gruppenführer, which is also the
  // order the card, the Rapport and the map tag print. The record on disk keeps its old shape
  // (`name` + `members`), so nothing that ever read a Trupp has to change.
  const [team, setTeam, clearTeam] = useKeptState<Slot[]>(
    `${draftKey}:team`,
    initial ? truppSlots(initial, rosterByName, rosterById) : [],
  )
  // ⚠️ …and the KEPT DRAFT gets the same treatment. `useKeptState` restores whatever was in the
  // browser, which on a device that has been open across a roster sync (or across a demo reset)
  // is a team of bare names — so the form re-badged three roster members «Gast» while the Trupp
  // on disk had their ids all along. Re-linking on open is idempotent and never invents an id.
  useEffect(() => {
    const linked = team.map((sl) => (sl.personId ? sl : { ...sl, personId: personIdForName(rosterByName, sl.name) }))
    if (linked.some((sl, i) => sl.personId !== team[i].personId)) setTeam(linked)
    // once per mount: the roster is stable while a modal is open, and re-running on `team`
    // would fight the operator's own edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  /* The crown follows the Dienstgrad while a NEW Trupp is being formed (30.09.2026, owner: «auto-set
   * the highest person rank wise as group leader unless … a group leader was set manually»):
   * until a name is tapped, the most senior member leads (lib/truppLeader · crewAfterChange).
   * Kept with the draft, so a pushed-away form that had its leader crowned by hand comes back with
   * that answer. Never on an edit or a re-entry — a crew joined later keeps its leader. */
  const [leaderAuto, setLeaderAuto, clearLeaderAuto] = useKeptState<boolean>(`${draftKey}:leaderAuto`, mode === 'create')
  const rankById = useMemo(() => new Map(personnel.map((p) => [p.id, rankOrder(p.rank)])), [personnel])
  const changeTeam = (next: Slot[], why: CrewChange) => {
    const r = crewAfterChange(next, why, leaderAuto, (sl) => (sl.personId ? rankById.get(sl.personId) ?? Infinity : Infinity))
    setTeam(r.team)
    if (r.auto !== leaderAuto) setLeaderAuto(r.auto)
  }
  /* «Art des Trupps» — asked on creation, and changeable while EDITING one (04.09.). What the
   * board could not do until then is the ordinary case: a Verkehrstrupp that ends up going in
   * under PA, and a Trupp registered under Atemschutz by mistake. Both were a delete and a
   * re-registration, which throws away the record of a crew that was already working.
   * ⚠️ …and on RE-DEPLOY too, reversing «the two decisions must not ride on one button» the same
   * day (Feldtest: «Bei Wieder einrücken (AS) habe ich keine Auswahl ob mit oder ohne AS»). The
   * reasoning was that «Wieder einrücken» sends the SAME Trupp in again — but what comes back
   * from the vehicle is very often a different job: the crew that fought the fire under PA goes
   * back in to clear up without it, and the Verkehrstrupp that has finished puts masks on for the
   * cellar. Each re-deployment is its own Einsatz of that crew, and the Art belongs to the
   * deployment, not to the card. Answering from the record was not the safe default either: it
   * silently re-armed a contact clock over a crew that was no longer under Atemschutz.
   * ⚠️ The change is not free — it starts or stops a safety watch. `editTrupp` / `reactivateTrupp`
   * own what that writes, and the confirm in front of a downgrade lives in `submitForm` below,
   * where saying no still leaves the operator in the form. (A re-deploy needs none: the Trupp is
   * out, so there is no running watch to take away.) */
  const [kind, setKind, clearKind] = useKeptState<TruppKind>(`${draftKey}:kind`, initial?.kind ?? 'atemschutz')
  /** The Funkkanal follows the Art while it is still the seeded default: stations may run their
   *  ohne-AS Trupps on a separate channel (doctrine.defaultFunkkanalEinfach). The form always
   *  opens under PA, so the ohne-AS seed can only apply on the «Ohne Atemschutz» tap — and a
   *  channel the operator already dialled, or a stored one being edited, is never overwritten. */
  const pickKind = (next: TruppKind) => {
    if (next !== kind && initial?.funkkanal == null) {
      const seedFor = (k: TruppKind) => (k === 'atemschutz' ? defaultFunkkanal : atemschutzDoctrine().defaultFunkkanalEinfach)
      if (funkkanal === seedFor(kind)) setFunkkanal(seedFor(next))
    }
    setKind(next)
  }
  const isPa = kind === 'atemschutz'
  /** This edit is turning the Überwachung ON — the Trupp had no cylinder until a moment ago, so
   *  the Druck field asks for a first Eingangsdruck rather than offering a correction. */
  const upgrading = mode === 'edit' && isPa && !!initial && !isAtemschutzTrupp(initial)
  /** Which of the two number sheets is open over the form (30.09.2026, owner: «Eingangsdruck and
   *  Funkkanal must open in a pop-up»): the Druck sheet's grid and the Kanal sheet's pad, opened from
   *  the rows «Eingangsdruck 300 bar ›» / «Funkkanal 11 ›» (see `luftFields`). A pick fills the
   *  draft and closes; nothing is written until the form's own save. They replace the «Standard:
   *  300 bar · Kanal 11 — Ändern» fold of 08.09. — it hid two steppers nobody touched; a row that
   *  opens a sheet costs the form what the fold did. */
  const [picker, setPicker] = useState<'pressure' | 'kanal' | null>(null)
  // …and the Auftrag tiles follow it: each kind has its own six-word vocabulary (config ·
  // atemschutz.auftrag / .auftragEinfach). Only the OFFER is narrowed — an already-stored value
  // from the other list keeps rendering everywhere (lib/report · truppAuftragLabel).
  const auftragTypes: { id: TruppAuftrag; label: string }[] = isPa ? cfg.auftrag : cfg.auftragEinfach
  // a fresh cylinder for create / re-deploy; edit never touches pressure. A Trupp without
  // Atemschutz has no cylinder at all — 0, and the field is not shown (see `showPressure`).
  // ⚠️ `||`, not `??`: a Trupp without Atemschutz carries 0 and has no number to correct, so
  // upgrading one from this form would open the stepper at 0 — a value the submit then refuses,
  // with the operator left to find out why. It gets the station's default, like a new Trupp.
  const [pressure, setPressure, clearPressure] = useKeptState<number>(`${draftKey}:pressure`,
    mode === 'edit' ? (initial?.entryPressureBar || atemschutzDoctrine().defaultPressureBar) : atemschutzDoctrine().defaultPressureBar)
  /* «Gleiche Flasche oder neue?» (24.09.2026, Übung 23.09.: a Trupp out at 19:55 after twelve
   * minutes went back in at 19:56 «with 300 bar» — the default nobody had touched). Asked only on
   * a re-entry within BOTTLE_ASK_MIN of the Austritt, where the answer is genuinely open; after
   * that a fresh cylinder is the normal case and the form looks as it always did. Nothing is
   * pre-selected, and «Im Einsatz» waits for an answer (or a touched stepper). */
  const lastExit = mode === 'redeploy' ? [...(initial?.readings ?? [])].reverse().find((r) => r.kind === 'exit') : undefined
  const outMin = lastExit ? Math.floor((serverNow() - Date.parse(lastExit.t)) / 60_000) : null
  const bottleAsk = isPa && lastExit != null && outMin != null && outMin < BOTTLE_ASK_MIN && lastExit.bar > 0
  // ⚠️ NOT kept (review 25.09.2026): the answer is about THIS break, and a kept «Gleiche Flasche»
  // skipped both questions on a later sortie with the old Restdruck
  const [bottle, setBottle] = useState<'same' | 'new' | null>(null)
  // No autofocus on a TABLET: the on-screen keyboard would immediately cover the form's other
  // fields, and the Mannschaft is a list that can simply be ticked. The EL taps the field they
  // want first. ⚠️ A PHONE creating a Trupp is the exception (20.09.2026): there the roster
  // appears only under a typed query, so the search IS the first step and nothing else on the
  // form can be answered before it – the dialog opens with the caret in it, and the phone frame
  // already folds the other sections away while it has the keyboard (Atemschutz.module.css).
  const teamSearchRef = useRef<HTMLInputElement | null>(null)
  const focusTeamFirst = !!stack && mode === 'create'
  // Esc closes the form (keyboard parity with the scrim/close-button) — but not while one of its
  // number sheets is open: that Escape is the sheet's (it closes itself first, and this closure
  // still sees it open, because the close has not rendered yet)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !picker) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, picker])
  const auftragRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusSection !== 'auftrag') return
    const el = auftragRef.current
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [focusSection])
  // The other sections a blocked «Speichern» might have to point at (see `attemptSubmit` below) —
  // `zielRef` and `conflictRef` are new; `auftragRef` above already existed for the card's own
  // «Auftrag offen» pill and is reused here so the two paths ring the same field the same way.
  const teamRef = useRef<HTMLDivElement>(null)
  const zielRef = useRef<HTMLLabelElement>(null)
  const pressureRef = useRef<HTMLDivElement>(null)
  const conflictRef = useRef<HTMLDivElement>(null)

  // ⚠️ Shown in EVERY mode, including 'edit'. Hiding it there meant a mistyped Eingangsdruck could
  // never be corrected — and it is the number the Verbrauch and the tiefster Druck on the Rapport
  // are measured against. In edit mode it corrects what was recorded; it never counts as a contact.
  // ⚠️ …but only for a Trupp under PA: there is no cylinder to read on a Verkehrstrupp, and a
  // «Speichern» blocked on `pressure > 0` for a number that does not exist would be a dead button.
  const showPressure = isPa
  const isEdit = mode === 'edit'
  /* ⚠️ …except once the Trupp is OUT (24.09.2026, item 2). On 23.09. the Restdruck had nowhere to
   * go, so it was typed into «Eingangsdruck korrigieren» after the Austritt three times, and the
   * Rapport shows crews going in with 60, 170 and 180 bar. The exit has its own Restdruck now
   * (PressureSheet), and a finished run's entry reading is locked: it says so, and points at the
   * Restdruck where there is one. A correction to a finished sortie is an appended Verlauf row,
   * never an overwrite. While the Trupp is inside or still registered the field stays open. */
  const pressureLocked = isEdit && !!initial && initial.status === 'raus' && isAtemschutzTrupp(initial) && isPa
  const lockedExit = pressureLocked
    ? [...(initial?.readings ?? [])].reverse().find((r) => r.kind === 'exit' && r.measured)
    : undefined
  const isAnderes = auftrag === 'anderes'
  // «Anderes» needs its word: it is a label that says nothing on its own.
  const auftragOk = !isAnderes || ziel.trim().length > 0
  /**
   * …and that is the ONLY thing the Auftrag holds back (14.09., Feldentscheid — reversing the
   * 04.09. «Anmelden needs an Auftrag», which had itself reversed the 30.08. «the Auftrag no
   * longer blocks»).
   *
   * A Trupp is often registered to STAND READY: the crew is at the door with masks on and the
   * order comes a minute later, from somebody else. Blocking the Anmeldung on it meant the card
   * — and its contact clock — did not exist until the Überwacher had invented a job, and «Retten»
   * typed to get past the form is a worse record than an open field. The gap stays visible: the
   * card shows «Auftrag offen» (the same pill on a Trupp created without one as on one edited to
   * none) and opens the form on the Auftrag; the Trupp may go «drin» meanwhile. In no mode does an
   * empty Auftrag hold the form — creating, editing, or sending back in.
   */
  // …said, not enforced (15.09., Bastian: «with the warning»): while the Auftrag is empty on a NEW
  // Trupp an amber line above the footer names the gap; the save goes through regardless.
  const auftragGiven = (auftrag != null && !isAnderes) || ziel.trim().length > 0
  // ⚠️ …and only once somebody is IN the Trupp (18.09.2026): on a blank form the line stood
  // there before the first tap, naming a gap in a form nobody had started filling. The crew is
  // the first thing entered, so «at least one name» is «the operator has begun» — and from then
  // on the amber line says what is still missing.
  const auftragMissing = mode === 'create' && !auftragGiven
    && team.some((sl) => sl.name.trim().length > 0)
  // ⚠️ …and not while the caret is still in the PERSON SEARCH (10.10.2026, owner's iPhone): the
  // crew goes in one name after another, and the line stood there from the first name on, naming
  // a gap in a part of the form the operator had not reached. It waits until the search is left —
  // for the Auftrag, the Ziel, the footer, or a tap anywhere else — on every form factor.
  // The slot is HELD while it waits (visibility, not unmounting, `.formHintWaiting`): the blur
  // that reveals it is very often the press on «Anmelden» itself, and a line appearing under that
  // finger would move the button between the press and the release (on iOS the synthetic click
  // is hit-tested after the blur has re-rendered).
  const [teamSearchFocused, setTeamSearchFocused] = useState(false)
  const onTeamFocusChange = (focused: boolean) => (e: ReactFocusEvent) => {
    if (e.target === teamSearchRef.current) setTeamSearchFocused(focused)
  }
  // A linked person already deployed in another active Trupp blocks submit (one person, one
  // Trupp). The picker no longer OFFERS one — but an existing Trupp being edited can still carry
  // somebody who was assigned elsewhere in the meantime, and that has to be sayable.
  /* ⚠️ The person, not just their name (11.09.): the warning now carries an ACTION — take them
     out of the other Trupp — and that needs the id it is about and whether that Trupp is one a
     person may be quietly moved out of at all (lib/atemschutz · truppTransferState). */
  // ONE answer for the form and the Trupp sheet (lib/truppQuickEdit · teamConflict, 26.09.2026)
  const assignedConflict = useMemo(() => teamConflict(team, assignedIds, transferState, az.assignedFallbackName),
    [team, assignedIds, transferState, az.assignedFallbackName])
  const leaderOk = (team[0]?.name.trim().length ?? 0) > 0
  const bottleOk = !bottleAsk || bottle != null
  const canSubmit = auftragOk && leaderOk && (!showPressure || pressureLocked || pressure > 0) && bottleOk && !assignedConflict
  /* No sections on the phone any more (08.09., field ask): with the Mannschaft reduced to the
   search + populate-on-pick list and Druck/Kanal folded into the Standard line, the flat form
   fits — the three collapsible sections and their summary lines went with the space problem
   they were built for. */

  /* The fields exactly as this form would save them UNTOUCHED — its own defaults off `initial`,
   * computed once at mount. What differs from them at the save is what the operator touched
   * (`truppFieldGroupsChanged`), and an edit writes only that (AtemschutzView · submitForm). */
  const [pristine] = useState<TruppFields>(() => {
    const dz = atemschutzDoctrine()
    const slots = initial ? truppSlots(initial, rosterByName, rosterById) : []
    const k = initial?.kind ?? 'atemschutz'
    return {
      name: slots[0]?.name.trim() ?? '',
      members: slots.slice(1).map((m) => m.name.trim()).filter(Boolean),
      auftrag: initial?.auftrag ?? (mode === 'create' ? presetAuftrag : undefined),
      ziel: initial?.ziel, lineNo: initial?.lineNo, funkkanal: initial?.funkkanal ?? defaultFunkkanal,
      pressure: k !== 'atemschutz' ? 0 : mode === 'edit' ? (initial?.entryPressureBar || dz.defaultPressureBar) : dz.defaultPressureBar,
      equipment: initial?.equipment, kind: k,
    }
  })

  const dropDraft = () => {
    clearAuftrag(); clearZiel(); clearEquipment(); clearTeam(); clearLeaderAuto()
    clearLineNo(); clearFunkkanal(); clearKind(); clearPressure(); clearPressureSet()
  }
  const submit = (standby = false) => {
    if (!canSubmit) return
    /* The Gäste typed into this form reach the Anwesenheit NOW, at the save — never earlier
     * (staging walk-through 25.09.2026: «Abbrechen» left a person on the Rapport who never
     * existed). Filed through the same door as before (`onAddGuest` · assignTypedName, which links
     * a name that is already on the list instead of opening a second row), and the id it comes
     * back with is written into the Trupp, so the card and the Personalblatt are one person. */
    const cleanMembers = team.slice(1).filter((m) => m.name.trim())
    const memberPersonIds = cleanMembers.map((m) => m.personId).filter(Boolean) as string[]
    const fields: TruppFields = {
      name: team[0].name.trim(),
      members: cleanMembers.length ? cleanMembers.map((m) => m.name.trim()) : undefined,
      auftrag: auftrag ?? undefined,
      ziel: ziel.trim() || undefined,
      lineNo: lineNo ?? undefined,
      funkkanal: Number.isFinite(funkkanal) ? funkkanal : undefined,
      // 0 for a Trupp without Atemschutz — there is no cylinder, and the field was never shown.
      // ⚠️ On an UPGRADE this is the Eingangsdruck of a cylinder opened just now, and editTrupp
      // logs it as such (`paOn`) rather than correcting the Eintritt the Trupp already has.
      // …and a LOCKED Eingangsdruck goes back exactly as stored — never the stepper's fallback
      // for a Trupp that carries 0, which would have written 300 over a reading nobody took
      pressure: isPa ? (pressureLocked ? initial!.entryPressureBar : pressure) : 0,
      // in the station's list order, so two operators ticking the same items record the same
      // array — and nothing at all for a work squad, whose form never showed the chips
      equipment: isPa && equipment.length ? atemschutzEquipment().map((e) => e.id).filter((id) => equipment.includes(id)) : undefined,
      leaderPersonId: team[0].personId,
      memberPersonIds: memberPersonIds.length ? memberPersonIds : undefined,
      // ⚠️ PASSED THROUGH, never chosen (04.09.). The colour picker is gone from every layout;
      // `null` means «automatic» (the station colour for this Auftrag, else the next free one —
      // see Trupp.color), which is what a new Trupp now always gets. An OLDER Trupp that was
      // created while the picker existed keeps the colour it was given: editing must not repaint
      // a Trupp that is already drawn on the Lage and on the plan.
      color,
      kind,
      ...(isPa && (pressureSet || lowConfirmed === pressure) ? { pressureMeasured: true } : {}),
    }
    /* The Gäste typed into this form reach the Anwesenheit at the SAVE — never earlier (staging
     * walk-through 25.09.2026: «Abbrechen» left a person on the Rapport who never existed) — and
     * the view calls this only once every question in front of the save is answered. Filed
     * through the same door as before (`onAddGuest` · assignTypedName, which links a name already
     * on the list instead of opening a second row); the ids come back into the Trupp, so the card
     * and the Personalblatt are one person. */
    // (shared with the Trupp sheet since 26.09.2026 — lib/truppQuickEdit · fileGuestSlots)
    const fileGuests = (): Pick<TruppFields, 'leaderPersonId' | 'memberPersonIds'> => fileGuestSlots(team, onAddGuest)
    /* ⚠️ The draft is dropped only once the board SAYS the Trupp was written (staging walk-through
     * 25.09.2026): a question in front of the save — a Leitung another Trupp is on, a field
     * changed on another device, «Überwachung beenden?» — answered «Zurück» used to return to a
     * form that had already thrown everything typed away. */
    void Promise.resolve(onSubmit(fields, standby, { touched: truppFieldGroupsChanged(pristine, fields), fileGuests }))
      .then((saved) => { if (saved !== false) dropDraft() })
  }

  /**
   * Why the save did not happen, said WHERE the save is — a line right above the footer actions
   * (05.09., field feedback).
   *
   * ⚠️ NOT a toast any more. The app's toast lane is pinned to the bottom of the VIEWPORT, which
   * on this sheet is a pill hanging in the form's own empty space above the footer — and, worse,
   * a pill with `pointer-events: auto` sitting over whatever field happens to be under it. On a
   * phone that is the Auftrag «Art» chips: the first tap on «Löschen» hit the pill instead of the
   * chip, which is the «needs two taps to change the Art» defect. The reason belongs to the form,
   * so it is rendered by the form, anchored to the button it is about.
   *
   * DERIVED, not stored: the sentence is read off the same fields in the same precedence
   * `canSubmit` and `attemptSubmit` check, so it can never go stale — fixing the Mannschaft while
   * the Auftrag is still open re-reads as «Auftrag fehlt.» rather than keeping the answer to a
   * question that has been answered. All the state is whether a blocked tap has happened at all.
   * (The double assignment is the one reason with no line here: it already prints its own
   * sentence on the form, and saying it twice is not saying it louder.)
   */
  const [blockedShown, setBlockedShown] = useState(false)
  const blocked = !blockedShown || canSubmit || assignedConflict ? null
    : !leaderOk ? az.saveBlockedTeam
    : !auftragOk ? az.saveBlockedAuftrag
    : showPressure && !pressureLocked && pressure <= 0 ? az.saveBlockedPressure
    : !bottleOk ? az.saveBlockedBottle
    : null

  /** Retrigger the same flash-ring `focusSection` gives an opened section (`.formFlash` above),
   *  imperatively — a second blocked tap must ring again, which a className tied to render state
   *  alone cannot do without a remount. Mirrors the identical remove/reflow/add idiom the board's
   *  own card flash uses (AtemschutzView · TruppCard/TruppRow) for the same reason. */
  const flashSection = (el: HTMLElement | null) => {
    if (!el) return
    // ⚠️ Only when it is actually out of view (05.09.). A smooth scroll that has nowhere to go
    // still runs, and iOS spends the next tap on stopping it — so ringing a field that was on
    // screen all along cost the operator their first tap on it.
    if (!inScrollPort(el)) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove(s.formFlash)
    void el.offsetWidth
    el.classList.add(s.formFlash)
    window.setTimeout(() => el.classList.remove(s.formFlash), 1900)
  }
  /** Point at the field that blocks the save — scroll it into view and ring it. (The phone
   *  form is flat since 08.09., so there is no collapsed section left to open first.) */
  const pointAt = (el: () => HTMLElement | null) => flashSection(el())
  /**
   * «Speichern» while the Trupp isn't valid yet used to just sit there disabled — with Art
   * «Anderes» and an empty Auftrag/Ziel, nothing on screen said why (field feedback, 02.09.:
   * «weil ich 'Anderes' gewählt habe … Evtl. auch hier ein Blink, Blink → Hinweis»). The button
   * is no longer natively `disabled` (which swallows the tap outright and cannot explain
   * itself, and the OS-notification affordance for that ANYWAY-focusable state is `aria-disabled`
   * instead) — a blocked tap now points at and flashes the one field actually holding it back,
   * in the same precedence `canSubmit` itself checks. On the stack a reason that lives in a
   * collapsed section opens that section first (`pointAt`).
   */
  /* ── The ONE plausibility question (24.09.2026, item 2) ───────────────────────────────────────
   * An Eingangsdruck below the station's minimum (`doctrine.entryPressureMin`, /admin › Doktrin)
   * — at the Anmeldung, on a re-entry with a NEW cylinder, or corrected while the Trupp is inside
   * or registered — asks once, with the value on the button: «180 bar ist für einen Eintritt tief
   * (Station: ab 270). Stimmt das, …» «Ändern» / «180 bestätigen». No upper bound, and no second
   * rule: the review decided on exactly one. «Gleiche Flasche» is not asked about (its bar is the
   * Restdruck, low by definition), nor is an edit that leaves the number alone, nor a value this
   * form already had confirmed. */
  const [lowConfirmed, setLowConfirmed] = useState<number | null>(null)
  /* The Eingangsdruck was SET on purpose in this form — dialled, typed, a bottle answer. Kept
   * with the draft (a pushed-away form comes back with it); it marks the log row `measured`
   * (types · TruppFields.pressureMeasured). */
  const [pressureSet, setPressureSet, clearPressureSet] = useKeptState<boolean>(`${draftKey}:pressureSet`, false)
  const entryIsAsked = showPressure && !pressureLocked
    && (mode === 'create' || (mode === 'redeploy' && bottle !== 'same')
      || (mode === 'edit' && (upgrading || pressure !== initial?.entryPressureBar)))
  const lowEntryAsks = entryIsAsked && pressure !== lowConfirmed && entryPressureAsks(pressure, atemschutzDoctrine())
  const askLowEntry = async (): Promise<boolean> => {
    const dz = atemschutzDoctrine()
    // a title stating the fact, one line with the two numbers, the value on the button (owner
    // review 26.09.2026: the paragraph about the coming alarm was read by nobody)
    const ok = await confirmDialog({
      title: az.entryLowTitle,
      message: fillTemplate(az.entryLowMsg, { bar: pressure, min: dz.entryPressureMin }),
      confirmLabel: fillTemplate(az.entryLowConfirm, { bar: pressure }),
      cancelLabel: az.entryLowChange,
      // «Ändern» is the answer an Enter or a reflex tap gives — the value stays in the form
      safeAnswer: 'cancel',
    })
    if (ok) { setLowConfirmed(pressure); return true }
    // «Ändern»: straight back to the number — the Druck sheet, opened on the value it asked about
    setPicker('pressure')
    return false
  }

  const attemptSubmit = (standby = false) => {
    if (canSubmit) {
      setBlockedShown(false)
      // synchronous unless the question is due — a save with nothing to ask stays one tap, now
      if (lowEntryAsks) { void askLowEntry().then((ok) => { if (ok) submit(standby) }); return }
      submit(standby)
      return
    }
    if (!leaderOk) {
      setBlockedShown(true)
      pointAt(() => teamRef.current)
      return
    }
    // the conflict already prints its own sentence right on the form (see below) — a second copy
    // of it above the footer would say the same thing twice, so this only points at it AND at
    // the Mannschaft, where taking the named person out of this Trupp actually happens.
    if (assignedConflict) {
      setBlockedShown(false)
      pointAt(() => teamRef.current)
      flashSection(conflictRef.current)
      return
    }
    // ⚠️ NO dead disabled button: «Anderes» without its word points at the Auftrag, rings both
    // halves of the answer and puts the focus on the first Auftrag tile — the same place the
    // card's «Auftrag offen» pill sends the operator. The tiles, not the Ziel field: focusing a
    // text input here throws the on-screen keyboard over the rest of the form (see the note at
    // «No autofocus» above).
    if (!auftragOk) {
      setBlockedShown(true)
      pointAt(() => auftragRef.current)
      flashSection(zielRef.current)
      auftragRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
      return
    }
    if ((showPressure && pressure <= 0) || !bottleOk) {
      setBlockedShown(true)
      pointAt(() => pressureRef.current)
    }
  }

  const title = mode === 'edit' ? az.formEditTitle : mode === 'redeploy' ? az.formRedeployTitle : az.formCreateTitle
  const submitLabel = mode === 'edit' ? az.save : mode === 'redeploy' ? az.reenterSubmit : az.start

  /* ── The three groups of fields ───────────────────────────────────────────────────────────
   * Written once and placed twice: on one screen they fill the two columns, on the stack they
   * are the bodies of the three sections. That is what keeps the two layouts the same form —
   * same fields, same order, same words, only a different way of reaching them. */
  /* ⚠️ In EVERY mode of this form (04.09.): creating one, editing one, and sending one back in —
   * see the note at `kind` above for why the re-deploy fork was reversed the same day. The one
   * place it is not asked is the handed-over Tafel, whose whole board is Atemschutz (`lite`).
   * Everything downstream already follows the answer rather than the record: the Druck field and
   * the submit gate (`showPressure`), the Auftrag vocabulary, and «Bereitstellen», which is a
   * Sicherungstrupp and therefore under PA by definition. */
  /* A compact pair at the HEAD's right since 08.09. (field ask): the two big tiles with their
     explainer subtitles said what every AdF already knows, and cost the form its first row.
     The words alone carry it — since 27.09.2026 without the «Art des Trupps» label over them
     (slim sweep 6): «Unter Atemschutz / Ohne Atemschutz» name themselves, and the label stood
     directly over «Art», two «Art»s in a row. It stays the radiogroup's NAME for a screen reader.
     The buttons keep the TILE chrome the form has always worn
     (bordered `--surface` cards, ink outline + faint ink wash on the chosen one), just at a
     header's size. Deliberately NOT the Segmented track: the Art is which of two THINGS is
     being registered, not a property toggle — the same argument the original tiles made.
     `pickKind` still re-seeds the Funkkanal while it is the untouched default. */
  const kindChooser = !lite ? (
    <div className={s.kindHeadSeg} role="radiogroup" aria-label={az.kindLabel}>
      {/* THE choice chip (a radio here, so `aria-checked` speaks and `aria-pressed` stays off) */}
      <Chip role="radio" selected={isPa} aria-pressed={undefined} aria-checked={isPa}
        className={s.kindHeadOpt} onClick={() => pickKind('atemschutz')}>{az.kindAtemschutz}</Chip>
      <Chip role="radio" selected={!isPa} aria-pressed={undefined} aria-checked={!isPa}
        className={s.kindHeadOpt} onClick={() => pickKind('einfach')}>{az.kindPlain}</Chip>
    </div>
  ) : null

  const teamFields = (
    <div ref={teamRef} className={s.field} onFocus={onTeamFocusChange(true)} onBlur={onTeamFocusChange(false)}>
      <span>{az.sectionTeam}</span>
      {/* One list, leader first. A Trupp is valid with exactly one name (the Gruppenführer),
          so a two-person Trupp, a four-person Trupp and a mis-tap are all one tap apart —
          which the three fixed slots could not do.
          ⚠️ `phone` is the same `stack` that decides the three-section form (05.09.): on 375px
          the Mannschaft is a wrapping chip row and the roster appears only under a typed query.
          Same record, same handlers — see TruppTeam · `phone`. */}
      <TruppTeam
        value={team} onChange={changeTeam} phone={stack} wanted={mode === 'create'} searchInputRef={teamSearchRef}
        personnel={personnel} legacyRoster={roster} presentIds={presentIds} stationIds={stationIds}
        assignedIds={assignedIds} rolesById={rolesById}
      />
    </div>
  )

  // ⚠️ An UPGRADE asks for a FIRST Eingangsdruck, never «korrigieren» — the latter would claim the
  // Trupp already had one (04.09.). The row's word and the Druck sheet's title (the question).
  const pressureFieldLabel = mode === 'redeploy' ? az.newPressureLabel
    : isEdit && !upgrading ? az.editPressureLabel : az.pressureLabel
  // the number sheets' second head line — whose (lib/truppQuickEdit · truppSheetSub), or the leader picked so far
  const pickSub = initial ? truppSheetSub(initial) : team[0]?.name.trim() || undefined
  const pickPressure = (v: number) => {
    setPressure(v); setPressureSet(true)
    if (bottleAsk && !bottle) setBottle('new')
    setPicker(null)
  }
  /* Eingangsdruck and Funkkanal: ONE row each, in every mode — «Eingangsdruck 300 bar ›»,
   * «Funkkanal 11 ›» (30.09.2026) — and the row opens the sheet that asks it everywhere else: the
   * Druck sheet's 20-bar grid, the Kanal sheet's pad (`picker`, the sheets are rendered by the form
   * body). The rows always read the ACTUAL values, so nothing true is hidden behind a fold. */
  const luftFields = (
    <>
      {pressureLocked && (
        // «300 bar 🔒» and ONE line why (owner review 26.09.2026) — the number, the lock, the Restdruck
        <div ref={pressureRef} className={s.field}>
          <span>{az.pressureLockedLabelPlain}</span>
          <div className={s.pressureLocked}>
            <b>{initial!.entryPressureBar} bar</b>
            <Icon id="lock" className={s.pressureLockedIcon} />
          </div>
          <p className={s.fieldNote}>{lockedExit
            ? fillTemplate(az.pressureLockedWhyExit, { bar: lockedExit.bar })
            : az.pressureLocked}</p>
        </div>
      )}
      {showPressure && !pressureLocked && (
        <div ref={pressureRef} className={s.field}>
          {bottleAsk && (
            <div className={s.bottleAsk}>
              <p>{fillTemplate(outMin! < 1 ? az.bottleAskNow : az.bottleAsk, { min: String(outMin), bar: String(lastExit!.bar) })}</p>
              <div className={s.bottleBtns}>
                <button type="button" className={cx(s.bottleBtn, bottle === 'same' && s.bottleOn)}
                  onClick={() => { setBottle('same'); setPressure(lastExit!.bar); setPressureSet(true) }}>
                  {az.bottleSame}<b>{lastExit!.bar} bar</b>
                </button>
                <button type="button" className={cx(s.bottleBtn, bottle === 'new' && s.bottleOn)}
                  onClick={() => { setBottle('new'); setPressure(atemschutzDoctrine().defaultPressureBar); setPressureSet(true) }}>
                  {az.bottleNew}<b>{atemschutzDoctrine().defaultPressureBar} bar</b>
                </button>
              </div>
            </div>
          )}
          <div className={s.pickRow}>
            <button type="button" className="row-go" aria-haspopup="dialog" onClick={() => setPicker('pressure')}
              aria-label={`${pressureFieldLabel} ${fillTemplate(az.stackPressure, { n: pressure })}`}>
              <span className="row-go-text">{pressureFieldLabel}</span>
              <span className={s.pickRowValue}>{fillTemplate(az.stackPressure, { n: pressure })}</span>
              <span className="row-go-word"><Icon id="chevron" /></span>
            </button>
          </div>
          {/* said out loud, because the same grid on the CARD does the opposite: there it is a
              Druckmeldung and resets the contact clock. Here it corrects the record. */}
          {isEdit && !upgrading && <p className={s.fieldNote}>{az.editPressureHint}</p>}
        </div>
      )}
      {/* Kanal rides with the Druck: the pair you set on every single Trupp.
          ⚠️ No section headings in here. Uppercase labels over rules cut the form into boxes and
          each rule cost a row; every field already says what it is. */}
      <div className={s.pickRow}>
        <button type="button" className="row-go" aria-haspopup="dialog" onClick={() => setPicker('kanal')}
          aria-label={`${az.funkkanalSection} ${funkkanal}`}>
          <span className="row-go-text">{az.funkkanalSection}</span>
          <span className={s.pickRowValue}>{funkkanal}</span>
          <span className="row-go-word"><Icon id="chevron" /></span>
        </button>
      </div>
    </>
  )

  /* The two number sheets over the form. ⚠️ Rendered INSIDE the form's popup, so they are nested
   * dialogs (a tap in them is not an outside press that closes the form); and the host stops the
   * pointerdown on its way up the React tree — a portal's events still bubble through it, and the
   * form's own swipe-to-close would have dragged the form down under the sheet's drag. */
  const pickers = picker && (
    <span className={s.pickHost} onPointerDown={(e) => e.stopPropagation()}>
      {picker === 'pressure' ? (
        <PressureSheet sub={pickSub} title={pressureFieldLabel} hint={az.kanalSheetHint} last={pressure} chosen
          alarmBar={atemschutzDoctrine().alarmBar} onPick={pickPressure} onClose={() => setPicker(null)} />
      ) : (
        <KanalPickSheet value={funkkanal} sub={pickSub} takeLabel={az.formPickTake}
          onPick={(n) => { setFunkkanal(n); return true }} onClose={() => setPicker(null)} />
      )}
    </span>
  )

  const auftragFields = (
    <>
      {/* «Auftrag offen» flashes BOTH halves of the answer — «Art» AND «Auftrag / Ziel»
          (field decision 30.08.): the gap on the card is the pair, not one field. */}
      <div ref={auftragRef} className={cx(s.field, focusSection === 'auftrag' && s.formFlash)}>
        <span>{az.auftragLabel}</span>
        {/* The list that matches the Trupp's KIND — a Verkehrstrupp was being offered «Löschen»
            (field report 03.09.). Both lists are six tiles, so the form keeps its shape; and
            `sichern`/`anderes` are literally the same id on both sides, so switching the tiles
            above cannot invalidate a value that is already picked. */}
        <Segmented
          ariaLabel={az.auftragLabel}
          value={auftrag ?? undefined}
          onChange={(v) => setAuftrag(v)}
          options={auftragTypes.map((a) => ({ value: a.id, label: az.auftragLabels[a.id] ?? a.label }))}
        />
      </div>
      <label ref={zielRef} className={cx(s.field, focusSection === 'auftrag' && s.formFlash)}>
        <span>{az.zielLabel}</span>
        {/* ✕: a Trupp that comes back and goes in again gets a NEW order, and the old one is not
            a starting point for typing it — «2. OG Wohnung Nord, 2 Personen vermisst» had to be
            select-all-deleted by hand on a phone, mid-Einsatz. */}
        {/* ⚠️ ONE placeholder, for every Auftrag and both Arten (03.09.). It used to switch —
            «z. B. 2OG links» normally, the generic sentence only under «Anderes» — and a storey
            reference is Atemschutz vocabulary: under Auftrag «Verkehr» the example proposed a
            place that does not exist there. */}
        <ClearableInput
          value={ziel} placeholder={az.zielPlaceholder}
          // caps chosen so the card's one-line Ziel and the Leitung chip can't be blown out:
          // «2. OG Wohnung Nord, 2 Personen vermisst» is 39 chars, a Leitung is «1»–«12»
          maxLength={60}
          clearLabel={az.zielClear}
          onChange={(v) => setZiel(stripUnprintable(v))}
        />
      </label>
      {/* Ausrüstung — multi-select chips: selected = filled, unselected = framed, the SAME chip the
          Trupp sheet draws (TruppSheets · TruppSheet, `<Chip>`). The tick box they wore until
          27.09.2026 (mock 14.09.) was a second state mark inside a chip that already has one; the
          checkbox ROLE stays, because «several go» is what a screen reader has to hear. Only under
          Atemschutz: a work squad takes no Retthaube in. The list comes from the station
          (deploymentConfig · atemschutzEquipment). */}
      {isPa && (
        <div className={s.field}>
          <span>{az.equipmentLabel}</span>
          <div className={s.miniChips} role="group" aria-label={az.equipmentLabel}>
            {atemschutzEquipment().map((e) => {
              const on = equipment.includes(e.id)
              return (
                <Chip key={e.id} role="checkbox" selected={on} aria-pressed={undefined} aria-checked={on}
                  onClick={() => toggleEquipment(e.id)}>
                  {az.equipmentLabels[e.id] ?? e.label}
                </Chip>
              )
            })}
          </div>
        </div>
      )}
      {/* The SAME 1–99 number the DrawEditor stamps on a hose — one type on both sides is what
          lets a Trupp and a drawn Leitung find each other without anyone re-typing anything
          (lib/truppLines). A Trupp recorded before this was free text keeps its text below; it
          is never rewritten.
          ⚠️ NOT on the lite form (reverted, round 2 review — briefly shown 02.09.): a link
          holder has no picture to read a hose number off and no surface to draw one on, so the
          field could only ever be a number typed blind — and one Leitung, one Trupp is enforced
          against what is actually drawn regardless (see submitForm's takeover confirm). The FU
          sets it on the KP tablet.
          ⚠️ Since 04.09. the Leitung belongs to THIS group rather than to a section of its own:
          it is part of what the Trupp is doing, and the Farbe it used to share a block with is
          gone (see `color` in submit). */}
      {!lite && (
        /* ONE field with the Auftrag sheet (TruppSheets · LeitungField, 29.09.2026): «keine», the
           Leitungen actually DRAWN («Ltg 1 · Müller H.»), and «Nr. …» for a number nobody has drawn
           yet — typing a number blind is how the two sides end up disagreeing */
        <LeitungField label={az.lineNoLabel} value={lineNo} options={leitungOptions} onChange={setLineNo}>
          {legacyLine && <p className={s.fieldNote}>{fillTemplate(az.lineLegacyNote, { value: legacyLine })}</p>}
        </LeitungField>
      )}
    </>
  )

  // The form itself — head, fields, the blocked line, the footer. On the phone board it sits in a
  // bottom sheet under the pinned clocks (`sheet`), everywhere else it IS the dialog frame.
  const formBody = (
    <>
      <div className={s.modalHead}>
        <h3>{title}</h3>
        <button className="ip-x" aria-label={az.cancel} onClick={onCancel}><Icon id="close" /></button>
      </div>
      <div className={s.modalBody}>
        {stack ? (
          /* ── PHONE: ONE flat column (08.09., field ask) — the three collapsible sections
             went with the space problem they were built for: the Mannschaft is the search +
             a populate-on-pick list, Druck/Kanal sit folded in the Standard line, so the
             whole form stands in one scroll. ORDER: who goes in first, then the Art as its
             own labelled section (it governs the Auftrag vocabulary right below it), then
             Auftrag / Ziel / Leitung, the folded Standard row last. */
          <div className={s.stack}>
            {teamFields}
            {kindChooser && <div className={cx(s.field, s.kindField)}>{kindChooser}</div>}
            {auftragFields}
            {luftFields}
          </div>
        ) : (<>
          {/* ── ONE SCREEN (tablet, desktop): nothing has to be walked to, and the whole Trupp
              is visible while it is being formed. RIGHT-COLUMN ORDER (08.09.): the Art leads
              as its own section (it governs the Auftrag vocabulary below it), then Auftrag /
              Ziel / Leitung — and the folded Standard row goes LAST: defaults that are checked,
              not typed, sit after everything that is actually asked. */}
          <div className={s.formCol}>{teamFields}</div>
          <div className={s.formCol}>
            {kindChooser && <div className={cx(s.field, s.kindField)}>{kindChooser}</div>}
            {auftragFields}
            {luftFields}
          </div>
        </>)}

        {/* ⚠️ TAPPABLE since 05.09. The sentence names a person who is in another Trupp, and the
            only place that can be fixed is the Mannschaft — so pressing the sentence opens it,
            the same jump a blocked «Trupp anmelden» now makes. It used to be an inert <p>: the
            loudest thing on the form, naming the one thing in the way, and doing nothing.
            ⚠️ …and since 11.09. it carries the FIX rather than only the way to it: «In diesen
            Trupp verschieben» takes the person out of the other Trupp, which is the whole errand
            the jump was sending the operator on. The sentence keeps its own tap — with the action
            withheld (the other crew is out there) it is the only door left. Two buttons inside
            one warn field, never a button inside a button. */}
        {assignedConflict && (
          <div ref={conflictRef} className={s.formColWide}>
            {/* one row for the form and the Trupp sheet (TruppSheets · TeamConflictRow, 26.09.2026) */}
            <TeamConflictRow conflict={assignedConflict} toName={team[0]?.name.trim() ?? ''}
              onPoint={() => pointAt(() => teamRef.current)} onTransfer={onTransfer} />
          </div>
        )}
      </div>

      {/* Why the save did not happen, where the save is — see `blocked` above for why this is not
          a toast. `role="alert"` so it is spoken the moment it appears, exactly as the toast was. */}
      {blocked && (
        <p className={cx('form-warn', s.formBlocked)} role="alert">
          <Icon id="warn" /><span>{blocked}</span>
        </p>
      )}
      {/* The Auftrag is missing but nothing is blocked (15.09.) — the same line, amber: the Trupp
          registers as «Auftrag offen». `role="status"`, not alert: it is there from the first
          render of a fresh form and must not be shouted over the field the operator is filling. */}
      {!blocked && auftragMissing && (
        <p className={cx('form-warn form-warn-amber', s.formBlocked, teamSearchFocused && s.formHintWaiting)} role="status"
          aria-hidden={teamSearchFocused || undefined}>
          <Icon id="warn" /><span>{az.auftragMissingHint}</span>
        </p>
      )}

      {/* the sheet's own footer row, so it pays the phone's safe area like every other (SheetFoot) */}
      <SheetFoot className={s.modalFoot}>
        {/* the house button family — three private classes here were the last of this modal's
            own design system (see Atemschutz.module.css · .modal) */}
        {/* the ONLY control that throws the draft away — ✕ and the backdrop keep it */}
        <button className={cx('ip-btn', s.footCancel)} onClick={() => { dropDraft(); onCancel() }}>{az.cancel}</button>
        {/* Re-deploy forks here: a re-equipped Trupp is just as often held back as
            Sicherungstrupp as it is sent straight in. Both buttons take the same filled-in form,
            so the choice costs nothing — and «Bereitstellen» is the one that must NOT start a
            contact clock. It is also what actually happens first: a Trupp comes out, gets a
            fresh bottle and waits. So on re-deploy «Bereitstellen» carries the primary weight
            and «Einrücken» steps back — the ORDER stays as it was, only the emphasis swaps, so
            nobody has to re-learn where the button is. */}
        {/* ⚠️ Under PA only. «Bereitstellen» exists because a re-equipped Trupp is as often held
            back as Sicherungstrupp as it is sent in — and a Sicherungstrupp is by definition a
            crew standing by under Atemschutz. A work squad has one way back in. */}
        {mode === 'redeploy' && isPa && (
          <button className={cx('ip-btn primary', !canSubmit && s.btnBlocked)} aria-disabled={!canSubmit}
            onClick={() => attemptSubmit(true)} title={az.reenterStandbyHint}>
            {az.reenterStandby}
          </button>
        )}
        {/* ⚠️ `aria-disabled`, not `disabled` (field feedback, 02.09.): a native `disabled`
            button swallows the tap before it ever reaches a handler, which is exactly what left
            «Speichern» unresponsive with nothing to explain why. This one stays clickable and
            `attemptSubmit` decides — flash the missing field when blocked, submit when not.
            ⚠️ …and since 04.09. it is the ONLY forward control on a phone as well: there is no
            «Weiter» in front of it any more. */}
        <button className={cx(mode === 'redeploy' && isPa ? 'ip-btn' : 'ip-btn primary', !canSubmit && s.btnBlocked)}
          aria-disabled={!canSubmit} onClick={() => attemptSubmit()}>{submitLabel}</button>
      </SheetFoot>
      {pickers}
    </>
  )

  // portal to <body> so the modal escapes the .surface stacking context (z-index 20) and covers
  // the TopBar ("+ Eintrag", z-index 40) instead of rendering beneath it
  /* ⚠️ On the phone board (`sheet`, 24.09.2026, D1 ⑥) the popup is a transparent column: the
   * pinned due Trupps on top, then the sheet with its grab bar. The pinned rows live INSIDE the
   * popup on purpose — outside it they would sit under the scrim, their taps would be «outside
   * presses» that close the form, and the focus trap would keep the keyboard off them. Swipe to
   * close is the primitive's own (overlays/swipeDismiss): the popup is flush with the bottom edge
   * and leaves headroom, so it measures as a bottom sheet; the pinned block opts out of starting
   * the gesture (`data-swipe-ignore`). */
  return (
    <Overlay open onClose={onCancel} className={cx(s.modal, stack && s.modalStack, sheet && s.modalSheet)} ariaLabel={title}
      initialFocus={focusTeamFirst ? teamSearchRef : undefined} swipeToClose={sheet}>
      {sheet ? (
        <>
          {pinned}
          <div className={s.sheetFrame}>
            <SheetGrab />
            {formBody}
          </div>
        </>
      ) : formBody}
    </Overlay>
  )
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return formatTime(d)
}
