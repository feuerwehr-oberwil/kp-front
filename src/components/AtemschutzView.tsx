import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime, stripUnprintable } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import { cx } from '../lib/cx'
import { Segmented } from './Segmented'
import { Stepper } from './Stepper'
import { Menu, Overlay } from '../lib/overlays'
import { alarmBarFor, currentRunStart, deriveTruppLive, estimatePressure, fmtClock, isAtemschutzTrupp, pressureAlarm, truppAlarm, type TruppAlarm, type TruppLive } from '../lib/atemschutz'
import { serverNow } from '../lib/serverClock'
import { isPresent } from '../lib/attendanceIntervals'
import { ortOf } from '../lib/attendanceOrt'
import { readingBarIsMeasured, truppAuftragLabel, truppStatusLabel } from '../lib/report'
import { useIsPhone } from '../lib/useIsPhone'
import type { AttendanceState, Person, Trupp, TruppAuftrag, TruppFields, TruppKind } from '../types'
import { abbreviateName, assignedPersonIds, personIdForName, rosterFromList, rosterIdByName, truppSlots } from '../lib/personnel'
import { truppLineNo, type LeitungOption } from '../lib/truppLines'
import type { MarkerOption } from '../lib/placedTrupps'
import { ClearableInput } from './ClearableInput'
import type { Slot } from './PersonField'
import { TruppTeam } from './TruppTeam'
import { ensureNotifyPermission, notificationsSupported, unlockAlarm } from '../lib/alarm'
import { atemschutzDoctrine, isDemoMode } from '../lib/deploymentConfig'
import type { SyncStatus } from '../lib/api/workspaceSync'
import { CLOCK_SKEW_WARN_MIN } from '../lib/syncAlert'
import { useKeptState } from '../lib/draftKeep'
import { useHoldRepeat } from '../lib/useHoldRepeat'
import { truppOrderKey } from '../lib/useTruppActions'
import { useTapToType } from '../lib/useTapToType'
import s from './Atemschutz.module.css'

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

type FormMode = 'create' | 'edit' | 'redeploy'

/** How the board is arranged — mirrors Prefs.atemschutzOrder. */
export type TruppOrder = 'dringlichkeit' | 'manuell' | 'auftrag' | 'name'

/** snap a raw bar value to the step grid, clamped to [0, ceiling] */
function snapBar(v: number): number {
  const dz = atemschutzDoctrine()
  return Math.max(0, Math.min(dz.pressureMax, Math.round(v / dz.pressureStep) * dz.pressureStep))
}

