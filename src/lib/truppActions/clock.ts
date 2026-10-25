import type { Trupp } from '../../types'
import { appConfig } from '../../config/appConfig'
import { fillTemplate, formatTime } from '../format'
import { toast, undoToast } from '../ui'
import { atemschutzDoctrine } from '../deploymentConfig'
import { alarmBarFor, currentRunStart, earlyEntryCorrection, fmtDuration, isAtemschutzTrupp, notfallFacts, notfallOffered, safetyReady, truppInNotfall, truppLogName } from '../atemschutz'
// ⚠️ Every Trupp timestamp below is stamped in the DEPLOYMENT's time, not the device's
// (lib/serverClock). These are the safety clocks and the legal record: written device-local, a
// tablet six seconds ahead put contact times into the Rapport that no other device agreed with,
// and it won every merge tie (mergeWorkspace · TRUPP_TIME_FIELDS keeps the LATER stamp). Offline
// `serverNowIso()` is the device clock, so a station that has never reached the server is
// unaffected.
import { serverNowIso } from '../serverClock'
import { noteOwnContact, recentOwnContact } from '../contactEcho'
import { keepCrewFiled } from '../crewFiling'
import { recordKey } from '../undoKeys'
import { auftragText, withDetails, type TruppActionCore, type TruppActionDeps } from './core'

// The Trupp CLOCK family — the safety-critical rules: Funkkontakt, Druckmeldung, the lifecycle
// transitions that start, reset or stop the contact clock (setTruppStatus), the Notfall, and the
// alarm rows. Reads and writes the Trupps alone: no map, no plan, no hose, so these rules are
// testable without the placement graph (clock.test.ts). Composed by lib/useTruppActions.

/**
 * The Eingangsdruck of the RUNNING deployment, corrected to `bar` — the one patch both paths
 * that correct it share: the form's Druck field (editTrupp) and a Druckmeldung recorded in the
 * first minutes after the Eintritt (recordPressure · lib/atemschutz · earlyEntryCorrection).
 * What it does and deliberately does NOT do (2026-08-10):
 *   · it rewrites entryPressureBar and the FIRST reading of the current run (the entry /
 *     registered one), because that row is the same statement written twice — leaving it would
 *     print a Verlauf that contradicts the card,
 *   · it re-derives lowestBar from the corrected value and the readings that followed, so a
 *     corrected entry cannot leave a «tiefster Druck» that was never measured,
 *   · it does NOT set lastContactTime. This is a correction of what was written down, not a
 *     Druckmeldung — a measured Druck is what resets the safety clock.
 *   · it marks that row `measured` (25.09.2026): whoever corrected it read a gauge, and a
 *     later first Druckmeldung must not «correct» it again (lib/atemschutz ·
 *     entryPressureConfirmed).
 * Empty when nothing changes, so a caller can spread it unconditionally.
 */
export const correctEntryPressure = (t: Trupp, bar: number): Partial<Trupp> => {
  if (bar === t.entryPressureBar) return {}
  // ⚠️ The CURRENT deployment's entry row, not the log's first one. A re-deployed Trupp carries
  // every earlier reading with it now (see reactivateTrupp), and index 0 is then the entry of
  // an Einsatz that is over — correcting the Eingangsdruck would have rewritten the wrong row
  // and measured «tiefster Druck» across both.
  const from = currentRunStart(t.readings)
  const readings = (t.readings ?? []).map((r, i) =>
    (i === from && (r.kind === 'entry' || r.kind === 'registered') ? { ...r, bar, measured: true as const } : r))
  // the lowest pressure of the running deployment: the corrected entry, plus every reading
  // actually taken since. Recomputed rather than min()'d against the old lowestBar, which
  // may itself be the wrong entry value.
  // …a `crew` row's bar is CARRIED (crewRow), so it may still hold the value being corrected
  const lowestBar = Math.min(bar, ...readings.slice(from).filter((r) => r.kind !== 'crew').map((r) => r.bar))
  return { entryPressureBar: bar, readings, lowestBar }
}

type ClockDeps = Pick<TruppActionDeps, 'trupps' | 'setTrupps' | 'log' | 'emit' | 'liveTrupps' | 'placeOf'>
  & Pick<TruppActionCore, 'remember' | 'logStep' | 'recorded'>