// The Atemschutzüberwachung surface: the digital Atemschutz-Überwachungstafel. Swiss FKS model
// — one big glanceable card per Trupp whose dominant element is TIME SINCE LAST FUNKKONTAKT, a
// large "Kontakt" reset, and a contact-clock alarm (amber nudge → red überfällig). Pressure is
// set inline and logged. Purely presentational + local UI state — data + mutations via props.
export function AtemschutzView({
  trupps: allTrupps, truppColors, canEdit, personnel, attendance, muted, onToggleMuted, audioBlocked = false, onUnlockAudio, onAddGuest, order = 'manuell', onOrder, onMove, createTrupp, placeTrupp, placeTargets, markerOptions, adoptMarker, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, reactivateTrupp, deleteTrupp, restoreTrupp, removedTrupps: allRemovedTrupps = [], leitungOptions, showTruppLine, truppsWithLine, lineNoOf, pickTruppLine, unlinkTruppLine,
  intervalMin = atemschutzDoctrine().contactIntervalMin, graceSec = atemschutzDoctrine().contactGraceSec,
  defaultFunkkanal = atemschutzDoctrine().defaultFunkkanal,
  focus, onShareLink, shareLinkActive = false, lite,
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
  setTruppStatus: (id: string, status: Trupp['status']) => void
  editTrupp: (id: string, f: TruppFields) => void
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
  /** arm «Leitung wählen»: the next tap on a hose line (Lage or Plan) links it to this Trupp */
  pickTruppLine: (id: string) => void
  /** release a Trupp's Leitung — used when another Trupp takes it over (confirmed Ablösung) */
  unlinkTruppLine: (id: string) => void
  /** put a hand-typed Gast on the Anwesenheit — a Gast under PA was at the Einsatz, and a name
   *  that only ever existed on a Trupp card reaches neither the Personalblatt nor the export */
  onAddGuest?: (name: string) => string | undefined
  /** «point at THAT Trupp» — set by a locked Anwesenheit row. The nonce makes a repeat tap point
   *  again; the card scrolls itself into view and flashes, then the mark clears on its own. */
  focus?: { id: string; nonce: number } | null
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
  }
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
  const [form, setForm] = useState<{ mode: FormMode; trupp?: Trupp; focus?: 'auftrag' } | null>(null)
  /**
   * «zeig mir den» from THIS surface — the header's überfällig badge. The `focus` prop covers
   * the jump in from somewhere else (a locked Anwesenheit row); this is the same mark set from
   * inside, so the badge behaves like the app-wide TopBar chip it mirrors instead of being the
   * one warning on the screen that does nothing when you press it.
   *
   * The later nonce wins, so whichever pointed last is the one the board obeys.
   */
  const [selfFocus, setSelfFocus] = useState<{ id: string; nonce: number } | null>(null)
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
  const [now, setNow] = useState(() => serverNow())
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000)
    return () => clearInterval(t)
  }, [])

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
  const alarms = useMemo(
    () => new Map(trupps.map((t) => [t.id, truppAlarm(t, live.get(t.id)!, intervalMin, graceSec, { alarmBar, alarmBarRueckzug })] as const)),
    [trupps, live, intervalMin, graceSec, alarmBar, alarmBarRueckzug],
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
      return (truppAuftragLabel(a.auftrag) ?? '￿').localeCompare(truppAuftragLabel(b.auftrag) ?? '￿', 'de') || orderKey(a) - orderKey(b)
    }
    if (order === 'dringlichkeit') {
      // the tier first, then how far past its own line — the ranking the badge and the TopBar
      // chip use, so «Dringlichkeit» means the same thing everywhere it is spoken
      const tier = sevOf(b.id) - sevOf(a.id)
      if (tier) return tier
      const by = urgency(b) - urgency(a)
      if (by) return by
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
  const freezeTimer = useRef<number | undefined>(undefined)

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

  // Called from the card's action handlers — i.e. after render, so it simply closes over the
  // arrangement the operator is currently looking at. (A ref would have to be written during
  // render, which is exactly what react-hooks/refs warns about.)
  const freezeOrder = () => {
    setFrozenIds(board.map((t) => t.id))
    window.clearTimeout(freezeTimer.current)
    freezeTimer.current = window.setTimeout(() => setFrozenIds(null), FREEZE_MS)
  }
  useEffect(() => () => window.clearTimeout(freezeTimer.current), [])

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
  const openForm = (mode: FormMode, trupp?: Trupp, focus?: 'auftrag') => {
    unlockAlarm(); void ensureNotifyPermission(); setForm({ mode, trupp, focus })
  }

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
    unlockAlarm(); void ensureNotifyPermission()
  }

  const submitForm = async (f: TruppFields, standby = false) => {
    if (!form) return
    // One Leitung, one Trupp. Typing a number that someone else is already on used to save
    // silently and leave two Trupps claiming one hose — the tag then picked one of them and the
    // Überwacher had no way of knowing. Name both and let the operator decide: a takeover IS the
    // normal case (Ablösung), it just has to be said out loud. Cancel returns to the form with
    // everything still typed.
    const clash = f.lineNo == null ? undefined
      : trupps.find((t) => t.id !== form.trupp?.id && t.status !== 'raus' && truppLineNo(t) === f.lineNo)
    if (clash) {
      const ok = await confirmDialog({
        title: fillTemplate(az.lineTakeTitle, { n: String(f.lineNo) }),
        message: fillTemplate(az.lineTakeMsg, { n: String(f.lineNo), from: clash.name, to: f.name }),
        confirmLabel: az.lineTakeConfirm,
        cancelLabel: appConfig.copy.cancel,
      })
      if (!ok) return
      unlinkTruppLine(clash.id) // the previous Trupp lets go — its Leitung is now this one's
    }
    if (form.mode === 'create') {
      createTrupp({
        id: `tr${Date.now()}`,
        // ⚠️ WRITTEN ONLY for the new kind. Absent means «unter Atemschutz» (types · TruppKind),
        // and stamping the default onto every new Trupp would make the blob claim a decision
        // nobody made — and make every pre-03.09. record look different from a fresh one.
        ...(f.kind === 'einfach' ? { kind: f.kind } : {}),
        name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNo: f.lineNo, funkkanal: f.funkkanal,
        leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds,
        entryPressureBar: f.pressure, entryTime: '', lastContactTime: '', lowestBar: f.pressure,
        status: 'angemeldet', readings: [],
      })
    } else if (form.mode === 'edit' && form.trupp) {
      editTrupp(form.trupp.id, f)
    } else if (form.mode === 'redeploy' && form.trupp) {
      reactivateTrupp(form.trupp.id, f, standby)
    }
    setForm(null)
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
  const [picked, setPicked] = useState<string | null>(null)
  const focusId = focusMode
    ? (picked && board.some((t) => t.id === picked) ? picked : board[0]?.id ?? null)
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
  useEffect(() => {
    const list = listRef.current, port = bodyRef.current
    if (!list || !port) return
    if (!compact || !openRow) { list.style.removeProperty('--az-open-pad'); return }
    const card = list.querySelector<HTMLElement>('[data-az-open]')
    if (!card) return
    list.style.setProperty('--az-open-pad', `${Math.max(0, port.clientHeight - card.offsetHeight - 16)}px`)
    card.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [compact, openRow])

  const cards = (list: Trupp[]) => list.map((t) => (
    compact && !focusMode && openRow !== t.id ? (
      <TruppRow
        key={t.id} t={t} live={live.get(t.id)!} alarm={alarms.get(t.id)!} now={now} color={truppColors[t.id]} canEdit={canEdit}
        focusNonce={activeFocus?.id === t.id ? activeFocus.nonce : undefined}
        onContact={(id) => { freezeOrder(); recordContact(id) }}
        onOpen={() => setOpenRow(t.id)}
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
      intervalMin={intervalMin}
      focusNonce={activeFocus?.id === t.id ? activeFocus.nonce : undefined}
      onContact={(id) => { freezeOrder(); recordContact(id) }}
      onPressure={(id, bar) => { freezeOrder(); recordPressure(id, bar) }}
      onStatus={(id, s) => { freezeOrder(); setTruppStatus(id, s) }}
      onEdit={(focus) => openForm('edit', t, focus)} onReenter={() => openForm('redeploy', t)}
      onDelete={deleteTrupp} onRestore={restoreTrupp} onPlace={handlePlace} onShowPlan={focusTruppOnPlan}
      onMove={order === 'manuell' && !compact ? onMove : undefined}
      onPickLine={pickTruppLine}
      onShowLine={showTruppLine} hasLine={truppsWithLine.has(t.id)} drawnLineNo={lineNoOf?.get(t.id)}
      // «Tafel pur»: everything that points at the Karte or a drawn Leitung is unreachable from
      // this session, and a control that will fail is worse than no control (see `lite` above).
      lite={!!lite}
      onCollapse={compact && !focusMode ? () => setOpenRow(null) : undefined}
      big={focusMode}
    />
    )
  ))

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
      onClick={audioBlocked ? onUnlockAudio : onToggleMuted}
      aria-pressed={muted}
      aria-label={bellLabel} title={bellLabel}
    >
      <Icon id={muted ? 'bell-off' : 'bell'} />
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
  const syncLine = (syncStatus || skewLoud) && (
    <div className="az-syncline">
      {syncStatus === 'synced' || syncStatus === 'pending' ? (
        <span className={cx('az-sync-quiet', syncStatus === 'pending' && 'az-sync-pending')}
          title={syncStatus === 'pending' ? cpSync.badgePending : savedAtText}>
          {syncStatus === 'synced' ? <Icon id="check" /> : <span className="ip-status-dot" />}
          {/* On the lite/phone focus board (mock 03) the header row has no width to spare for
              the whole sentence — the check icon already says «saved», so this shrinks to the
              bare time. The full «Gespeichert um HH:MM» stays in `title` (a11y/hover) and is
              what the tablet header keeps saying out loud (focusMode false). */}
          <span>{focusMode ? (lastSyncedAt != null ? formatTime(new Date(lastSyncedAt)) : null) : savedAtText}</span>
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
    </div>
  )

  return (
    <div className={cx(s.surface, lite && s.surfaceLite)} onPointerDownCapture={primeOnFirstTap}>
      <header className={cx(s.head, focusMode && s.headCompact)}>
        <div className={cx(s.headTitles, focusMode && s.headTitlesCompact)}>
          {focusMode ? (
            /* mock 03: the kicker is GONE here — «Atemschutzüberwachung» cost a whole row's
               height to repeat what the whole screen is already for, and the strip below already
               reads «Trupp». Only the Einsatz's own name earns this line, alongside the shrunk
               sync state (see `syncLine` above); the bell stays right of it, in `.headActs`. */
            <div className={s.headRow}>
              <h2>{lite ? lite.subtitle : az.subtitle}</h2>
              {syncLine}
            </div>
          ) : (
            <>
              {/* ⚠️ «Trupps» in the full app, «Atemschutzüberwachung» on the handed-over Tafel
                  (03.09.). The board carries both sections now, and the old title over a row
                  reading «Verkehr» would have named something that is not there. The link
                  session sees only the Atemschutz, so for it the old title stays TRUE — and it
                  is the one screen whose holder has nothing else telling them what they are
                  looking at. The subtitle is unchanged either way: it describes the half of the
                  board a life depends on. */}
              <h2>{lite ? az.title : az.boardTitle}</h2>
              {/* ⚠️ On the handed-over Tafel the subtitle is the EINSATZ, not the generic sentence
                  about what the board is for. Nothing else on that screen names it, and «welcher
                  Einsatz ist das» is the first question somebody scanning a code from a stranger's
                  tablet has. Not a second header — this line already exists. */}
              <p>{lite ? lite.subtitle : az.subtitle}</p>
              {syncLine}
            </>
          )}
        </div>
        {/* ⚠️ ONE group, not four siblings. `.head` wraps, and as direct children the badge, the
            sort menu, the mute toggle and «Trupp anlegen» wrapped INDIVIDUALLY — on a phone the
            filter stayed up beside the title while the other two dropped to a second row and
            left-aligned under it. Grouped, they wrap as a block and stay together. */}
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
            type="button" className={s.overdueBadge}
            aria-live="assertive"
            title={fillTemplate(az.overdueBadgeGo, { name: mostOverdue.name })}
            aria-label={fillTemplate(az.overdueBadgeGo, { name: mostOverdue.name })}
            onClick={() => setSelfFocus({ id: mostOverdue.id, nonce: Date.now() })}
          >
            <Icon id="warn" /><span>{az.overdueBadge(overdueCount)}</span>
          </button>
        )}
        {/* ⚠️ A MENU, not a segmented control. Four options laid out in full needed ~380px in a
            header that also carries a title, a subtitle, an überfällig badge, the alarm toggle and
            «Neuer Trupp» — so it grew over the subtitle and covered the sentence explaining what
            the board is. A way of LOOKING at the board is not worth a permanent strip of the one
            screen that exists to show overdue Trupps; behind its own icon it costs 44px and the
            current choice still shows as a tick when it is opened. */}
        {trupps.length > 1 && onOrder && !lite && (
          <Menu
            trigger={
              <button type="button" className={s.orderBtn} aria-label={az.orderLabel} title={az.orderLabel}>
                <Icon id="filter" />
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
        {/* ⚠️ The way back that does not expire. Deleting a Trupp raises a «Rückgängig» toast for six
            seconds; miss it — gloves, 3am, a second Trupp overdue — and the card was unreachable,
            even though the record itself keeps it (types · Trupp.removedAt). Shown only while there
            IS something to bring back, so an ordinary board never carries it. */}
        {canEdit && removedTrupps.length > 0 && (
          <Menu
            trigger={
              <button type="button" className={s.orderBtn} aria-label={az.restoreMenu} title={az.restoreMenu}>
                <Icon id="undo" />
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
        {/* «Überwachung abgeben»: the QR, beside the bell, because the realistic handover in an
            Einsatz is «Handy scannen lassen» and the FU is standing on THIS page when they
            decide to. Green while a link is live — the same 44px square as the two controls
            beside it, so the header's right end stays a row of equal targets. */}
        {onShareLink && (
          <button
            type="button"
            className={cx(s.orderBtn, shareLinkActive && s.shareOn)}
            onClick={onShareLink}
            aria-label={shareLabel} title={shareLabel}
          >
            <Icon id="qr" />
          </button>
        )}
        {/* ⚠️ Stays HERE even on the lite/phone focus board (maintainer correction, 03.09.): an
            earlier pass moved it down beside the strip, but the review put it back — top row,
            right side, beside the shrunk «Gespeichert» check. Only the chip strip and the
            compact «+» actually belong in the bottom rail. */}
        {bellButton}
        {/* in focus mode «+ Trupp» lives in the rail beside the strip — not a second one up here */}
        {canEdit && !focusMode && (
          <button className={s.newBtn} onClick={() => openForm('create')}>
            <Icon id="plus-bold" /><span>{az.newTrupp}</span>
          </button>
        )}
        </div>
      </header>

      <div className={cx(s.body, focusMode && s.bodyFocus)} ref={bodyRef}>
        {trupps.length === 0 ? (
          <div className={s.empty}>
            <Icon id="warn" />
            <p>{az.empty}</p>
            <span>{az.emptyHint}</span>
            {/* «+ Trupp» lives in the bottom rail below (focusMode) whether or not the board is
                empty — the rail renders regardless of `trupps.length`, so there is no second
                door to keep in sync here. */}
          </div>
        ) : focusMode ? (
          /* top-aligned: the card takes only what it needs, never stretched to fill the port
             (`.focusCard`'s own `align-items: flex-start`) — the strip that used to sit above it
             moved to the bottom rail below (mock 03: «status where the eyes land, actions where
             the thumb lives»). */
          <div className={s.focusCard}>{cards(board.filter((t) => t.id === focusId))}</div>
        ) : !sectioned ? (
          <div ref={listRef} className={cx(compact ? s.rowList : s.grid, compact && openRow && s.rowListOpen)}>
            {cards(paBoard)}
          </div>
        ) : (
          <>
            <div className={s.sect}>
              <span className={s.sectTitle}><Icon id="gauge" />{az.sectionAtemschutz}</span>
              <span className={s.sectCount}>{paBoard.length}</span>
            </div>
            {paBoard.length === 0 ? (
              // in-context empty state: the head alone over nothing reads as a bug, and «nobody
              // is under PA right now» is a fact the Überwacher wants stated, not implied
              <p className={s.sectEmpty}>{az.sectionAtemschutzEmpty}</p>
            ) : (
              <div ref={listRef} className={cx(compact ? s.rowList : s.grid, compact && openRow && s.rowListOpen)}>
                {cards(paBoard)}
              </div>
            )}
            <div className={cx(s.sect, s.sectSecond)}>
              <span className={s.sectTitle}><Icon id="people" />{az.sectionPlain}</span>
              <span className={s.sectCount}>{plainBoard.length}</span>
            </div>
            {/* said once, under the rule, rather than on every row: what these Trupps do NOT have
                is the same fact for all of them, and repeating it per row would make the section
                shout louder than the one above it */}
            <p className={s.sectHint}>{az.sectionPlainHint}</p>
            <div className={s.plainList}>
              {plainBoard.map((t) => (
                <PlainTruppRow
                  key={t.id} t={t} live={live.get(t.id)!} color={truppColors[t.id]} canEdit={canEdit}
                  focusNonce={activeFocus?.id === t.id ? activeFocus.nonce : undefined}
                  lite={!!lite}
                  onStatus={(id, st) => { freezeOrder(); setTruppStatus(id, st) }}
                  onEdit={(focus) => openForm('edit', t, focus)} onReenter={() => openForm('redeploy', t)}
                  onDelete={deleteTrupp} onRestore={restoreTrupp}
                  onPlace={handlePlace} onShowPlan={focusTruppOnPlan}
                  onShowLine={showTruppLine} hasLine={truppsWithLine.has(t.id)} drawnLineNo={lineNoOf?.get(t.id)}
                />
              ))}
            </div>
          </>
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
                  className={cx(s.tab, t.id === focusId && s.tabOn, sev === 1 && s.tabWarn, sev >= 2 && s.tabCrit, lv.sinceContactSec == null && s.tabIdle)}
                  onClick={() => setPicked(t.id)}
                >
                  {/* ⚠️ NO Truppfarbe dot here (round 2 review): the lite board drops every
                      colour accent — the Lage/plan identity a colour normally carries means
                      nothing on a screen that never shows the Lage or the plan. The full name
                      is what identifies the Trupp here, so it wraps rather than clips (a name
                      like «Binggeli Michael» was cut mid-word against this chip's width). */}
                  <span className={cx(s.tabName, s.tabNameWrap)}>{t.name}</span>
                  <span className={s.tabClock}>{fmtClock(lv.sinceContactSec)}</span>
                </button>
              )
            })}
          </div>
          {/* «+ Trupp» no longer eats a full chip row (`.tabNew` used to be its own
              `grid-column: 1 / -1`) — it is a compact icon button at the rail's own trailing
              end, so it never competes with the chip grid for width. The bell stays in the
              header (maintainer correction, 03.09.) — this rail carries chips + «+» only. */}
          {canEdit && (
            <div className={s.railActs}>
              <button type="button" className={s.orderBtn} onClick={() => openForm('create')} aria-label={az.newTrupp} title={az.newTrupp}>
                <Icon id="plus-bold" />
              </button>
            </div>
          )}
        </div>
      )}

      {form && (
        <TruppForm
          mode={form.mode} initial={form.trupp} focusSection={form.focus} roster={roster} defaultFunkkanal={defaultFunkkanal}
          personnel={personnel} presentIds={presentIds} stationIds={stationIds} rolesById={rolesById}
          assignedIds={assignedPersonIds(trupps.filter((t) => t.id !== form.trupp?.id))}
          leitungOptions={leitungOptions(form.trupp?.id)}
          lite={!!lite}
          // ⚠️ EVERY phone, not only the handed-over one (03.09.). `compact` is `useIsPhone`, so a
          // tablet — where the whole form stands in one glance — keeps the single screen; the
          // wizard exists for the 375px case, and the app's own phone layout had exactly the fold
          // the link board got the wizard for. Outside the link, step 2 additionally carries
          // Leitung and Farbe (both gated `!lite`), which is why its caption asks what the Trupp
          // is doing rather than naming the Luft. And EVERY Art of Trupp walks those two steps —
          // a Trupp ohne Atemschutz simply gets a shorter step 2 (no Druck) — see TruppForm.
          wizard={compact}
          onAddGuest={onAddGuest}
          onCancel={() => setForm(null)} onSubmit={submitForm}
        />
      )}

      {placePick && (() => {
        // the symbols already standing, minus this Trupp's own (see lib/placedTrupps · markerOptions)
        const markers = markerOptions(placePick)
        return (
        <Overlay open onClose={() => setPlacePick(null)} className={cx(s.modal, s.placeModal)} ariaLabel={az.placeWhere}>
          <div className={s.modalHead}><h3>{az.placeWhere}</h3>
            <button className={s.iconBtn} aria-label={az.cancel} onClick={() => setPlacePick(null)}><Icon id="close" /></button>
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
                      {m.where}{m.takenBy ? ` · ${fillTemplate(az.markerOptTaken, { name: m.takenBy })}` : ''}
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

// A gloved-friendly ±stepper for cylinder pressure (step + ceiling from config; 320 bar allows
// an overfull bottle). Big targets, snaps to the step grid; tap the value to type an exact bar.
function PressureStepper({ value, onChange, compact }: { value: number; onChange: (v: number) => void; compact?: boolean }) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  const dz = atemschutzDoctrine()
  const dec = useHoldRepeat(() => onChange(snapBar(value - dz.pressureStep)))
  const inc = useHoldRepeat(() => onChange(snapBar(value + dz.pressureStep)))
  const edit = useTapToType({ min: 0, max: dz.pressureMax, onCommit: (v) => onChange(snapBar(v)), clamp: snapBar })
  return (
    <div className={cx(s.stepper, compact && s.stepperSmall)}>
      <button type="button" className={s.stepBtn} aria-label={fillTemplate(az.pressureDown, { step: dz.pressureStep })} {...dec}>
        <Icon id="minus" />
      </button>
      {edit.editing ? (
        <div className={s.stepVal}><input className={s.stepInput} {...edit.inputProps} /><span>bar</span></div>
      ) : (
        <button type="button" className={s.stepVal} onClick={() => edit.start(value)} title={appConfig.copy.stepper.typeToEnter}><b>{value}</b><span>bar</span></button>
      )}
      <button type="button" className={s.stepBtn} aria-label={fillTemplate(az.pressureUp, { step: dz.pressureStep })} {...inc}>
        <Icon id="plus" />
      </button>
    </div>
  )
}

// The Funkkanal ±stepper in the create/edit form: hold to repeat, tap the value to type an
// exact channel. Clamped to the configured channel range.
function FunkkanalStepper({ value, onChange, compact }: { value: number; onChange: (v: number) => void; compact?: boolean }) {
  const az = appConfig.copy.atemschutz
  const dz = atemschutzDoctrine()
  const clamp = (v: number) => Math.max(dz.funkkanalMin, Math.min(dz.funkkanalMax, v))
  const dec = useHoldRepeat(() => onChange(clamp(value - 1)))
  const inc = useHoldRepeat(() => onChange(clamp(value + 1)))
  const edit = useTapToType({ min: dz.funkkanalMin, max: dz.funkkanalMax, onCommit: onChange })
  return (
    <div className={cx(s.stepper, compact && s.stepperSmall)}>
      <button type="button" className={s.stepBtn} aria-label={az.funkkanalDown} {...dec}><Icon id="minus" /></button>
      {edit.editing ? (
        <div className={s.stepVal}><input className={s.stepInput} {...edit.inputProps} /><span>{az.funkkanalUnit}</span></div>
      ) : (
        <button type="button" className={s.stepVal} onClick={() => edit.start(value)} title={appConfig.copy.stepper.typeToEnter}><b>{value}</b><span>{az.funkkanalUnit}</span></button>
      )}
      <button type="button" className={s.stepBtn} aria-label={az.funkkanalUp} {...inc}><Icon id="plus" /></button>
    </div>
  )
}

// The inline Druck control on a live card: ± is immediately reachable, but changes remain
// pending until «Bestätigen». This deliberately is not a collapsible card zone — Druckmeldung
// is a critical operation and must never cost an opening tap.
// ⚠️ «Bestätigen» exists only while the value is DIRTY (decided 29.08., reversing Wave 3's
// «Druck unverändert» commit): an unchanged reading is what the big Kontakt button is for.
function PressureInline({ value, onCommit, alarmBar }: {
  value: number
  onCommit: (bar: number) => void
  /** the line THIS Trupp is held to — lower while it is in Rückzug (lib/atemschutz · alarmBarFor) */
  alarmBar?: number
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  // keyed on `value` by the caller, so an external change remounts with a fresh pending value
  const dz = atemschutzDoctrine()
  const [bar, setBar] = useState(value)
  const dirty = bar !== value
  const bump = (d: number) => setBar((b) => snapBar(b + d))
  const dec = useHoldRepeat(() => bump(-dz.pressureStep))
  const inc = useHoldRepeat(() => bump(dz.pressureStep))
  const edit = useTapToType({ min: 0, max: dz.pressureMax, onCommit: (v) => setBar(snapBar(v)), clamp: snapBar })
  // flag the PENDING value too, so the Überwacher sees «that reading is at the Alarmdruck»
  // while dialling it in – before committing, not after
  // ⚠️ the same line the card uses for this Trupp — a crew in Rückzug is held to the lower one
  const low = pressureAlarm(bar, alarmBar ?? dz.alarmBar)
  return (
    <div className={s.pressureBlock}>
      <div className={s.pressureRow}>
        <span className={s.pressureLbl}>{az.currentPressure}</span>
        <div className={s.pressureCtl}>
          <button type="button" className={s.pBtn} aria-label={fillTemplate(az.pressureDown, { step: dz.pressureStep })} {...dec}>
            <Icon id="minus" />
          </button>
          {edit.editing ? (
            <span className={cx(s.pVal, dirty && s.pPending, low && s.metaAlarm)}><input className={s.pInput} {...edit.inputProps} /><span>bar</span></span>
          ) : (
            <button type="button" className={cx(s.pVal, s.pValBtn, dirty && s.pPending, low && s.metaAlarm)} onClick={() => edit.start(bar)} title={appConfig.copy.stepper.typeToEnter}>{bar}<span>bar</span></button>
          )}
          <button type="button" className={s.pBtn} aria-label={fillTemplate(az.pressureUp, { step: dz.pressureStep })} {...inc}>
            <Icon id="plus" />
          </button>
        </div>
      </div>
      {/* Air does not come back — a value above the last one is almost always a typo. Almost:
          it is also how a wrong Eingangsdruck gets corrected, so this says so and gets out of
          the way (see copy · pressureRose). Shown BEFORE the commit, where it can still be
          fixed rather than undone. */}
      {dirty && bar > value && (
        <div className={s.pressureWarn} role="status">
          <Icon id="warn" /><span>{fillTemplate(az.pressureRose, { from: value })}</span>
        </div>
      )}
      {dirty && (
        <div className={s.pressureConfirm}>
          <button type="button" className={s.pConfirm} onClick={() => onCommit(bar)} title={az.pressureConfirmHint}>
            <Icon id="check" /><span>{az.pressureConfirm}</span>
          </button>
          <button type="button" className={s.pCancel} aria-label={az.cancel} title={az.cancel} onClick={() => setBar(value)}>
            <Icon id="close" />
          </button>
        </div>
      )}
    </div>
  )
}

// One big glanceable monitoring card. The dominant element is the contact clock (time since last
// Funkkontakt) with a large Kontakt reset. The always-visible Druck stepper sits below, lifecycle
// actions run along the bottom, and the Verlauf footer (latest event as preview) closes the card.
/** One Trupp as a single comparable line — see `.rowList` in Atemschutz.module.css for why the
 *  board needs this view at all. The whole row is the button that opens the full card; the only
 *  control that survives onto the row is «Kontakt», because it is the one action the comparison
 *  leads to. Everything else (Druck, Rückzug, Raus, Leitung, Bearbeiten, Entfernen) stays in the
 *  card, one tap deeper — including delete, which is a good place for it to be. */
function TruppRow({
  t, live, alarm, now, color, canEdit, onContact, onOpen, focusNonce,
}: {
  t: Trupp; live: TruppLive; now: number; color?: string; canEdit: boolean
  /** the shared tier (lib · truppAlarm) — the SAME number the tone, the chip and the card use */
  alarm: TruppAlarm
  onContact: (id: string) => void
  onOpen: () => void
  focusNonce?: number
}) {
  const az = appConfig.copy.atemschutz
  const status = live.status
  // the same derivations the card makes, so a row and its card never disagree about state
  const inField = t.status === 'aktiv' || t.status === 'rueckzug'
  const sev = alarm.sev
  // The Planungshilfe — «how much air do they have RIGHT NOW», which is the other half of «who is
  // closest to their limit» and the reason the clock alone is not enough. Marked «≈» and tinted
  // when it crosses the Alarmdruck; it is a projection, never a measurement, so it must not look
  // like the logged Druck. Same source and same rule as the card (estimatePressure / pressureAlarm).
  const dz = atemschutzDoctrine()
  const estimate = inField ? estimatePressure(t, now, dz.cylinderLiters, dz.estConsumptionLPerMin) : null
  const estimateLow = pressureAlarm(estimate?.bar ?? null, alarmBarFor(t, dz))
  // ⚠️ «Draussen» and «angemeldet» are NOT one tone. They were both `trowIdle` (blue) while the
  // list still had a «Raus»-Abschnitt to tell them apart — and that section is gone (17.08.), so a
  // spent Trupp now sits between two running ones and has to say so by itself. Grey and dimmed,
  // the same reading the card gives it (.st-raus); blue stays what it means everywhere else on
  // this board: registered, still to come.
  const tone = sev >= 2 ? s.trowCrit : sev === 1 ? s.trowWarn : inField ? '' : status === 'raus' ? s.trowOut : s.trowIdle
  const rowRef = useRef<HTMLButtonElement>(null)
  // A nonce, not a boolean: tapping the same alarm again must replay the pointing gesture.
  useEffect(() => {
    const el = rowRef.current
    if (focusNonce == null || !el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove(s.cardFlash)
    void el.offsetWidth
    el.classList.add(s.cardFlash)
    const timer = window.setTimeout(() => el.classList.remove(s.cardFlash), 1900)
    // ⚠️ the cleanup UNDOES the mark, it does not merely cancel its removal: an interrupted flash
    // (focusNonce changing — or going away — inside the 1.9s window) would otherwise drop the timer
    // and leave the class on. Under prefers-reduced-motion `.cardFlash` is a STATIC ring with no
    // animation to end, so that stuck class is a permanent one.
    return () => { window.clearTimeout(timer); el.classList.remove(s.cardFlash) }
  }, [focusNonce])
  const team = (t.members ?? []).filter(Boolean).join(' · ')
  return (
    <button ref={rowRef} type="button" className={cx(s.trow, tone)} onClick={onOpen}
      aria-label={`${t.name} — ${az.status[status] ?? status}`}>
      <span className={s.trowId}>
        <span className={s.trowName}>
          <span className={s.trowDot} style={color ? { background: color } : undefined} />
          <span className={s.trowNameTxt}>{t.name}</span>
        </span>
        {team && <span className={s.trowTeam}>{team}</span>}
        {/* Phone-only second line: the crew line is hidden there, so this costs no width at all —
            which is what let the name keep its column instead of paying for the extra fact.
            ⚠️ On a PRESSURE alarm it carries the MEASURED bar, not the Schätzung. The `.trowPress`
            column that would otherwise show it is hidden at every width a row is ever rendered at
            (rows are phone-only, ≤600px), so without this the one row whose alarm is about a
            number showed a projection instead of the reading that raised it. */}
        {alarm.reason === 'pressure' ? (
          <span className={cx(s.trowEst, s.trowEstLow)}>{live.currentBar} bar</span>
        ) : estimate && (
          <span className={cx(s.trowEst, estimateLow && s.trowEstLow)}>
            ≈ {estimate.bar} bar
          </span>
        )}
      </span>
      <span className={s.trowState}>{status === 'raus' ? truppStatusLabel(t) : (az.status[status] ?? status)}</span>
      <span className={s.trowClock}>
        <span className={s.trowClockVal}>{fmtClock(live.sinceContactSec)}</span>
        <span className={s.trowSub}>{az.sinceContact}</span>
      </span>
      <span className={s.trowPress}>{live.currentBar}<span className={s.trowPressUnit}> bar</span></span>
      {/* ⚠️ always rendered, even when there is no button in it: these are fixed grid tracks, so a
          missing cell would pull every column after it out of line on that one row */}
      <span className={s.trowAct}>
        {canEdit && inField && (
          // stopPropagation: the row itself opens the card, and the one thing you must be able to
          // do without opening anything is confirm the radio check
          <span role="button" tabIndex={0}
            className={cx(s.kontaktBtn, s.trowKontakt, sev === 1 && s.kontaktWarn, sev >= 2 && s.kontaktCrit)}
            onClick={(e) => { e.stopPropagation(); onContact(t.id) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onContact(t.id) } }}>
            <Icon id="radio" /><span>{az.actContact}</span>
          </span>
        )}
      </span>
      {/* DOWN, not right: this expands the card in place, it does not navigate anywhere. The
          collapse control it turns into points back up, so the pair reads as one toggle. */}
      <span className={s.trowChevron}><Icon id="chevron-down" /></span>
    </button>
  )
}

/**
 * One Trupp WITHOUT Atemschutz, as a single row — the «Weitere Trupps» half of the board
 * (mock «Sektionen», decided 03.09.).
 *
 * Half the height of a card and deliberately quieter: no status band, no clock field, no Druck,
 * no Kontakt. That restraint IS the feature — the section above it is a safety board, and a work
 * squad drawn with the same weight would teach the eye to skim both. What the row carries is
 * everything such a Trupp actually has: who, what, where, and how long it has been at it.
 *
 * ⚠️ Not a collapsed card. There is nothing further to open: every fact about this Trupp is on
 * the row, and the two things a card adds (contact clock, Druckverlauf) do not exist for it. So
 * its controls sit on the row itself rather than one tap deeper — the opposite trade from
 * `TruppRow`, which hides controls precisely because its card has more to show.
 */
function PlainTruppRow({
  t, live, color, canEdit, focusNonce, onStatus, onEdit, onReenter, onDelete, onRestore, onPlace, onShowPlan, onShowLine, hasLine, drawnLineNo, lite = false,
}: {
  t: Trupp
  live: TruppLive
  /** the colour this Trupp wears on the Karte / the Plan — the same dot the cards carry */
  color?: string
  canEdit: boolean
  /** this is the row somebody was just sent to — scroll it under their eyes and mark it */
  focusNonce?: number
  onStatus: (id: string, status: Trupp['status']) => void
  onEdit: (focus?: 'auftrag') => void
  onReenter: () => void
  onDelete: (id: string) => void
  onRestore: (t: Trupp) => void
  onPlace: (id: string) => void
  onShowPlan: (id: string) => void
  onShowLine: (id: string) => void
  hasLine: boolean
  drawnLineNo?: number
  /** the handed-over «Tafel pur» never renders this row at all (AtemschutzView filters it out),
   *  so this only exists to keep ONE rule about surface-pointing controls in the file */
  lite?: boolean
}) {
  const az = appConfig.copy.atemschutz
  const status = live.status
  const inField = t.status === 'aktiv' || t.status === 'rueckzug'
  const auftrag = truppAuftragLabel(t.auftrag)
  const lineTag = drawnLineNo != null ? String(drawnLineNo)
    : t.lineNo != null ? String(t.lineNo) : t.lineNumber?.trim()
  const crew = (t.members ?? []).filter(Boolean).join(' · ')
  // ⚠️ The number is always the Einsatzzeit; the LABEL under it says which state that time is in.
  // A row whose clock is frozen («Draussen») must not read like one that is still counting.
  const stateLabel = status === 'raus' ? truppStatusLabel(t) : (az.status[status] ?? status)
  const rowRef = useRef<HTMLDivElement>(null)
  // the same pointing gesture the cards answer — a nonce, so a repeat tap replays it
  useEffect(() => {
    const el = rowRef.current
    if (focusNonce == null || !el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove(s.cardFlash)
    void el.offsetWidth
    el.classList.add(s.cardFlash)
    const timer = window.setTimeout(() => el.classList.remove(s.cardFlash), 1900)
    // cleanup UNDOES the mark — see TruppRow for why clearing the timer alone is not enough
    return () => { window.clearTimeout(timer); el.classList.remove(s.cardFlash) }
  }, [focusNonce])

  // delete-now + Rückgängig toast — the same contract the card gives (house rule)
  const doDelete = () => {
    const snapshot = t
    onDelete(t.id)
    toast(fillTemplate(az.removedToast, { name: t.name }), {
      icon: 'trash',
      action: { label: appConfig.copy.undo, onClick: () => onRestore(snapshot) },
    })
  }

  return (
    <div ref={rowRef} className={cx(s.prow, status === 'angemeldet' && s.prowIdle, status === 'raus' && s.prowOut)}>
      <div className={s.prowId}>
        <div className={s.prowName}>
          <span className={s.prowDot} style={color ? { background: color } : undefined} aria-hidden />
          <span className={s.prowNameTxt}>{t.name}</span>
        </div>
        {crew && <div className={s.prowCrew}>{crew}</div>}
      </div>
      <div className={s.prowTask}>
        {/* same rule as the card, canEdit included: a Trupp with no job is a question that has to
            be VISIBLE — hiding the gap from a viewer would hide the thing worth asking about */}
        {auftrag
          ? <span className={cx(s.tag, s.tagAuftrag)}>{auftrag}</span>
          : <button type="button" className={cx(s.tag, s.tagAuftragOpen)} onClick={() => onEdit('auftrag')}>{az.auftragOpen}</button>}
        {t.ziel && <span className={s.tagZiel}>{t.ziel}</span>}
        {lineTag && (hasLine && !lite ? (
          <button type="button" className={cx(s.tag, s.tagGo)} title={az.lineShow} onClick={() => onShowLine(t.id)}>
            {az.lineField} {lineTag}<Icon id="chevron" />
          </button>
        ) : (
          <span className={s.tag}>{az.lineField} {lineTag}</span>
        ))}
        {t.funkkanal != null && <span className={s.tag}>Kanal {t.funkkanal}</span>}
      </div>
      <div className={s.prowSince}>
        <b>{fmtClock(t.entryTime ? live.elapsedSec : null)}</b>
        <small>{inField ? az.elapsed : stateLabel}</small>
      </div>
      <div className={s.prowActs}>
        {/* ONE lifecycle button, whichever the state actually offers — the card's two-button bar
            has no room here and no second choice worth the width: «Nicht eingesetzt» is a
            Sicherungstrupp's exit, and a Sicherungstrupp is by definition under PA. */}
        {canEdit && status === 'angemeldet' && (
          <button type="button" className={cx(s.prowAct, s.prowActGo)} onClick={() => onStatus(t.id, 'aktiv')}>
            <Icon id="flag" /><span>{az.actEnter}</span>
          </button>
        )}
        {canEdit && inField && (
          <button type="button" className={s.prowAct} onClick={() => onStatus(t.id, 'raus')}>
            <Icon id="logout" /><span>{az.actExit}</span>
          </button>
        )}
        {canEdit && status === 'raus' && (
          <button type="button" className={cx(s.prowAct, s.prowActGo)} onClick={onReenter}>
            <Icon id="flag" /><span>{az.actReenter}</span>
          </button>
        )}
        {canEdit && status !== 'raus' && (
          <button className={s.iconBtn} aria-label={az.edit} title={az.edit} onClick={() => onEdit()}>
            <Icon id="pen" />
          </button>
        )}
        {/* the placement pair, exactly as on a card: placed ⇒ GO there, not placed ⇒ put it down */}
        {lite ? null : (t.annoId || t.entityId) ? (
          <button className={s.iconBtn} aria-label={t.entityId ? az.showOnMap : az.showOnPlan} title={t.entityId ? az.showOnMap : az.showOnPlan} onClick={() => onShowPlan(t.id)}>
            <Icon id={t.entityId ? 'map' : 'doc'} />
          </button>
        ) : canEdit && status !== 'raus' && (
          <button className={s.iconBtn} aria-label={az.place} title={az.place} onClick={() => onPlace(t.id)}>
            <Icon id="footprint" />
          </button>
        )}
        {canEdit && (
          <button className={`${s.iconBtn} ${s.danger}`} aria-label={az.remove} title={az.remove} onClick={doDelete}>
            <Icon id="trash" />
          </button>
        )}
      </div>
    </div>
  )
}

function TruppCard({
  t, live, alarm, now, color, canEdit, intervalMin, focusNonce, onContact, onPressure, onStatus, onEdit, onReenter, onDelete, onRestore, onPlace, onShowPlan, onMove, onPickLine, onShowLine, hasLine, drawnLineNo, onCollapse, lite = false, big = false,
}: {
  t: Trupp; live: TruppLive; now: number; canEdit: boolean
  /** the shared tier (lib · truppAlarm) — the SAME number the tone, the chip and the row use */
  alarm: TruppAlarm
  /** the Funkkontakt-Intervall (min) — the Kontakt zone's folded times name the next due time */
  intervalMin: number
  /** the colour this Trupp wears on the Lage / plan (useTruppActions · truppColors) — set for
   *  every Trupp, automatic ones included */
  color?: string
  onContact: (id: string) => void
  onPressure: (id: string, bar: number) => void
  onStatus: (id: string, status: Trupp['status']) => void
  /** this is the card somebody was just sent to — scroll it under their eyes and mark it */
  focusNonce?: number
  onEdit: (focus?: 'auftrag') => void
  onReenter: () => void
  onDelete: (id: string) => void
  /** present only while the hand-set order is the one on screen (see AtemschutzView) */
  onMove?: (id: string, dir: -1 | 1) => void
  onRestore: (t: Trupp) => void
  onPlace: (id: string) => void
  onShowPlan: (id: string) => void
  /** start «Leitung wählen» — the next tap on a hose (Lage or Plan) links it to this Trupp */
  onPickLine: (id: string) => void
  /** jump to the drawn Leitung (Lage or Plan) — the counterpart of «auf Plan zeigen» */
  onShowLine: (id: string) => void
  /** is there actually a hose drawn for this Trupp? Decides whether the chip is a jump or plain
   *  text — a button that goes nowhere is worse than no button. */
  hasLine: boolean
  /** the number the Trupp's drawn hose carries right now — wins over the stored copy */
  drawnLineNo?: number
  /** set only in compact mode, where this card was opened from a row — collapses back to it */
  onCollapse?: () => void
  /** the handed-over «Tafel pur» (see AtemschutzView · lite): drop every control that points at
   *  a surface this session cannot reach — Platzieren, auf Plan zeigen, Leitung wählen/zeigen,
   *  and the board-order arrows. Kontakt, Druck, Rückzug, Draussen, Bearbeiten and Entfernen
   *  all stay: they are what the board was handed over FOR. */
  lite?: boolean
  /** the ONE card filling a phone screen (AtemschutzView · focusMode): giant clock, thumb-sized
   *  Kontakt, and the Planungshilfe rows folded away — the Druck stays */
  big?: boolean
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  const status = live.status
  // «Draussen» on a Trupp that never went under PA claims it came out of something. Only that
  // one word differs — the state, the section and the actions are the same (truppNeverDeployed).
  const statusLabel = status === 'raus' ? truppStatusLabel(t) : (az.status[status] ?? status)
  const [logOpen, setLogOpen] = useState(false)
  /* The Kontakt zone's fold (29.08. Tapzonen): the rarely-needed timing rows (letzter Kontakt,
   * nächster fällig, Intervall) sit behind a tap on the clock itself, collapsed by default —
   * the countdown always stays visible. Like every zone on this card it only shows/hides;
   * commits stay on the explicit buttons. */
  const [timesOpen, setTimesOpen] = useState(false)
  // ⚠️ The jump has to LAND. Switching to the Überwachung and leaving a wall of cards was the
  // complaint: on a long list the Trupp somebody was sent to was off-screen, so the answer to
  // «why can I not tick this person» was still a search. The nonce replays both scroll and ring
  // when the same notification is tapped again while this card remains mounted.
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = cardRef.current
    if (focusNonce == null || !el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove(s.cardFlash)
    void el.offsetWidth
    el.classList.add(s.cardFlash)
    const timer = window.setTimeout(() => el.classList.remove(s.cardFlash), 1900)
    // ⚠️ same as TruppRow: the cleanup must REMOVE the class, not just clear the timer. A flash cut
    // short (focusNonce changing or clearing inside the 1.9s window) otherwise leaves the mark on
    // the card for good — visibly so under prefers-reduced-motion, where `.cardFlash` is a static
    // ring rather than an animation that ends by itself.
    return () => { window.clearTimeout(timer); el.classList.remove(s.cardFlash) }
  }, [focusNonce])
  const inField = t.status === 'aktiv' || t.status === 'rueckzug'
  const auftrag = truppAuftragLabel(t.auftrag)
  const sev = alarm.sev
  const dz = atemschutzDoctrine()
  // Planungshilfe: measured consumption history wins; the configured assumption is used only
  // until enough confirmed Druck values exist. It never replaces a reading or drives an alarm.
  const estimate = inField ? estimatePressure(t, now, dz.cylinderLiters, dz.estConsumptionLPerMin) : null
  const readings = t.readings ?? []
  // Alarmdruck – EITHER the logged Druck or the expected-pressure Schätzung is enough. Air burns
  // down between radio checks, so a reading that still looked fine at the last Kontakt is exactly
  // how a Trupp slips past its turn-back pressure unnoticed. Visual only: the contact clock stays
  // the single audible alarm (see lib/atemschutz).
  // …against THIS Trupp's line: in Rückzug it is the lower one (lib/atemschutz · alarmBarFor)
  const line = alarmBarFor(t, dz)
  const pressureLow = pressureAlarm(live.currentBar, line)
  const estimateLow = pressureAlarm(estimate?.bar ?? null, line)
  /* The MEASURED crossing is the alarm and it lives in the clock block below (`alarm.reason`),
   * where the card's loudest element is. This strip is what is left: the case where only the
   * PROJECTION has crossed — a Planungshilfe, which must never look like a logged reading and
   * must never raise the tier (lib/atemschutz · truppAlarm). */
  const airNote = inField && estimateLow && !pressureLow
    ? fillTemplate(az.alarmNoteEst, { bar: line })
    : null

  /* The clock block is the ALARM block: same three lines, same height, same typography — the
   * word and the number swap for a pressure alarm, because a radio check does not fix that one
   * and the word must never say «überfällig» for it (the Verlauf records two different events).
   * The state word carries the tier as TEXT, so it survives colourblindness and a muted alarm. */
  const pressureCrit = alarm.reason === 'pressure'
  const clockState = pressureCrit ? az.clockAlarmPressure
    : sev >= 2 ? az.clockOverdue : sev === 1 ? az.clockWarn : az.clockOk
  const clockValue = pressureCrit ? `${live.currentBar} bar` : fmtClock(live.sinceContactSec)
  const clockLabel = pressureCrit ? fillTemplate(az.clockAlarmLimit, { bar: line }) : az.sinceContact

  // The Leitung chip: the numeric field, else the free text an older record still carries. Shown
  // as typed either way — an incident is a legal record, so nothing rewrites what was entered.
  // ⚠️ The DRAWN hose's number wins over the Trupp's stored copy: renumbering the Leitung in the
  // picture used to leave this chip saying «Ltg 1» beside a hose tagged «Ltg 3» (19.08.). The
  // copy stays the fallback — a Trupp whose hose was deleted keeps the number it worked on —
  // and an older record's free-text designation is still never rewritten.
  const lineTag = drawnLineNo != null ? String(drawnLineNo)
    : t.lineNo != null ? String(t.lineNo) : t.lineNumber?.trim()

  // «Raus» happens immediately with a Rückgängig toast (house rule: confirm-with-undo, no
  // blocking dialog). The undo lives in the action (setTruppStatus) so it restores the full
  // pre-raus Trupp — status + clocks — not just re-open a dead-ended card.
  const askExit = () => onStatus(t.id, 'raus')
  // delete-now + Rückgängig toast (house rule: confirm-with-undo, no blocking dialog).
  // The captured Trupp restores with its full record; only the plan/map placement is gone.
  const doDelete = () => {
    const snapshot = t
    onDelete(t.id)
    toast(fillTemplate(az.removedToast, { name: t.name }), {
      icon: 'trash',
      action: { label: appConfig.copy.undo, onClick: () => onRestore(snapshot) },
    })
  }

  /* ── the pieces BOTH shells render, built once ──────────────────────────────────────────────
   * The card has two shells: the tablet's banner + name block, and the phone focus card's
   * condensed toprow + metaline (`big`, density redesign mock 02). Only the WRAPPERS may fork –
   * the action group, the crew names and the Auftrag/Ziel/Leitung/Kanal chips are built here, so
   * a new chip or a copy change can never land in one shell and be missed in the other.
   *
   * `big` is only ever set together with `lite`, and focus mode passes neither `onMove` nor
   * `onCollapse` (AtemschutzView · focusMode). So on the phone card the group below collapses to
   * exactly Bearbeiten + Entfernen – every control that points at a Karte/Plan this session
   * cannot reach is already withheld by `lite` itself, which is the right place for that rule.
   */
  const actions = (
    /* The actions ride in their own group so they wrap as a block if a card ever gets narrow
       enough — the status word must never be the thing that gets abbreviated. */
    <div className={s.cardActs}>
      {/* Only while the hand-set order is the one on screen: moving a card under any other
          sort would rearrange something the sort is about to rearrange back. */}
      {onMove && canEdit && !lite && (
        <>
          <button className={s.iconBtn} aria-label={az.moveBack} title={az.moveBack} onClick={() => onMove(t.id, -1)}>
            <Icon id="chevron-left" />
          </button>
          <button className={s.iconBtn} aria-label={az.moveForward} title={az.moveForward} onClick={() => onMove(t.id, 1)}>
            <Icon id="chevron" />
          </button>
        </>
      )}
      {canEdit && status !== 'raus' && (
        <button className={s.iconBtn} aria-label={az.edit} title={az.edit} onClick={() => onEdit()}>
          <Icon id="pen" />
        </button>
      )}
      {lite ? null : (t.annoId || t.entityId) ? (
        <button className={s.iconBtn} aria-label={t.entityId ? az.showOnMap : az.showOnPlan} title={t.entityId ? az.showOnMap : az.showOnPlan} onClick={() => onShowPlan(t.id)}>
          <Icon id={t.entityId ? 'map' : 'doc'} />
        </button>
      ) : canEdit && status !== 'raus' && (
        <button className={s.iconBtn} aria-label={az.place} title={az.place} onClick={() => onPlace(t.id)}>
          <Icon id="footprint" />
        </button>
      )}
      {/* The Leitung this Trupp works on — the same shape as the placement button above it:
          nothing drawn yet ⇒ pick one, drawn ⇒ GO there. Letting go of a Leitung is not an
          icon: it is clearing the number in the form (or «Kein Trupp» on the line itself),
          which is where the operator already is when they change their mind. */}
      {lite ? null : hasLine ? (
        <button className={s.iconBtn} aria-label={az.lineShow} title={az.lineShow} onClick={() => onShowLine(t.id)}>
          <Icon id="drop" />
        </button>
      ) : canEdit && status !== 'raus' && (
        <button className={s.iconBtn} aria-label={az.linePick} title={az.linePick} onClick={() => onPickLine(t.id)}>
          <Icon id="drop" />
        </button>
      )}
      {canEdit && (
        <button className={`${s.iconBtn} ${s.danger}`} aria-label={az.remove} title={az.remove} onClick={doDelete}>
          <Icon id="trash" />
        </button>
      )}
      {/* Back to the row. Present only while the board is in compact mode, where this card was
          opened FROM a row — otherwise there is nothing to collapse to.
          ⚠️ LAST, i.e. the rightmost control — deliberately the pixel the row's own «›» sat on.
          With the collapse first, that pixel belonged to «Entfernen»: tap a row to open it, tap
          the same spot again, and you deleted the Trupp. Now the same place toggles the card
          open and shut, and it shields the destructive button behind it. */}
      {onCollapse && (
        <button className={`${s.iconBtn} ${s.collapseBtn}`} aria-label={az.collapse} title={az.collapse} onClick={onCollapse}>
          <Icon id="chevron-up" />
        </button>
      )}
    </div>
  )

  // The crew as one string; each shell decides only where it sits (its own line on the tablet,
  // inline before the chips on the phone card).
  const crewNames = t.members?.filter(Boolean) ?? []
  const crew = crewNames.join(' · ')

  const tags = (
    <div className={s.tags}>
      {/* ⚠️ The Auftrag is optional in the form (it must never hold a Trupp at the door),
          so its ABSENCE has to be visible — a Trupp with no job on the card is a question
          the Überwacher has to be able to see, not one nobody thinks to ask. */}
      {auftrag
        ? <span className={cx(s.tag, s.tagAuftrag)}>{auftrag}</span>
        : <button type="button" className={cx(s.tag, s.tagAuftragOpen)} onClick={() => onEdit('auftrag')}>{az.auftragOpen}</button>}
      {t.ziel && <span className={s.tagZiel}>{t.ziel}</span>}
      {/* the numeric Leitung, else the free text an older record still carries verbatim */}
      {/* ⚠️ On the lite board the number still SHOWS (a Trupp's Leitung is a fact the
          Überwacher needs) but stops being a jump: there is no Karte to land on – which is
          also why the phone focus card, always `lite`, never grows the button. */}
      {lineTag && (hasLine && !lite ? (
        <button type="button" className={cx(s.tag, s.tagGo)} title={az.lineShow} onClick={() => onShowLine(t.id)}>
          {az.lineField} {lineTag}<Icon id="chevron" />
        </button>
      ) : (
        <span className={s.tag}>{az.lineField} {lineTag}</span>
      ))}
      {t.funkkanal != null && <span className={s.tag}>Kanal {t.funkkanal}</span>}
    </div>
  )

  return (
    /* ⚠️ The border/banner colour follows the TIER, not the lifecycle status: a Trupp at its
       Alarmdruck is red even while it is «Im Einsatz». The WORD stays the lifecycle state —
       what kind of alarm it is belongs to the clock block, which says so in full. */
    <div ref={cardRef} data-az-open={onCollapse ? "" : undefined}
      className={cx(s.card, big && s.cardBig, s[`st-${sev >= 2 ? 'ueberfaellig' : status}`])}>
      {big ? (
        /* ── condensed identity: the lite/phone focus card (density redesign, mock 02) ──
           Name, its status pill and the actions share ONE row; crew and the chips share the
           next. Purely a different arrangement of the SAME pieces built above – nothing here
           may grow content of its own. */
        <>
          <div className={s.toprow}>
            <span className={s.toprowName}>{t.name}</span>
            <span className={s.toprowPill}>{statusLabel}</span>
            {actions}
          </div>
          <div className={s.metaline}>
            {!!crewNames.length && (
              <>
                <span className={s.metalineCrew}>{crew}</span>
                <span className={s.metalineSep}>·</span>
              </>
            )}
            {tags}
          </div>
        </>
      ) : (
        <>
          <div className={s.cardBanner}>
            {/* ⚠️ NO dot in front of the status. A card already carries one coloured disc — the
                Truppfarbe beside the name, which is the Trupp's identity on the Lage and the plan.
                A second disc at the top of the same card, in a status colour, was read as that
                identity: «warum ist Trupp 2 plötzlich grün». The word is the state, the top border
                and the banner tint already carry its colour, and the one dot on the card means the
                one thing. */}
            <span className={s.statusLabel}>{statusLabel}</span>
            {actions}
          </div>

          <div className={s.cardName}>
            {/* the colour this Trupp wears on the Lage / plan, so the card and the symbol out there
                read as the same Trupp. EVERY Trupp has one, the automatically-coloured ones included
                (useTruppActions · truppColors) — a hole in this column read as «no colour» on a board
                where colour is identity.
                ⚠️ NOT on the lite board (round 2 review): a link session never sees the Lage or the
                plan, so the colour carries no identity there — it read as an arbitrary dot on
                somebody's phone. The normal app keeps it exactly as above. */}
            <div className={s.nameRow}>
              {color && !lite && <span className={s.nameDot} style={{ background: color }} aria-hidden />}
              <span className={s.nameStatic}>{t.name}</span>
            </div>
            {!!crewNames.length && (
              <div className={s.members}>{crew}</div>
            )}
            {tags}
          </div>
        </>
      )}

      {t.status === 'angemeldet' ? (
        <div className={s.preEntry}>{az.preEntryHint}</div>
      ) : (
        <div className={s.contactWrap}>
          {/* KONTAKT zone (29.08. Tapzonen): while a contact clock is running, the clock block is
              also the tap target that folds the timing details in and out. It is an OPEN-ONLY
              affordance beside the explicit buttons — it never logs a Kontakt (that stays on the
              big button below). A Trupp with no running clock (raus, –:––) keeps the plain block. */}
          {live.sinceContactSec != null ? (
            <button
              type="button"
              className={cx(s.contactClock, s.zoneClock, big && s.clockBand, sev === 1 && s.contactWarn, sev >= 2 && s.contactCrit)}
              aria-expanded={timesOpen} title={az.zoneTimes}
              onClick={() => setTimesOpen((o) => !o)}
            >
              <div
                className={big ? s.clockBandInner : undefined}
                role="status" aria-live={sev >= 2 ? 'assertive' : 'polite'}
                aria-label={`${clockState} — ${clockValue} ${clockLabel}`}
              >
                <div className={s.contactState}>{clockState}</div>
                <div className={s.contactVal}>{clockValue}</div>
                <div className={s.contactLbl}>{clockLabel}</div>
              </div>
              <span className={s.zoneCue}>{az.zoneTimes}</span>
            </button>
          ) : (
            <div
              className={cx(s.contactClock, big && s.clockBand, sev === 1 && s.contactWarn, sev >= 2 && s.contactCrit)}
              role="status" aria-live={sev >= 2 ? 'assertive' : 'polite'}
              aria-label={`${clockState} — ${clockValue} ${clockLabel}`}
            >
              <div className={big ? s.clockBandInner : undefined}>
                <div className={s.contactState}>{clockState}</div>
                <div className={s.contactVal}>{clockValue}</div>
                <div className={s.contactLbl}>{clockLabel}</div>
              </div>
            </div>
          )}
          {timesOpen && live.sinceContactSec != null && (() => {
            const lastContactAt = now - live.sinceContactSec * 1000
            const hm = (t: number) => fmtTime(new Date(t).toISOString())
            return (
              <div className={s.zonePanel}>
                <div className={s.zonePanelRow}><span>{az.lastContactAt}</span><b>{hm(lastContactAt)}</b></div>
                <div className={s.zonePanelRow}><span>{az.nextContactDue}</span><b>{hm(lastContactAt + intervalMin * 60_000)}</b></div>
                <div className={s.zonePanelRow}><span>{az.contactIntervalLabel}</span><b>{fillTemplate(az.contactIntervalValue, { min: intervalMin })}</b></div>
              </div>
            )
          })()}
          {canEdit && inField && (
            <button className={cx(s.kontaktBtn, sev === 1 && s.kontaktWarn, sev >= 2 && s.kontaktCrit)} onClick={() => onContact(t.id)}>
              <Icon id="radio" /><span>{az.actContact}</span>
            </button>
          )}
        </div>
      )}

      {airNote && (
        <div className={s.airNote} role="status" aria-live="polite">
          <Icon id="warn" /><span>{airNote}</span>
        </div>
      )}

      <div className={s.meta}>
        {t.entryTime && (
          <div className={s.metaRow}>
            <span>{az.elapsed}</span>
            <b>{fmtClock(live.elapsedSec)}</b>
          </div>
        )}
        {/* The break clock. Once a Trupp is out its Einsatzzeit is finished and stands still —
            what the Überwacher needs from then on is how long the crew has been resting before
            it can be sent in again, so that is the number that keeps running. */}
        {live.outSec != null && (
          <div className={s.metaRow}>
            <span>{az.outFor}</span>
            <b>{fmtClock(live.outSec)}</b>
          </div>
        )}
        {estimate && (
          <div className={cx(s.metaRow, s.metaEstimate)} title={estimate.source === 'history'
            ? az.estimatedHintHistory
            : fillTemplate(az.estimatedHint, { liters: dz.cylinderLiters, rate: dz.estConsumptionLPerMin })}>
            <span className={s.metaEstLabel}>{az.estimated}</span>
            <b className={cx(s.metaEst, estimateLow && s.metaAlarm)}>≈ {estimate.bar} bar</b>
            <small className={s.metaEstSource}>{estimate.source === 'history'
              ? fillTemplate(az.estimatedSourceHistory, { count: estimate.sampleCount, time: fmtTime(estimate.basedAt) })
              : fillTemplate(az.estimatedSourceFallback, { rate: dz.estConsumptionLPerMin, time: fmtTime(estimate.basedAt) })}</small>
          </div>
        )}
        {canEdit && inField ? (
          <PressureInline key={snapBar(live.currentBar)} value={snapBar(live.currentBar)} alarmBar={line} onCommit={(bar) => onPressure(t.id, bar)} />
        ) : (
          <div className={s.metaRow}>
            <span>{az.currentPressure}</span>
            <b className={cx(pressureLow && s.metaAlarm)}>{live.currentBar} bar</b>
          </div>
        )}
        {live.lowestBar < live.currentBar && (
          <div className={s.metaRow}>
            <span>{az.lowestPressure}</span>
            <b>{live.lowestBar} bar</b>
          </div>
        )}
      </div>

      {/* The lifecycle bar stays explicit: only these buttons commit status changes. */}
      {canEdit && t.status === 'angemeldet' && (
        <div className={s.actions}>
          {/* The Sicherungstrupp that was never needed. Until 08.08. the only way to close one
              was the bin — which throws away the one record that says a crew stood ready, on a
              document that is the legal account of the Einsatz. This closes it like any other
              Trupp: under «Draussen», break clock running, «Wieder einrücken» right there.
              ⚠️ LEFT of «Eingerückt», which is the shape every other pair on this card has:
              the quiet way out on the left, the action the card exists for on the right, under
              the thumb. It read the other way round for one afternoon (09.08.). */}
          <button className={cx(s.actBtn, s.actStandDown)} title={az.actNotDeployedHint}
            onClick={() => onStatus(t.id, 'raus')}>
            <Icon id="logout" /><span>{az.actNotDeployed}</span>
          </button>
          <button className={cx(s.actBtn, s.actEnter)} onClick={() => onStatus(t.id, 'aktiv')}>
            <Icon id="flag" /><span>{az.actEnter}</span>
          </button>
        </div>
      )}
      {canEdit && inField && (
        <div className={s.actions}>
          {t.status === 'aktiv' ? (
            <button className={cx(s.actBtn, s.actRueckzug)} onClick={() => onStatus(t.id, 'rueckzug')}>
              <Icon id="undo" /><span>{az.actRueckzug}</span>
            </button>
          ) : (
            <button className={cx(s.actBtn, s.actContinue)} onClick={() => onStatus(t.id, 'aktiv')}>
              <Icon id="redo" /><span>{az.actContinue}</span>
            </button>
          )}
          <button className={cx(s.actBtn, s.actExit)} onClick={askExit}>
            <Icon id="logout" /><span>{az.actExit}</span>
          </button>
        </div>
      )}
      {/* No exit timestamp line here: the exit event is in the per-Trupp Verlauf and on the
          Rapport, and what the Überwacher needs NOW is the running break clock above (outFor). */}
      {status === 'raus' && canEdit && (
        <div className={s.actions}>
          <button className={cx(s.actBtn, s.actReenter)} onClick={onReenter}>
            <Icon id="flag" /><span>{az.actReenter}</span>
          </button>
        </div>
      )}
      {/* The preview always carries the latest event (Kontakt, Druck, Ausgerückt, …), not just
          the one special case after coming out. Expanding it only shows the per-Trupp log. */}
      {readings.length > 0 && (() => {
        const last = readings[readings.length - 1]
        const lastWhat = (az.readingKind[last.kind] ?? last.kind)
          + (readingBarIsMeasured(last.kind) ? ` ${last.bar} bar` : '')
        return (
          <div className={s.vfoot}>
            <button type="button" className={s.vrow} aria-expanded={logOpen} onClick={() => setLogOpen((o) => !o)}>
              <Icon id="history" /><span className={s.vrowLbl}>{az.verlauf}</span>
              <span className={s.vrowLast}>
                {fillTemplate(az.verlaufLatest, { time: fmtTime(last.t), what: lastWhat })}
              </span>
              <Icon id={logOpen ? 'chevron-up' : 'chevron-down'} className={s.logChev} />
            </button>
            {logOpen && (() => {
              // ⚠️ The log spans EVERY deployment since 18.08. («Wieder einrücken» appends rather
              // than starting a new one, so the first bottle still prints on the Rapport). The card
              // header, though, is about the crew that is inside NOW — Eingangsdruck, tiefster
              // Druck. Without a boundary the two contradict each other: «tiefster Druck 300» over
              // a row saying 120. Everything before the current run is dimmed and gets a line.
              const from = currentRunStart(readings)
              return (
                <ul className={s.logList}>
                  {[...readings].reverse().map((r, i) => {
                    const idx = readings.length - 1 - i
                    return (
                      <li key={idx} className={cx(s.logRow, idx < from && s.logRowPast, idx === from && from > 0 && s.logRowRunStart)}>
                        <span className={s.logTime}>{fmtTime(r.t)}</span>
                        {/* …and the same on the board: a Kontakt shows no bar, because the one it
                            carries is the last reported value, not a fresh reading */}
                        <span className={s.logBar}>{readingBarIsMeasured(r.kind) ? `${r.bar} bar` : ''}</span>
                        <span className={s.logKind}>{az.readingKind[r.kind] ?? r.kind}</span>
                      </li>
                    )
                  })}
                </ul>
              )
            })()}
          </div>
        )
      })()}
    </div>
  )
}

/**
 * ONE shared form for create / edit / re-deploy, in one of two shapes.
 *
 * ⚠️ The rule used to be «single screen, never a wizard» (3am tenet) and it is now narrower than
 * that, because the screen it was written for is not the only one any more:
 *   · On anything with room — tablet, desktop — it is ONE screen. Nothing is behind a step,
 *     nothing has to be walked to, and the whole Trupp is visible while it is being formed.
 *   · On a PHONE it is two steps (`wizard`): «Wer bildet den Trupp?» with the entire screen for
 *     the roster, then «Was machen sie?». Handed over by QR since 02.09., the main board's phone
 *     layout since 03.09. — the same form, so nobody learns two. The reason is the same one that
 *     turned the phone board into rows: at 375px the single screen put Druck, Kanal and Auftrag
 *     below a fold nobody knew was there, and the fields that start the safety clock were the
 *     ones that fell off. Steps can be walked freely in both directions, editing starts on
 *     step 2, and only the final submit gates on a valid Trupp — a wizard that can trap you at
 *     3am would be worse than the fold.
 *   · ⚠️ EVERY kind of Trupp gets those two steps (03.09.). Until then the wizard was PA-only, so
 *     tapping «Ohne Atemschutz» — on step 1, under your thumb — collapsed the form to one screen
 *     and re-flowed everything below it. THAT was the jarring part, not the length of step 2: a
 *     form must not restructure itself because the Art toggle moved. A plain Trupp's step 2 is
 *     simply shorter (Kanal · Auftrag · Ziel, and no Druck — `showPressure` already gates it).
 *
 * Leads with the AUFTRAG (what the Trupp is sent to do — the order you check them against on every
 * Kontakt), then the Trupp; the Druck section belongs to Atemschutz alone, and «Art des Trupps»
 * is asked once, at creation, because it cannot be changed afterwards (types · Trupp.kind).
 */
function TruppForm({
  mode, initial, focusSection, roster, defaultFunkkanal, personnel, presentIds, stationIds, assignedIds, rolesById, leitungOptions, lite = false, wizard = false, onAddGuest, onCancel, onSubmit,
}: {
  mode: FormMode
  initial?: Trupp
  /** A card gap opened this form — point directly at the field that resolves it. */
  focusSection?: 'auftrag'
  roster: string[]
  defaultFunkkanal: number
  personnel: Person[]
  presentIds: Set<string>
  stationIds: Set<string>
  assignedIds: Set<string>
  /** who already holds a job on this Einsatz (Anwesenheits-Bemerkung), so the picker can say
   *  «schon: Einsatzleiter» beside a name — a hint, never a block */
  rolesById: Map<string, string>
  onCancel: () => void
  /** the Leitungen drawn on either surface (lib/truppLines · leitungOptions) — offered as
   *  quick-picks so the number is chosen from what exists, not typed blind */
  leitungOptions: LeitungOption[]
  /** the handed-over «Tafel pur» (see AtemschutzView · lite): drops the Farbe picker (a
   *  Lage/Plan matter this session cannot see) and the ENTIRE Ltg-Nr. row (reverted, round 2
   *  review — briefly shown 02.09.). A link holder has no picture to read a hose number off and
   *  no surface to draw one on, so the field could only ever be a number typed blind — and one
   *  Leitung, one Trupp is enforced against what is actually drawn regardless (see submitForm's
   *  takeover confirm). The FU sets it on the KP tablet. */
  lite?: boolean
  /** two steps instead of one scroll — set for ANY phone since 03.09. (it was the handed-over
   *  board's own layout from 02.09.), and for any Art of Trupp. See the two-shapes note above the
   *  component: nothing about the Art may change the SHAPE of the form, only its step 2. */
  wizard?: boolean
  /** record a hand-typed Gast on the Anwesenheit as well — being put in a Trupp IS being here */
  onAddGuest?: (name: string) => string | undefined
  /** `standby` (re-deploy only) parks the Trupp as Reserve instead of sending it straight in */
  onSubmit: (f: TruppFields, standby?: boolean) => void
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  // ⚠️ The typed Trupp survives a mis-tap. Only «Abbrechen» throws it away — an ✕ or a tap on
  // the backdrop is «not now», and losing three names and a Ziel to a fat finger at 3am is the
  // expensive half of that pair (see lib/draftKeep, the same rule the Gast name follows).
  const draftKey = `atemschutz:trupp:${mode}:${initial?.id ?? 'new'}`
  // The two roster indexes the slot resolution needs: name → id, and id → Person (to check that
  // a stored positional id really belongs to the name beside it — see lib/personnel · truppSlots).
  const rosterByName = useMemo(() => rosterIdByName(personnel), [personnel])
  const rosterById = useMemo(() => rosterFromList(personnel), [personnel])

  const [auftrag, setAuftrag, clearAuftrag] = useKeptState<Trupp['auftrag'] | null>(`${draftKey}:auftrag`, initial?.auftrag ?? null)
  const [ziel, setZiel, clearZiel] = useKeptState(`${draftKey}:ziel`, initial?.ziel ?? '')
  // Leitung: numeric since 2026-08-05. A Trupp carrying only the old free text starts empty and
  // keeps that text visible underneath — the record stays as its Überwacher typed it, and a
  // legacy «1» still auto-matches the drawn Leitung 1 (lib/truppLines · truppLineNo).
  const [lineNo, setLineNo] = useState<number | null>(initial?.lineNo ?? null)
  const legacyLine = initial?.lineNo == null ? initial?.lineNumber?.trim() : undefined
  const [funkkanal, setFunkkanal] = useState<number>(initial?.funkkanal ?? defaultFunkkanal)
  // null = automatic (the station colour for this Auftrag, else the next free palette colour).
  // A picked colour is used as picked, duplicates included — see Trupp.color.
  const [color, setColor] = useState<string | null>(initial?.color ?? null)
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
  /* «Art des Trupps» — asked once, on creation, and read-only ever after (types · Trupp.kind).
   * An existing Trupp answers from its own record, so re-deploying or editing one can never
   * change what it was: its Druckverlauf, its Alarmdruck crossing and its place in the Rapport
   * all hang off this one word. The chooser below is therefore rendered for `create` only. */
  const [kind, setKind] = useState<TruppKind>(initial?.kind ?? 'atemschutz')
  const isPa = kind === 'atemschutz'
  // …and the Auftrag tiles follow it: each kind has its own six-word vocabulary (config ·
  // atemschutz.auftrag / .auftragEinfach). Only the OFFER is narrowed — an already-stored value
  // from the other list keeps rendering everywhere (lib/report · truppAuftragLabel).
  const auftragTypes: { id: TruppAuftrag; label: string }[] = isPa ? cfg.auftrag : cfg.auftragEinfach
  // a fresh cylinder for create / re-deploy; edit never touches pressure. A Trupp without
  // Atemschutz has no cylinder at all — 0, and the field is not shown (see `showPressure`).
  const [pressure, setPressure] = useState<number>(() => {
    const dz = atemschutzDoctrine()
    return mode === 'edit' ? (initial?.entryPressureBar ?? dz.defaultPressureBar) : dz.defaultPressureBar
  })
  // No autofocus: on a tablet the on-screen keyboard would immediately cover the form's other
  // fields. The EL taps the field they want first.
  // Esc closes the form (keyboard parity with the scrim/close-button)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
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
  const conflictRef = useRef<HTMLParagraphElement>(null)

  // ⚠️ Shown in EVERY mode, including 'edit'. Hiding it there meant a mistyped Eingangsdruck could
  // never be corrected — and it is the number the Verbrauch and the tiefster Druck on the Rapport
  // are measured against. In edit mode it corrects what was recorded; it never counts as a contact.
  // ⚠️ …but only for a Trupp under PA: there is no cylinder to read on a Verkehrstrupp, and a
  // «Speichern» blocked on `pressure > 0` for a number that does not exist would be a dead button.
  const showPressure = isPa
  const isEdit = mode === 'edit'
  const isAnderes = auftrag === 'anderes'
  // ⚠️ The Auftrag no longer BLOCKS. It is behind the fold now, and a Trupp standing at the door
  // must not wait on a field — the Überwachung exists to run a clock, and the job can be filled
  // in a tap later (the card says «Auftrag offen» until it is). «Anderes» still needs its word:
  // it is a label that says nothing on its own.
  const auftragOk = !isAnderes || ziel.trim().length > 0
  // A linked person already deployed in another active Trupp blocks submit (one person, one
  // Trupp). The picker no longer OFFERS one — but an existing Trupp being edited can still carry
  // somebody who was assigned elsewhere in the meantime, and that has to be sayable.
  const assignedConflict = useMemo(() => {
    for (const sl of team) {
      if (sl.personId && assignedIds.has(sl.personId)) return sl.name.trim() || az.assignedFallbackName
    }
    return null
  }, [team, assignedIds])
  const leaderOk = (team[0]?.name.trim().length ?? 0) > 0
  const canSubmit = auftragOk && leaderOk && (!showPressure || pressure > 0) && !assignedConflict
  const [step, setStep] = useState<1 | 2>(mode === 'create' ? 1 : 2)
  // ⚠️ The KIND has no say in this (03.09., see the note above the component). It used to —
  // `wizard && isPa` — and the price was a form that re-flowed under the thumb that had just
  // tapped «Ohne Atemschutz», on the very step that tile lives on. A plain Trupp walks the same
  // two steps; its step 2 is just shorter, because `showPressure` drops the Druck by itself.
  const showTeam = !wizard || step === 1
  const showRest = !wizard || step === 2

  const dropDraft = () => { clearAuftrag(); clearZiel(); clearTeam() }
  const submit = (standby = false) => {
    if (!canSubmit) return
    dropDraft()
    const cleanMembers = team.slice(1).filter((m) => m.name.trim())
    const memberPersonIds = cleanMembers.map((m) => m.personId).filter(Boolean) as string[]
    onSubmit({
      name: team[0].name.trim(),
      members: cleanMembers.length ? cleanMembers.map((m) => m.name.trim()) : undefined,
      auftrag: auftrag ?? undefined,
      ziel: ziel.trim() || undefined,
      lineNo: lineNo ?? undefined,
      funkkanal: Number.isFinite(funkkanal) ? funkkanal : undefined,
      // 0 for a Trupp without Atemschutz — there is no cylinder, and the field was never shown.
      // The create path is the ONLY reader of `kind` (types · TruppFields); editTrupp and
      // reactivateTrupp deliberately ignore it, which is what makes the kind immutable.
      pressure: isPa ? pressure : 0,
      leaderPersonId: team[0].personId,
      memberPersonIds: memberPersonIds.length ? memberPersonIds : undefined,
      color, // null = automatic
      kind,
    }, standby)
  }

  /** Retrigger the same flash-ring `focusSection` gives an opened section (`.formFlash` above),
   *  imperatively — a second blocked tap must ring again, which a className tied to render state
   *  alone cannot do without a remount. Mirrors the identical remove/reflow/add idiom the board's
   *  own card flash uses (AtemschutzView · TruppCard/TruppRow) for the same reason. */
  const flashSection = (el: HTMLElement | null) => {
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove(s.formFlash)
    void el.offsetWidth
    el.classList.add(s.formFlash)
    window.setTimeout(() => el.classList.remove(s.formFlash), 1900)
  }
  /**
   * «Speichern» while the Trupp isn't valid yet used to just sit there disabled — with Art
   * «Anderes» and an empty Auftrag/Ziel, nothing on screen said why (field feedback, 02.09.:
   * «weil ich 'Anderes' gewählt habe … Evtl. auch hier ein Blink, Blink → Hinweis»). The button
   * is no longer natively `disabled` (which swallows the tap outright and cannot explain
   * itself, and the OS-notification affordance for that ANYWAY-focusable state is `aria-disabled`
   * instead) — a blocked tap now points at and flashes the one field actually holding it back,
   * in the same precedence `canSubmit` itself checks. A wizard step whose reason lives on the
   * OTHER step (the team) walks back to it first.
   */
  const attemptSubmit = (standby = false) => {
    if (canSubmit) { submit(standby); return }
    if (!leaderOk) {
      toast(az.saveBlockedTeam, { icon: 'warn', tone: 'warn' })
      if (wizard && step !== 1) { setStep(1); requestAnimationFrame(() => flashSection(teamRef.current)) }
      else flashSection(teamRef.current)
      return
    }
    // the conflict already prints its own sentence right on the form (see below) — a toast
    // repeating it would say the same thing twice, so this only points at it
    if (assignedConflict) { flashSection(conflictRef.current); return }
    if (!auftragOk) {
      toast(az.saveBlockedAuftrag, { icon: 'warn', tone: 'warn' })
      flashSection(auftragRef.current); flashSection(zielRef.current)
      return
    }
    if (showPressure && pressure <= 0) {
      toast(az.saveBlockedPressure, { icon: 'warn', tone: 'warn' })
      flashSection(pressureRef.current)
    }
  }

  const title = mode === 'edit' ? az.formEditTitle : mode === 'redeploy' ? az.formRedeployTitle : az.formCreateTitle
  const submitLabel = mode === 'edit' ? az.save : mode === 'redeploy' ? az.reenterSubmit : az.start

  // portal to <body> so the modal escapes the .surface stacking context (z-index 20) and covers
  // the TopBar ("+ Eintrag", z-index 40) instead of rendering beneath it
  return (
    <Overlay open onClose={onCancel} className={cx(s.modal, wizard && s.modalWizard)} ariaLabel={title}>
      <div className={s.modalHead}>
        <h3>{title}</h3>
        <button className={s.iconBtn} aria-label={az.cancel} onClick={onCancel}><Icon id="close" /></button>
      </div>
      {wizard && (
        <>
          <div className={s.steps} aria-hidden><span className={s.stepOn} /><span className={cx(step === 2 && s.stepOn)} /></div>
          {/* both captions are the step's QUESTION — steps can be walked freely, so step 2 must
              say what it asks even when nobody is picked yet.
              ⚠️ «Was machen sie?», not «Luft»: outside the handed-over board step 2 also carries
              Leitung und Farbe, so naming it after the cylinder would describe a third of it —
              and since 03.09. a Trupp ohne Atemschutz walks the same two steps, where there is no
              cylinder at all. Both captions therefore hold for BOTH Arten, and neither is
              kind-aware on purpose: «Art des Trupps» is chosen on step 1, so a caption that
              switched with the tile would rewrite the heading under the thumb that tapped it.
              Step 1 asks «Wer bildet den Trupp?» for the same reason — «Wer geht rein?» was true
              only while the wizard was PA-only (copy · atemschutz.wizardWho). */}
          <div className={s.stepCap}>
            {fillTemplate(az.wizardStep, { n: step })} · {step === 1 ? az.wizardWho : az.wizardWhat}
          </div>
        </>
      )}

        <div className={s.modalBody}>
          {/* ⚠️ ORDER. What starts the clock comes first: who goes in, and with how much air.
              Everything else is refinement and lives one tap away — on a phone the old order put
              five optional fields between the EL and the two mandatory ones. */}
          {/* ── «Art des Trupps» ────────────────────────────────────────────────────────────
              FIRST, spanning the form, and only while creating one: it decides what the rest of
              this form even asks (Druck), which section the card lands in, and whether the Trupp
              is on the Atemschutz page of the Rapport — so it cannot sit below the fields it
              governs. Never on the handed-over Tafel: that session operates the
              Atemschutzüberwachung, so «ohne Atemschutz» is not a thing it may create.
              Two labelled tiles rather than a Segmented pair: the choice is not a yes/no property
              of a Trupp, it is which of two different things is being registered, and each side
              says what it brings with it (recognition over recall). */}
          {mode === 'create' && !lite && showTeam && (
            <div className={s.formColWide}>
              <div className={s.field}>
                <span>{az.kindLabel}</span>
                <div className={s.kindSeg} role="radiogroup" aria-label={az.kindLabel}>
                  <button type="button" role="radio" aria-checked={isPa}
                    className={cx(s.kindOpt, isPa && s.on)} onClick={() => setKind('atemschutz')}>
                    <Icon id="gauge" />
                    <span className={s.kindOptTxt}><b>{az.kindAtemschutz}</b><span>{az.kindAtemschutzHint}</span></span>
                  </button>
                  <button type="button" role="radio" aria-checked={!isPa}
                    className={cx(s.kindOpt, !isPa && s.on)} onClick={() => setKind('einfach')}>
                    <Icon id="people" />
                    <span className={s.kindOptTxt}><b>{az.kindPlain}</b><span>{az.kindPlainHint}</span></span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {showTeam && (
          <div className={s.formCol}>
            <div ref={teamRef} className={s.field}>
              <span>{az.sectionTeam}</span>
            {/* One list, leader first. A Trupp is valid with exactly one name (the
                Gruppenführer), so a two-person Trupp, a four-person Trupp and a mis-tap are all
                one tap apart — which the three fixed slots could not do. */}
            <TruppTeam
              value={team} onChange={setTeam}
              personnel={personnel} legacyRoster={roster} presentIds={presentIds} stationIds={stationIds}
              assignedIds={assignedIds} rolesById={rolesById} onAddGuest={onAddGuest}
            />
            </div>
          </div>
          )}

          {showRest && (
          <div className={s.formCol}>
            {showPressure && (
              <div ref={pressureRef} className={s.field}>
                <span>{mode === 'redeploy' ? az.newPressureLabel : isEdit ? az.editPressureLabel : az.pressureLabel}</span>
                <PressureStepper value={pressure} onChange={setPressure} compact />
                {/* said out loud, because the same ± on the CARD does the opposite: there it is a
                    Druckmeldung and resets the contact clock. Here it corrects the record. */}
                {isEdit && <p className={s.fieldNote}>{az.editPressureHint}</p>}
              </div>
            )}

            {/* Kanal rides with the Druck: two short numbers between two big buttons, the pair
                you set on every single Trupp. Everything below is the Auftrag — worth having,
                never a reason to hold a Trupp at the door.
                ⚠️ No section headings in here. Uppercase labels over rules cut the form into
                four boxes and each rule cost a row, in a modal sized to a tablet; every field
                already says what it is, and «AUFTRAG» over a field called «Auftrag / Ziel» was
                the same word twice. */}
            <div className={s.field}>
              <span>{az.funkkanalSection}</span>
              <FunkkanalStepper value={funkkanal} onChange={setFunkkanal} compact />
            </div>

            {/* «Auftrag offen» flashes BOTH halves of the answer — «Art» AND «Auftrag / Ziel»
                (field decision 30.08.): the gap on the card is the pair, not one field. */}
            <div ref={auftragRef} className={cx(s.field, focusSection === 'auftrag' && s.formFlash)}>
              <span>{az.auftragLabel}</span>
              {/* The list that matches the Trupp's KIND — a Verkehrstrupp was being offered
                  «Löschen» (field report 03.09.). Both lists are six tiles, so the form keeps
                  its shape; `sichern` and `anderes` are literally the same id on both sides
                  (config · atemschutz.auftragEinfach), so switching the tiles above cannot
                  invalidate a value that is already picked. */}
              <Segmented
                ariaLabel={az.auftragLabel}
                value={auftrag ?? undefined}
                onChange={(v) => setAuftrag(v)}
                options={auftragTypes.map((a) => ({ value: a.id, label: az.auftragLabels[a.id] ?? a.label }))}
              />
            </div>
            <label ref={zielRef} className={cx(s.field, focusSection === 'auftrag' && s.formFlash)}>
              <span>{az.zielLabel}</span>
              {/* ✕: a Trupp that comes back and goes in again gets a NEW order, and the old one
                  is not a starting point for typing it — «2. OG Wohnung Nord, 2 Personen
                  vermisst» had to be select-all-deleted by hand on a phone, mid-Einsatz. */}
              {/* ⚠️ ONE placeholder, for every Auftrag and both Arten (03.09.). It used to switch
                  — «z. B. 2OG links» normally, the generic sentence only under «Anderes» — and a
                  storey reference is Atemschutz vocabulary: under Auftrag «Verkehr» the example
                  proposed a place that does not exist there. */}
              <ClearableInput
                value={ziel} placeholder={az.zielPlaceholder}
                // caps chosen so the card's one-line Ziel and the Leitung chip can't be blown out:
                // «2. OG Wohnung Nord, 2 Personen vermisst» is 39 chars, a Leitung is «1»–«12»
                maxLength={60}
                clearLabel={az.zielClear}
                onChange={(v) => setZiel(stripUnprintable(v))}
              />
            </label>
            {/* The SAME 1–99 number the DrawEditor stamps on a hose — one type on both sides is
                what lets a Trupp and a drawn Leitung find each other without anyone re-typing
                anything (lib/truppLines). A Trupp recorded before this was free text keeps its
                text below; it is never rewritten.
                ⚠️ NOT on the lite form (reverted, round 2 review — briefly shown 02.09. after a
                field report, «no picture, no point» wasn't a strong enough reason at the time):
                a link holder has no picture to read a hose number off and no surface to draw one
                on, so the field could only ever be a number typed blind — and one Leitung, one
                Trupp is enforced against what is actually drawn regardless (see submitForm's
                takeover confirm). The FU sets it on the KP tablet. */}
            {!lite && (
            <div className={cx(s.field, s.lineField)}>
              <span>{az.lineNoLabel}</span>
              {/* stepper and the drawn Leitungen share ONE row: the stepper is for a number that
                  isn't drawn yet, the chips are the common case, and stacking them cost three
                  rows of a form that has to fit on a tablet in one glance */}
              <div className={s.lineRow}>
                <Stepper
                  value={lineNo} min={1} max={99} placeholder="–"
                  onChange={setLineNo} onClear={() => setLineNo(null)} canClear={lineNo != null}
                  ariaLabel={az.lineNoLabel}
                />
                {/* The Leitungen that are actually DRAWN. Typing a number blind is how the two
                    sides end up disagreeing — the hose usually exists long before anyone
                    registers the Trupp. A number someone else is on stays pickable (real
                    incidents need corrections) but says whose it is. */}
                {leitungOptions.length > 0 && (
                  <div className={s.lineOpts}>
                    <span className={s.lineOptsLabel}>{az.lineOptsLabel}</span>
                    {leitungOptions.map((o) => (
                      <button
                        key={o.no} type="button"
                        className={cx(s.lineOpt, lineNo === o.no && s.on, !!o.takenBy && s.taken)}
                        title={o.takenBy ? fillTemplate(az.lineOptTaken, { name: o.takenBy }) : undefined}
                        onClick={() => setLineNo(o.no)}
                      >
                        {o.no}{o.onPlan ? ' ·\u00a0P' : ''}{o.takenBy ? ` · ${abbreviateName(o.takenBy)}` : ''}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {legacyLine && <p className={s.fieldNote}>{fillTemplate(az.lineLegacyNote, { value: legacyLine })}</p>}
            </div>
            )}
            {/* The colour this Trupp wears on the Lage and on the plan. «Automatisch» is the
                normal case (every Trupp a different one); picking is for when the EL would rather
                read the picture by role — «alle Löschtrupps rot» — and a duplicate is then the
                point, not a mistake, so nothing here refuses one. */}
            {/* Not on the handed-over form: the colour is a Lage/plan matter, and «automatisch» is
                exactly what a phone at the Eingang should get — one thing less to decide. */}
            {!lite && (
            <div className={s.field}>
              <span>{az.colorLabel}</span>
              <div className={s.colorRow}>
                <button
                  type="button" className={cx(s.colorAuto, color == null && s.on)} aria-pressed={color == null}
                  title={az.colorAutoHint} onClick={() => setColor(null)}
                >{az.colorAuto}</button>
                {appConfig.drawing.teamColors.map((c) => (
                  <button
                    key={c} type="button" className={cx(s.colorDot, color === c && s.on)} style={{ background: c }}
                    aria-label={c} aria-pressed={color === c} onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
            )}
          </div>
          )}

          {assignedConflict && (
            <p ref={conflictRef} className={cx(s.formColWide, s.formWarn)}>
              <Icon id="warn" /><span>{fillTemplate(az.assignedConflict, { name: assignedConflict })}</span>
            </p>
          )}
        </div>

      <div className={s.modalFoot}>
        {/* the house button family — three private classes here were the last of this modal's own
            design system (see Atemschutz.module.css · .modal) */}
        {/* the ONLY control that throws the draft away — ✕ and the backdrop keep it */}
        {wizard && step === 2 ? (
          <button className="ip-btn ghost" onClick={() => setStep(1)}>{az.wizardBack}</button>
        ) : (
          <button className="ip-btn ghost" onClick={() => { dropDraft(); onCancel() }}>{az.cancel}</button>
        )}
        {wizard && step === 1 ? (
          /* never disabled — the steps can be walked freely; only the final submit gates on a
             valid Trupp (canSubmit) */
          <button className="ip-btn primary" onClick={() => setStep(2)}>{az.wizardNext}</button>
        ) : (<>
        {/* Re-deploy forks here: a re-equipped Trupp is just as often held back as Sicherungstrupp
            as it is sent straight in. Both buttons take the same filled-in form, so the choice
            costs nothing — and «Bereitstellen» is the one that must NOT start a contact clock.
            It is also what actually happens first: a Trupp comes out, gets a fresh bottle and
            waits. So on re-deploy «Bereitstellen» carries the primary weight and «Einrücken»
            steps back — the ORDER stays as it was, only the emphasis swaps, so nobody has to
            re-learn where the button is. */}
        {/* ⚠️ Under PA only. «Bereitstellen» exists because a re-equipped Trupp is as often held
            back as Sicherungstrupp as it is sent in — and a Sicherungstrupp is by definition a
            crew standing by under Atemschutz. A work squad has one way back in. */}
        {mode === 'redeploy' && isPa && (
          <button className={cx('ip-btn primary', !canSubmit && s.btnBlocked)} aria-disabled={!canSubmit}
            onClick={() => attemptSubmit(true)} title={az.reenterStandbyHint}>
            {az.reenterStandby}
          </button>
        )}
        {/* ⚠️ `aria-disabled`, not `disabled` (field feedback, 02.09.): a native `disabled` button
            swallows the tap before it ever reaches a handler, which is exactly what left
            «Speichern» unresponsive with nothing to explain why. This one stays clickable and
            `attemptSubmit` decides — flash the missing field when blocked, submit when not. */}
        {/* …and it takes the primary weight back when «Bereitstellen» is not there to carry it */}
        <button className={cx(mode === 'redeploy' && isPa ? 'ip-btn' : 'ip-btn primary', !canSubmit && s.btnBlocked)}
          aria-disabled={!canSubmit} onClick={() => attemptSubmit()}>{submitLabel}</button>
        </>)}
      </div>
    </Overlay>
  )
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
}