export function truppClockActions(deps: ClockDeps) {
  const { trupps, setTrupps, log, emit, liveTrupps, placeOf, remember, logStep, recorded } = deps

  // record a Funkkontakt: resets the contact clock (the core FKS safety signal) and appends a
  // log row carrying the current pressure (so the Verlauf shows the trend even at radio checks)
  //
  // ⚠️ This was the ONE mutation in the app with no undo, and the one that most needed it. The
  // board floats überfällige Trupps to the front, so a Kontakt drops its card out of that group
  // and everything below slides up: measured, the pixel the finger had just left belonged to a
  // DIFFERENT Trupp ~250ms later. A Kontakt booked on the wrong Trupp is a false statement in the
  // legal record — «this crew was reached» — and it silences that Trupp's alarm. The sort freeze
  // in AtemschutzView stops it happening; this is the way back when it does.
  const recordContact = (id: string) => {
    const tr = trupps.find((t) => t.id === id)
    const now = serverNowIso()
    /* ⚠️ The SAME tap twice is one Kontakt (staging walk-through 25.09.2026: a double tap wrote two
     * contacts and two Verlauf rows). A repeat on the same Trupp from this device within
     * OWN_REPEAT_MS writes nothing — on every board, because it is decided here, where the
     * contact is written. Another device's contact is the echo question (lib/contactEcho). */
    if (recentOwnContact(id, Date.parse(now))) return
    const apply = (t: Trupp): Trupp => ({ ...t, lastContactTime: now, readings: [...(t.readings ?? []), { t: now, bar: t.lastPressureBar ?? t.entryPressureBar, kind: 'contact' }] })
    setTrupps((ts) => ts.map((t) => (t.id === id ? apply(t) : t)))
    // this device's own confirmation — what lets a second device's tap within a minute ask first
    // instead of writing a second contact (lib/contactEcho, 24.09.2026)
    noteOwnContact(id, now)
    const line = fillTemplate(appConfig.copy.atemschutz.logContact, { name: tr ? truppLogName(tr) : '' })
    log('radio', line, 'team', undefined, undefined, { subjectId: id })
    emit('atemschutz.contact', { id })
    // ⚠️ NO toast (08.09.2026). Kontakt is the highest-frequency tap on the board — a dozen an
    // hour per Trupp — and its own confirmation was already on the card: the clock the tap just
    // reset, ticking again from zero. The toast added a pill over the board for six seconds after
    // every one of them, which is how the operator learns to swipe toasts away without reading —
    // and then misses the one that mattered. The way back is the header's ↶, which now names
    // this Trupp, so «I meant the card above» is one press instead of a six-second window.
    remember(id, line, tr, apply)
  }

  // record a cylinder pressure reading — logged for the record, and counts as a contact. All
  // derived state (lowestBar, the log row) is computed INSIDE the updater so it never reads stale.
  const recordPressure = (id: string, bar: number) => {
    const tr = trupps.find((t) => t.id === id)
    const now = serverNowIso()
    // Crossing the Alarmdruck is the moment the Trupp has to turn round, and it was visible on
    // the card and nowhere else — the reconstruction afterwards could not say when it happened.
    // Only on the CROSSING, so a Trupp already below the threshold does not repeat it at every
    // contact — and as ONE row, not a second one after the reading: the crossing IS this reading,
    // and two lines in the same minute read as two Druckmeldungen on the printed Journal.
    const doctrine = atemschutzDoctrine()
    const alarmBar = tr ? alarmBarFor(tr, doctrine) : doctrine.alarmBar
    const wasAbove = (tr?.lastPressureBar ?? tr?.entryPressureBar ?? Infinity) > alarmBar
    const crossed = !!tr && alarmBar > 0 && wasAbove && bar <= alarmBar
    /* ⚠️ A Druck in the first minutes after the Eintritt, before any other reading, is the
     * Eingangsdruck being asked for late — not a measurement (14.09., field observation: the
     * Trupp goes in on the default 300, the real gauge is recorded a minute later, and the
     * Schätzung read a 20-bar drop per minute). It takes the same correction the form's Druck
     * field writes (correctEntryPressure): baseline replaced, no `pressure` row, no contact
     * stamp — the trend starts from the corrected number. Never for a value at or below the
     * Alarmdruck: that IS the emergency, and the crossing row above has to name it. */
    /* ⚠️ …and it IS a Kontakt (staging walk-through 25.09.2026). The sheet says «zählt als
     * Kontakt», and the radio call happened: the correction used to leave lastContactTime at the
     * Eintritt, so the Trupp fell due five minutes after going in although the operator had just
     * spoken to it — and the Rapport had no Kontakt at that minute. Now it stamps the clock and
     * appends a `contact` row carrying the new bar, beside the corrected baseline, in ONE Verlauf
     * row that says both. It never touches an Eingangsdruck set on purpose
     * (earlyEntryCorrection → entryPressureConfirmed); the PressureSheet names the rule. */
    if (tr && !crossed && earlyEntryCorrection(tr, Date.parse(now))) {
      const apply = (t: Trupp): Trupp => {
        const c = { ...t, ...correctEntryPressure(t, bar) }
        return { ...c, lastContactTime: now, readings: [...(c.readings ?? []), { t: now, bar, kind: 'contact' as const }] }
      }
      setTrupps((ts) => ts.map((t) => (t.id === id ? apply(t) : t)))
      noteOwnContact(id, now)
      const az = appConfig.copy.atemschutz
      const line = fillTemplate(bar === tr.entryPressureBar ? az.logFirstPressureSame : az.logFirstPressure,
        { name: truppLogName(tr), bar, from: tr.entryPressureBar })
      log('radio', line, 'team', undefined, undefined, { subjectId: id })
      emit('atemschutz.contact', { id })
      if (bar !== tr.entryPressureBar) emit('atemschutz.edit', { id })
      remember(id, line, tr, apply)
      return
    }
    // …and the LOG ROW says so too, so the printed Atemschutz-Journal can name the moment
    // instead of leaving a reader to compare a column of numbers against the station's doctrine
    const apply = (t: Trupp): Trupp => ({ ...t, lastPressureBar: bar, lastPressureTime: now, lastContactTime: now, lowestBar: Math.min(t.lowestBar ?? t.entryPressureBar, bar),
      readings: [...(t.readings ?? []), { t: now, bar, kind: crossed ? 'alarm' : 'pressure' }] })
    setTrupps((ts) => ts.map((t) => (t.id === id ? apply(t) : t)))
    noteOwnContact(id, now) // a Druckmeldung confirms the contact too (lib/contactEcho)
    const line = fillTemplate(
      crossed ? appConfig.copy.atemschutz.logPressureAlarm : appConfig.copy.atemschutz.logPressure,
      { name: tr ? truppLogName(tr) : '', bar },
    )
    log(crossed ? 'warn' : 'drop', line, 'team', undefined, undefined, { subjectId: id })
    emit('atemschutz.pressure', { id, bar })
    // The way back: a fat-fingered reading ("20" for "200") would otherwise permanently poison
    // lowestBar → a false red «tiefster Druck» on the legal record. Undo restores the Trupp's
    // pre-reading state (pressure, contact clock, lowestBar, per-Trupp readings); the Verlauf
    // line stays (append-only doctrine — the record shows the correction happened).
    // ⚠️ On the GLOBAL ↶ timeline only, since 09.09.: the confirm-with-undo toast that used to
    // double it is gone — the board raised one for every Kontakt/Druck/Statuswechsel and the
    // steady popping read as noise over the very board being watched. The header pair (which
    // the handed-over Tafel carries too) names the step and does not expire.
    remember(id, line, tr, apply)
  }

  // advance a Trupp's lifecycle phase: angemeldet → aktiv (eingerückt, starts the contact clock +
  // logs the entry reading) → rueckzug → raus (sets exitTime, ends monitoring), and the reverse
  // rueckzug → aktiv (the Rückzug was called off). Logs the matching Verlauf line.
  //
  // Rückzug and Fortsetzen COUNT AS A FUNKKONTAKT and reset the contact clock. Neither happens
  // spontaneously: a Rückzug is ordered by the EL or the Truppüberwacher, or reported by the
  // Trupp, and a Fortsetzen means the Trupp was reached and sent back in. Leaving the clock
  // running afterwards showed «überfällig» on a Trupp somebody had just spoken to, which trains
  // the Überwacher to ignore red. Same rule a Druckmeldung already follows (recordPressure).
  /* `exitBar` — the Restdruck asked at «Raus melden» (24.09.2026, AtemschutzView · PressureSheet).
   * Only meaningful for `raus`; absent = «Ohne Druck raus», which writes exactly what it always
   * did (the last known value, carried). Given, the exit row carries a MEASURED bar
   * (types · TruppReading.measured) and the Trupp's pressure state takes it like a Druckmeldung —
   * without touching the contact clock, which stops at the Austritt anyway. */
  const setTruppStatus = (id: string, status: Trupp['status'], exitBar?: number, opts?: { undoToast?: boolean }) => {
    const tr = trupps.find((t) => t.id === id)
    const measuredExit = status === 'raus' && exitBar != null && exitBar > 0 && !!tr?.entryTime
    const az = appConfig.copy.atemschutz
    /* ⚠️ A transition INTO the state the Trupp is already in does nothing at all (04.09.,
     * Feldtest: «Austritt 2×» on one afternoon). Every one of these buttons sits under a finger
     * that has just been told nothing happened — the board re-sorts, a phone is a beat behind,
     * a second tablet shows the same card — so the second tap arrived, and it was not free:
     *   · «Raus melden» wrote a SECOND «Austritt» row and moved exitTime to the later instant,
     *     so the sheet reported the crew coming out at a time nobody watched them come out,
     *   · «Einrücken» tapped twice wrote «Eintritt» and then «Einsatz fortgesetzt» — a Rückzug
     *     that never happened, and the clock reset that goes with it.
     * The tap is not a fact, it is a request to record one; recording it again cannot be right.
     * (The guard reads the Trupp as this render sees it, so it also catches the second device
     * once the merge has arrived. Two taps inside ONE frame are still two rows — the repeat
     * folding in the Verlauf is what covers that, see lib/verlauf · repeatRuns.) */
    if (tr && tr.status === status) return
    if (recorded.get(id) === status) return // …and the same tap twice inside one frame (see `recorded`)
    recorded.set(id, status)
    const now = serverNowIso()
    const isResume = status === 'aktiv' && !!tr?.entryTime // back into the field after a Rückzug
    const impliesContact = status === 'rueckzug' || isResume
    /* ⚠️ «Raus» ENDS a running Notfall (owner, 10.10.2026: «draussen also means we have the
     * emergency completed»). The crew is out — there is nobody left inside to rescue — so the one
     * report says both, as ONE unit: `notfallAt` goes and a `notfallEnde` reading joins the exit
     * row, the Verlauf gets «Notfall beendet – Dauer … – Trupp draussen» beside the Austritt, the
     * `atemschutz.notfallEnde` event is the held «Notfall beendet»'s, and ONE ↶ step puts the
     * crew back inside AND in the Notfall with its original clock. The server sees what it sees
     * for a held end — `notfallAt` gone on a card still on the board (push · notfall_changes) —
     * and pushes «Notfall beendet» once. */
    const endsNotfall = status === 'raus' && !!tr && truppInNotfall(tr)
    const endNotfallOf = (t: Trupp): Trupp => {
      if (!endsNotfall || !t.notfallAt) return t
      const { notfallAt: _end, ...rest } = t
      return { ...rest, readings: [...(t.readings ?? []), { t: now, bar: t.lastPressureBar ?? t.entryPressureBar, kind: 'notfallEnde' }] }
    }
    // ⚠️ Named, and reused verbatim by the timeline's ↷ (see `remember`): the whole transition —
    // status plus entryTime plus exitTime plus the reading — is ONE unit, and re-running the
    // action instead would stamp `now` a second time and move a safety clock forward.
    const apply = (t: Trupp): Trupp => {
      if (status === 'aktiv' && !t.entryTime) {
        return { ...t, status, entryTime: now, lastContactTime: now, readings: [...(t.readings ?? []), { t: now, bar: t.entryPressureBar, kind: 'entry' }] }
      }
      // ⚠️ The Austritt is a ROW too (19.08.). It lived only in the sheet's header, so the
      // printed pressure log simply stopped mid-Einsatz and the reader had to look up to find
      // out whether the crew ever came out. The clock is untouched — this only records.
      if (status === 'raus') {
        if (measuredExit) {
          return endNotfallOf({ ...t, status, exitTime: now, lastPressureBar: exitBar, lastPressureTime: now,
            lowestBar: Math.min(t.lowestBar ?? t.entryPressureBar, exitBar),
            readings: [...(t.readings ?? []), { t: now, bar: exitBar, kind: 'exit', measured: true }] })
        }
        return endNotfallOf({ ...t, status, exitTime: now, readings: [...(t.readings ?? []), { t: now, bar: t.lastPressureBar ?? t.entryPressureBar, kind: 'exit' }] })
      }
      if (impliesContact) {
        // ⚠️ A Rückzug is written down AS a Rückzug. It counts as a Funkkontakt and used to be
        // logged as nothing but one, so the printed Journal showed the order to come back as an
        // ordinary radio check — the one row a reconstruction is looking for, indistinguishable
        // from the twenty around it.
        // ⚠️ …and so is the way back IN (19.08., reversing «a Fortsetzen stays a plain Kontakt»).
        // It IS a Kontakt — the Trupp was reached — but a crew being sent back into the building
        // is the other half of the Rückzug, and printing it as one of twenty radio checks left
        // the sheet saying a Trupp withdrew and never went back. Same clock reset, own word.
        const kind = status === 'rueckzug' ? 'rueckzug' as const : 'resume' as const
        return { ...t, status, lastContactTime: now, readings: [...(t.readings ?? []), { t: now, bar: t.lastPressureBar ?? t.entryPressureBar, kind }] }
      }
      return { ...t, status }
    }
    setTrupps((ts) => ts.map((t) => (t.id === id ? apply(t) : t)))
    // a Rückzug and a Fortsetzen are radio answers — this device's own (lib/contactEcho)
    if (impliesContact) noteOwnContact(id, now)
    // «draussen» on a Trupp that never went in is a false statement about where people were —
    // a Sicherungstrupp that was stood down gets its own line (see atemschutz · truppNeverDeployed)
    const neverDeployed = status === 'raus' && !tr?.entryTime
    /* ⚠️ The Eintritt SAYS which kind of Trupp went in (04.09., Manuel: «Atemschutz beendet» at
     * 16:15 and a bare «Eingerückt» right after it — nothing on the sheet said whether the crew
     * that went in was wearing masks). Only the entry rows carry it: they are the moment the
     * question is asked, and repeating it on every Kontakt would be wallpaper. An Atemschutz
     * Eintritt is unchanged — it is the norm, and its Eingangsdruck already says so. */
    /* ⚠️ …and a SICHERUNGSTRUPP going in says that it did (24.09.2026, D1 ⑦): «Sicherungstrupp
     * eingesetzt» rather than a bare «Eintritt». The crew that stood ready for the others is only
     * ever sent in because something went wrong inside, and that is the one row a reconstruction
     * of the Einsatz looks for first. Derived from the Trupp — Auftrag «Sichern», under PA, its
     * FIRST Eintritt of this run — not from which button was pressed: the phone's «Einsetzen»
     * and the card's «Im Einsatz» put the same crew into the same building. */
    const safetyEntry = !!tr && status === 'aktiv' && !tr.entryTime && tr.auftrag === 'sichern' && isAtemschutzTrupp(tr)
    /* ⚠️ …and while a crew is in a NOTFALL, the row names WHOM it went in for and how long after
     * the Notfall was raised (F1, 08.10.2026) — the one interval a reconstruction measures first.
     * The longest-running Notfall when there are several (the one the alarm chip names too). */
    const notfallFor = safetyEntry
      ? trupps.filter((x) => x.id !== id && truppInNotfall(x)).sort((a, b) => Date.parse(a.notfallAt!) - Date.parse(b.notfallAt!))[0]
      : undefined
    const entryTpl = tr && !isAtemschutzTrupp(tr) ? az.logEntryNoAs : safetyEntry ? (notfallFor ? az.notfall.logSafetyEntry : az.logSafetyEntry) : az.logEntry
    const tpl = status === 'aktiv' ? (isResume ? az.logContinue : entryTpl)
      : status === 'rueckzug' ? az.logRueckzug
      : status === 'raus' ? (neverDeployed ? az.logNotDeployed : measuredExit ? az.logExitBar : az.logExit) : null
    const icon = status === 'raus' ? 'logout' : status === 'rueckzug' ? 'undo' : 'flag'
    const line = tpl ? fillTemplate(tpl, {
      name: tr ? truppLogName(tr) : '', bar: exitBar ?? '',
      ...(notfallFor ? { target: truppLogName(notfallFor), dur: fmtDuration(notfallFacts(notfallFor, Date.parse(now)).sinceSec) } : {}),
    }) : null
    // ⚠️ `subjectId`: the row NAMES this Trupp without becoming a jump target — which is what lets
    // the Verlauf tell a repeated line from a second, real cycle (lib/verlauf · repeatRuns).
    if (line) log(icon, line, 'team', undefined, undefined, { subjectId: id })
    emit('atemschutz.status', measuredExit ? { id, status, bar: exitBar } : { id, status })
    // …and the Notfall it ended, in its own row beside the Austritt (see `endsNotfall`)
    if (endsNotfall && tr) {
      const nf = az.notfall
      log('flag', fillTemplate(nf.logEndOut, { name: truppLogName(tr), dur: fmtDuration(notfallFacts(tr, Date.parse(now)).sinceSec) }),
        'team', undefined, undefined, { subjectId: id })
      emit('atemschutz.notfallEnde', { id })
    }
    /* ⚠️ EVERY transition is undoable, not only «Raus» (23.08.). Three of the four touch the
     * SAFETY CLOCK: «Eingerückt» stamps entryTime and starts it, «Rückzug» and «Fortsetzen»
     * reset it (see the note at the top of this function). So a mis-tap on the wrong card —
     * exactly what the board's 2 s sort freeze and recordContact's undo exist for — silenced
     * that Trupp's amber/red clock and wrote a false line into an append-only record with no
     * way back. «Raus» is terminal on top of that: only a full re-deployment reversed it, and
     * that resets the clocks.
     * Append-only doctrine: the Verlauf keeps its line, because the tap did happen. The undo
     * restores the Trupp's derived state — status, entry/contact clocks, exitTime, readings —
     * which is the same contract Kontakt, Druck and Bearbeiten already offer. It lives on the
     * GLOBAL ↶ timeline (the door that does not expire, named per step, on the handed-over
     * Tafel too) — the confirm toast that used to double it went 09.09. with all the board's
     * popping confirmations. */
    const drop = remember(id, line ?? (tr ? truppLogName(tr) : ''), tr, apply)
    /* A calm word when an Atemschutz-Trupp goes in and nobody stands ready to go in after it (F1,
     * 08.10.2026). A toast, never a question: the Eintritt is already written, and a crew is not
     * held at the door by an app. «Ready» is what the board models (lib/atemschutz · safetyReady):
     * Auftrag «Sichern», under PA, angemeldet. Not for a Sicherungstrupp going in itself, nor on a
     * re-entry after a Rückzug (that crew was inside all along). */
    if (status === 'aktiv' && tr && !tr.entryTime && isAtemschutzTrupp(tr) && !safetyEntry
      && safetyReady(trupps.filter((x) => x.id !== id)).length === 0) {
      toast(az.notfall.noSafetyHint, { icon: 'info' })
    }
    /* …with ONE exception, the card's own «Nicht eingesetzt» (owner review 26.09.2026): it is a
     * visible button again, and a one-shot that closes a Trupp gets the confirm-with-undo toast
     * (docs/undo.md). Its «Rückgängig» takes the step off the timeline and puts the Trupp back as it
     * stood — the Verlauf keeps both lines. Not for the Abschluss's bulk stand-down (no opts). */
    if (opts?.undoToast && neverDeployed && tr) {
      const who = typeof tr.no === 'number' ? String(tr.no) : tr.name
      undoToast(fillTemplate(az.notDeployedToast, { name: who }), () => {
        drop()
        if (!(liveTrupps?.() ?? trupps).some((x) => x.id === id)) return
        recorded.delete(id)
        setTrupps((ts) => ts.map((x) => (x.id === id ? keepCrewFiled(tr, x) : x)))
        logStep('undo', line ?? truppLogName(tr), id)
      })
    }
  }

  /**
   * WHERE the record last saw this Trupp, in words — its Auftrag and Ziel, and the placed symbol's
   * plan + storey or the Karte (`placeOf`). The Notfall's «letzter Ort» (F1): the banner, the
   * Meldeleiste row and the Verlauf row all read it here, so they never name two places.
   */
  const truppPlace = (t: Trupp): string => [auftragText(t.auftrag, t.ziel), placeOf?.(t)].filter(Boolean).join(' · ')

  /**
   * «Notfall» — HELD on a Trupp that is inside (F1, 08.10.2026; AtemschutzView · NotfallHold).
   *
   * An Atemschutznotfall is said by a person — the crew calls it, the Überwacher hears it, a
   * missing answer makes somebody decide — so it is a deliberate act, never a derived state: the
   * hold (lib/nodeHold, the app's one deliberate hold) is the confirmation, and nothing else asks.
   * What it writes, as ONE unit:
   *   · `notfallAt` on the Trupp (the Notfall clock, on every device through the trupps slice),
   *   · a `notfall` row in the Trupp's own log (the Atemschutz page of the Rapport),
   *   · ONE Verlauf row with the facts as they stood at that second — last place, last Kontakt,
   *     last reported Druck with its time, Funkkanal — so the record holds what the EL knew when
   *     the Sicherungstrupp was sent, not what the card says later,
   *   · an `atemschutz.notfall` audit event (the one prefix a Link-Tafel may send).
   * ⚠️ Undoable like every Tafel act (↶, and the confirm-with-undo toast for the fast mistake):
   * the Trupp goes back as it stood, the Verlauf keeps its row AND gets the counter-row — a
   * mistaken trigger is cheap to take back and still on paper (docs/undo.md).
   */
  const triggerNotfall = (id: string) => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr || !notfallOffered(tr)) return
    if (recorded.get(id) === 'notfall') return // the same hold twice inside one frame (see `recorded`)
    recorded.set(id, 'notfall')
    const now = serverNowIso()
    const apply = (t: Trupp): Trupp => ({
      ...t, notfallAt: now,
      readings: [...(t.readings ?? []), { t: now, bar: t.lastPressureBar ?? t.entryPressureBar, kind: 'notfall' }],
    })
    setTrupps((ts) => ts.map((t) => (t.id === id ? apply(t) : t)))
    const nf = appConfig.copy.atemschutz.notfall
    const f = notfallFacts(tr, Date.parse(now))
    const place = truppPlace(tr)
    const facts = [
      place && fillTemplate(nf.factPlace, { place }),
      f.contactAt && fillTemplate(nf.factContact, { time: formatTime(new Date(f.contactAt)) }),
      f.barAt ? fillTemplate(nf.factBar, { bar: f.bar, time: formatTime(new Date(f.barAt)) })
        : f.bar > 0 ? fillTemplate(nf.factBarEntry, { bar: f.bar }) : '',
      f.funkkanal != null && fillTemplate(nf.factKanal, { n: f.funkkanal }),
    ].filter(Boolean)
    const line = withDetails(fillTemplate(nf.logTrigger, { name: truppLogName(tr) }), facts.join(', '))
    log('warn', line, 'team', undefined, undefined, { subjectId: id })
    emit('atemschutz.notfall', { id })
    const drop = remember(id, line, tr, apply)
    const who = typeof tr.no === 'number' ? String(tr.no) : tr.name
    undoToast(fillTemplate(nf.toast, { name: who }), () => {
      drop()
      if (!(liveTrupps?.() ?? trupps).some((x) => x.id === id)) return
      recorded.delete(id)
      setTrupps((ts) => ts.map((x) => (x.id === id ? keepCrewFiled(tr, x) : x)))
      logStep('undo', line, id)
    }, [recordKey('trupps', id)])
  }

  /**
   * «Notfall beendet» — HELD too (F1): ending an emergency must cost the same deliberate act as
   * raising one, and a brushed button that silences the loudest alarm in the app is the failure
   * the hold exists to prevent. Writes the `notfallEnde` reading and ONE Verlauf row with the
   * duration; the Trupp's status is untouched — whether the crew is out is its own report («Raus»,
   * which ends a running Notfall too: setTruppStatus · `endsNotfall`).
   * Undoable on the ↶ timeline: the Notfall comes back with its ORIGINAL clock.
   */
  const endNotfall = (id: string) => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr || !truppInNotfall(tr)) return
    if (recorded.get(id) === 'notfallEnde') return
    recorded.set(id, 'notfallEnde')
    const now = serverNowIso()
    const apply = (t: Trupp): Trupp => {
      const { notfallAt: _end, ...rest } = t
      return { ...rest, readings: [...(t.readings ?? []), { t: now, bar: t.lastPressureBar ?? t.entryPressureBar, kind: 'notfallEnde' }] }
    }
    setTrupps((ts) => ts.map((t) => (t.id === id ? apply(t) : t)))
    const nf = appConfig.copy.atemschutz.notfall
    const line = fillTemplate(nf.logEnd, { name: truppLogName(tr), dur: fmtDuration(notfallFacts(tr, Date.parse(now)).sinceSec) })
    log('flag', line, 'team', undefined, undefined, { subjectId: id })
    emit('atemschutz.notfallEnde', { id })
    remember(id, line, tr, apply)
  }

  /**
   * An escalation crossed into warn/critical — record it once in the Verlauf.
   *
   * ⚠️ ONCE ACROSS THE WHOLE EINSATZ, not once per device (04.09.). Every tablet watching the
   * board runs its own alarm engine, and all of them cross into überfällig within a second or
   * two of each other, so the record grew one «Überfällig» line per open device: the 03.09.
   * Einsatz has Fabich's 06:50 alarm twice, four seconds apart, for a Trupp about which nothing
   * had happened in between. The row is therefore minted under a DETERMINISTIC id built from
   * the Trupp and the Funkkontakt-Turnus the alarm belongs to — the server keeps the first and
   * silently skips every later one with the same id (backend · journal.append_rows), which is
   * the same idempotency an offline outbox retry already relies on. Two genuinely different
   * alarms differ in their turnus, so nothing that deserves its own line loses one.
   *
   * ⚠️ The AUDIT EVENT is keyed the same way (24.09.2026). It was minted per device, so the
   * 23.09. Einsatz holds every `atemschutz.alarm` / `.cleared` three times — one per tablet on
   * the same login — while the rows beside them had long been single. `observed` derives its
   * `client_id` from the row id and the actor (lib/eventScope · observedEventId), and the
   * payload carries nothing device-local, so the copies are byte-identical and the server keeps
   * one. Only `occurred_at` differs between observers, and the server keeps the first.
   */
  const logTruppAlarm = (id: string, status: Trupp['status'], turnus = '') => {
    const tr = trupps.find((t) => t.id === id)
    const rowId = `azal-${id}-${turnus}`
    log('warn', fillTemplate(appConfig.copy.atemschutz.logAlarm, { name: tr ? truppLogName(tr) : '', status: appConfig.copy.atemschutz.status[status] ?? status }), 'team',
      undefined, undefined, { rowId, subjectId: id })
    emit('atemschutz.alarm', { id, status }, { observed: rowId })
  }
  /** …and the line that ends it, naming what ended it. Read off the Trupp's OWN log — the same
   *  readings the printed Druckprotokoll shows — so the row can never claim a Funkkontakt where
   *  the record holds a Druckmeldung. Idempotent the same way, on the same turnus. */
  const logTruppAlarmCleared = (id: string, turnus: string, seen?: Trupp) => {
    // ⚠️ THE TRUPP THE ALARM ENGINE SAW, not this hook's state (F1, 26.09.2026). The engine runs on
    // the Tafel with the reopen's clock restart already laid over it (IncidentWorkspace
    // `alarmTrupps`, derived from the reopen ROW), while the restart is written into `trupps` by
    // an effect of the parent that runs AFTER the child's. A tablet that only heard the reopen
    // therefore ended the alarm off the pre-restart state and wrote «– Funkkontakt» where the
    // reopening tablet wrote «– Kontaktuhr neu gestartet» — and the server keeps whichever copy
    // of the derived row id comes first. Reading the evaluated Trupp makes the reason a function
    // of the same facts (the Trupp's readings + the reopen row) on every device.
    const tr = seen ?? trupps.find((t) => t.id === id)
    const az = appConfig.copy.atemschutz
    // the last MEASURED or lifecycle row — a crew row says nothing about how the alarm ended
    const last = tr?.readings?.filter((r) => r.kind !== 'crew').slice(-1)[0]?.kind
    // ⚠️ …unless the clock was RESTARTED by «Wieder öffnen» (D5, 25.09.2026): then nobody reached
    // the crew, and the last reading's «Funkkontakt» would put a radio call on paper that never
    // happened. The restart says what it was.
    const restarted = !!tr?.contactRestartedAt && tr.contactRestartedAt === tr.lastContactTime
    // ⚠️ …and only the alarm that was STILL RUNNING at the reopen is ended by it (N4, 26.09.2026).
    // The alarm is keyed on the contact it ran from (`turnus`); if a later contact had come in
    // before the reopen — a Kontakt delivered late from an offline phone — THAT contact ended the
    // alarm, and its own Verlauf row (at its own time) is the record of it. A «beendet» row
    // written now would put the end at the moment this device heard the reopen, and blame the
    // wrong cause: nothing is written.
    if (restarted && tr!.contactBeforeRestart != null && tr!.contactBeforeRestart !== turnus) return
    const reason = restarted ? az.alarmClearedByReopen : (last && az.alarmClearedBy[last]) || az.alarmClearedOther
    const rowId = `azcl-${id}-${turnus}`
    log('radio', fillTemplate(az.logAlarmCleared, { name: tr ? truppLogName(tr) : '', reason }), 'team',
      undefined, undefined, { rowId, subjectId: id })
    emit('atemschutz.alarm.cleared', { id }, { observed: rowId })
  }

  return { recordContact, recordPressure, setTruppStatus, truppPlace, triggerNotfall, endNotfall, logTruppAlarm, logTruppAlarmCleared }
}
