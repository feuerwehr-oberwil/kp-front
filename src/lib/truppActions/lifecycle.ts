import type { Trupp, TruppFields } from '../../types'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../format'
import { toast, undoToast } from '../ui'
import { truppEquipmentLabels } from '../report'
import { isAtemschutzTrupp, truppCrewWithout, truppInNotfall, truppLogName, truppTransferState } from '../atemschutz'
// stamped in the DEPLOYMENT's time, like every Trupp timestamp (why: truppActions/clock)
import { serverNowIso } from '../serverClock'
import { nextTruppNo } from '../placedTrupps'
import { keepCrewFiled } from '../crewFiling'
import { recordKey } from '../undoKeys'
import { auftragText, crewRow, hasEntryPressure, isOutTrupp, withDetails, type TruppActionCore, type TruppActionDeps } from './core'
import { correctEntryPressure } from './clock'
import type { TruppColorActions } from './colors'
import type { TruppLineActions } from './lines'
import type { TruppPlacementActions } from './placement'

// The Trupp LIFECYCLE family — a Trupp's record from Anmeldung to Löschen: register, edit,
// re-deploy, crew transfer, the hand-set board order, remove / restore — and the pure wording
// of what an edit changed (truppEditChanges). Composed by lib/useTruppActions.

/**
 * ── The hand-set board order, in ONE key space ──
 *
 * `Trupp.order` is synced but optional (older/imported incidents carry none), so the board's
 * comparator falls back to the Trupp's position in the LIVE list — and every writer has to use
 * that same fallback or the two scales talk past each other. They used to: `createTrupp` handed
 * out `max(order ?? 0) + 1`, which on a board of N unordered Trupps is 1, so the new card tied
 * with the SECOND one and landed in the middle of a board somebody had arranged.
 *
 * `truppOrderKey` is that one key: the stored `order`, else the position. Exported and pure so
 * `AtemschutzView`'s comparator, `createTrupp` and `moveTrupp` provably agree.
 */
export const truppOrderKey = (t: Trupp, i: number): number => t.order ?? i

/** The board as it reads when arranged by hand: by key, ties broken by position — so the order
 *  is total even on a legacy board where several Trupps share a key. Carries each Trupp's key
 *  along, because that is what a move has to compute against. */
export function handOrder<T extends Trupp>(ts: T[]): { t: T; key: number; i: number }[] {
  return ts.map((t, i) => ({ t, key: truppOrderKey(t, i), i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
}

/** Where a newly registered Trupp goes: past every key on the board, so it sorts LAST in any mix
 *  of ordered, unordered and soft-deleted Trupps. Removed ones count too — one of them can come
 *  back (restoreTrupp), and it must not come back on top of the new card's number. */
export function nextTruppOrder(ts: Trupp[]): number {
  return ts.reduce((n, t, i) => Math.max(n, truppOrderKey(t, i)), -1) + 1
}

/**
 * Where a card lands when it is moved one slot: BETWEEN the neighbour it jumps over and whatever
 * lies past that one. Returns the new key for the moved Trupp, or `null` when it is already at
 * that end of the board.
 *
 * A midpoint rather than a swap of two `order` values, for two reasons: it writes ONE object
 * (a concurrent move on another device then merges per object without a second card following
 * along), and it cannot land on a number another card already carries — the old swap took its
 * values from subset indices and collided with real `order`s, and a tie falls back to array
 * order, i.e. the card visibly did not move. Where the two neighbouring keys are already tied
 * (legacy data) there is no gap to aim at, so the card steps past the whole tied group instead:
 * further than asked, but never a dead button.
 */
export function nextMoveOrder(ordered: { key: number }[], i: number, dir: -1 | 1): number | null {
  const j = i + dir
  if (i < 0 || j < 0 || j >= ordered.length) return null
  const nb = ordered[j].key
  const beyond = ordered[j + dir]?.key
  const mid = beyond === undefined ? nb + dir : (nb + beyond) / 2
  // strictly past the neighbour, or the move is invisible — also catches the float running out
  // of room after very many moves
  return (dir < 0 ? mid < nb : mid > nb) ? mid : nb + dir
}

/**
 * What a Trupp edit actually CHANGED, as the words the Verlauf prints.
 *
 * Exported and pure so the wording is testable: the line it feeds used to be «Auftrag angepasst»
 * for every field the form touches, which made removing an AdF and renaming the Gruppenführer
 * indistinguishable from each other AND from nothing at all. The crew line names the person, not
 * just «Mannschaft» — «wer war im Trupp» is the question asked afterwards.
 */
export function truppEditChanges(
  prev: Trupp | undefined,
  f: TruppFields,
  /** ⚠️ Both flags are for the RE-DEPLOY path (see reactivateTrupp), and both are about the same
   *  thing: «Wieder einrücken» does not CHANGE a running deployment, it composes the next one.
   *  · `pressure: false` — a fresh cylinder is what a re-deployment IS, and the re-entry row
   *    already names it; reporting it again as «Eingangsdruck 60 → 300 bar» reads as a correction
   *    of the Einsatz that is over.
   *  · `crew: false` — the crew is not «changed» either, it is who goes in this time, and the
   *    re-entry row names all of them. Diffed, the row claimed people had been «aus dem Trupp
   *    genommen» who had finished their deployment an hour earlier (04.09., Manuel's Rapport). */
  opts?: { pressure?: boolean; crew?: boolean },
): string[] {
  if (!prev) return []
  const az = appConfig.copy.atemschutz
  const out: string[] = []
  const members = (xs?: string[]) => (xs ?? []).map((x) => x.trim()).filter(Boolean)
  const crew = opts?.crew !== false
  if (crew && prev.name.trim() !== f.name.trim()) out.push(fillTemplate(az.changeLeader, { from: prev.name, to: f.name }))
  // ⚠️ Who was IN the Trupp — leader included — not «the AdF list». The two are one crew, and the
  // form moves people between the slots: promoting an AdF to Gruppenführer and standing the old
  // one down beside him is ONE change, and diffing the AdF list on its own reported it as three —
  // «Gruppenführer A → B, B aus dem Trupp genommen, A dazugekommen», i.e. the record claiming a
  // crew member left and another joined when nobody did either. Compared as a set of names, a
  // pure role swap leaves both sides equal and only the leader line survives.
  const before = [prev.name, ...(prev.members ?? [])].map((x) => x.trim()).filter(Boolean)
  const after = [f.name, ...(f.members ?? [])].map((x) => x.trim()).filter(Boolean)
  const gone = crew ? members(prev.members).filter((x) => !after.includes(x)) : []
  const added = crew ? members(f.members).filter((x) => !before.includes(x)) : []
  if (gone.length) out.push(fillTemplate(az.changeMemberOut, { names: gone.join(', ') }))
  if (added.length) out.push(fillTemplate(az.changeMemberIn, { names: added.join(', ') }))
  // …and who is in the Trupp NOW, so the crew does not have to be reassembled from a registration
  // row and two half-sentences. Only when the composition moved: a pure change of Gruppenführer
  // is the same people (copy · atemschutz.changeCrewNow).
  if (gone.length || added.length) out.push(fillTemplate(az.changeCrewNow, { crew: truppLogName(f) }))
  if (prev.auftrag !== f.auftrag || (prev.ziel ?? '') !== (f.ziel ?? '')) {
    let to = auftragText(f.auftrag, f.ziel)
    // A row that renders IDENTICALLY to what stood before records nothing — the one way that
    // happens is the Art flipping to «anderes» over an unchanged Ziel (Feldtest 08.09.: the Art
    // was set later and its row read like a repeat of the Ziel, so the change was unfindable in
    // the Verlauf). Only then does «Anderes» earn its place in front of the free text.
    if (f.auftrag === 'anderes' && to === auftragText(prev.auftrag, prev.ziel)) {
      to = [az.auftragLabels['anderes'], (f.ziel ?? '').trim()].filter(Boolean).join(' – ')
    }
    out.push(to ? fillTemplate(az.changeAuftragTo, { auftrag: to }) : az.changeAuftragCleared)
  }
  if ((prev.lineNo ?? null) !== (f.lineNo ?? null)) {
    out.push(f.lineNo == null ? az.changeLineCleared : fillTemplate(az.changeLine, { n: String(f.lineNo) }))
  }
  // both numbers, for the same reason the Eingangsdruck names both — «Funkkanal 12» left a reader
  // unable to tell a new channel from a corrected one from a confirmation (04.09., Manuel)
  if ((prev.funkkanal ?? null) !== (f.funkkanal ?? null)) {
    out.push(f.funkkanal == null ? az.changeFunkkanalCleared
      : prev.funkkanal == null ? fillTemplate(az.changeFunkkanalSet, { n: String(f.funkkanal) })
        : fillTemplate(az.changeFunkkanal, { from: String(prev.funkkanal), to: String(f.funkkanal) }))
  }
  if (f.color !== undefined && (prev.color ?? null) !== (f.color ?? null)) out.push(az.changeColor)
  // the Ausrüstung as the list it is now — or «keine» once the last item is taken off — in the
  // same words setTruppEquipment writes, so the form and the card tell one story
  if ((prev.equipment ?? []).join('\u0000') !== (f.equipment ?? []).join('\u0000')) {
    const labels = truppEquipmentLabels(f.equipment)
    out.push(labels.length ? fillTemplate(az.changeEquipment, { list: labels.join(', ') }) : az.changeEquipmentNone)
  }
  // ⚠️ FIRST among the changes, not somewhere in the middle of the sentence: it is the only one
  // here that turns a safety watch on or off, and the Verlauf is where somebody reads back what
  // was being monitored when. The form answers this field from the Trupp's own record wherever
  // the chooser is not shown (the handed-over Tafel), so it can only differ when somebody
  // actually pressed one of the two tiles — but an ABSENT kind would compare as «Atemschutz» and
  // report a downgrade on every plain Trupp, hence the explicit guard.
  const kindTurned = f.kind !== undefined && (f.kind === 'atemschutz') !== isAtemschutzTrupp(prev)
  if (kindTurned) out.unshift(f.kind === 'atemschutz' ? az.changeKindPa : az.changeKindPlain)
  /* The Eingangsdruck, in the words the change deserves (04.09., Feldtest Manuel):
   * · the Art turned to PLAIN ⇒ nothing at all. There is no cylinder any more, so the form sends
   *   0 — and «Eingangsdruck 300 → 0 bar» read as a measured drop to nothing on a safety record.
   *   «nicht mehr unter Atemschutz» stands in the same row and says what actually happened; every
   *   measurement taken stays in the Druckprotokoll.
   * · the Art turned to ATEMSCHUTZ ⇒ the new value alone. The cylinder was opened just now, so
   *   there is no «from» to name; a «0 → 300» would invent a rise inside a bottle.
   * · otherwise ⇒ both numbers, because everything derived from the old one (Verbrauch, tiefster
   *   Druck) was computed against it, and «Eingangsdruck geändert» would not let anybody redo
   *   that arithmetic. */
  if (opts?.pressure !== false && f.pressure !== prev.entryPressureBar) {
    if (kindTurned && f.kind === 'atemschutz') out.push(fillTemplate(az.changePressureSet, { n: String(f.pressure) }))
    else if (!kindTurned) out.push(fillTemplate(az.changePressure, { from: String(prev.entryPressureBar), to: String(f.pressure) }))
  }
  return out
}

/**
 * The deployment a row ESTABLISHES, as one clause: «Löschen – Dach via Schiebeleiter · Ltg. 1 ·
 * Kanal 11» (09.09., Feldentscheid).
 *
 * It rides on the three rows that OPEN a deployment — Anmeldung, Bereitstellung, erneuter
 * Eintritt — which until now named only the crew and the Eingangsdruck, so the Verlauf could not
 * be read back into an Einsatz without the Tafel beside it. The lean lifecycle rows (Eintritt,
 * Austritt, Rückzug, Kontakt) stay lean: the same clause on every one of them is wallpaper, and
 * what CHANGES has its own sentence already (truppEditChanges).
 *
 * Nothing is invented — an absent field simply does not print, and there is no «Ltg. –».
 *
 * `noAs` is the caller's answer to «does my template already say it»: `logReenterNoAs` and
 * `logEntryNoAs` carry «ohne Atemschutz» themselves, `logRegisterPlain` and `logStandby` do not.
 * It LEADS the clause, for the reason truppEditChanges puts the Art first — it is the only part
 * that says whether anybody is being watched.
 */
export function truppDeploymentDetails(
  f: Pick<TruppFields, 'auftrag' | 'ziel' | 'lineNo' | 'funkkanal'>,
  opts?: { noAs?: boolean },
): string {
  const az = appConfig.copy.atemschutz
  return [
    opts?.noAs ? az.logDetailNoAs : '',
    auftragText(f.auftrag, f.ziel),
    f.lineNo != null ? fillTemplate(az.logDetailLine, { n: String(f.lineNo) }) : '',
    f.funkkanal != null ? fillTemplate(az.logDetailFunk, { n: String(f.funkkanal) }) : '',
  ].filter(Boolean).join(' · ')
}

type LifecycleDeps = Pick<TruppActionDeps, 'trupps' | 'setTrupps' | 'entities' | 'board' | 'log' | 'emit' | 'undoTimeline' | 'liveTrupps' | 'counterNames'>
  & Pick<TruppActionCore, 'remember' | 'logStep' | 'recorded'>
  & Pick<TruppPlacementActions, 'dropPlacements' | 'syncPlacementLabel'>
  & Pick<TruppColorActions, 'recolorPlacement'>
  & Pick<TruppLineActions, 'clearLineAnchor'>

export function truppLifecycleActions(deps: LifecycleDeps) {
  const { trupps, setTrupps, entities, board, log, emit, undoTimeline, liveTrupps, counterNames, remember, logStep, recorded, dropPlacements, syncPlacementLabel, recolorPlacement, clearLineAnchor } = deps

  // Registering a Trupp does NOT place a marker — Atemschutz teams belong on the building
  // plan, not the Lage map. The EL places one manually later via "Platzieren" (placeTruppOnPlan),
  // which drops a resource chip on the Gebäude floor-stack (or Modul 6) keyed by Trupp.annoId.
  /** every name a placed chip or marker carries — the unlinked «Trupp N» ones feed the counter */
  const placedNames = (): (string | undefined)[] => [
    ...entities.filter((e) => e.kind === 'team').map((e) => e.label),
    ...Object.values(board).flat().filter((a) => a.kind === 'resource').map((a) => a.text),
  ]

  const createTrupp = (t0: Trupp) => {
    // Its number — from the one counter per Einsatz (docs/trupp-naming.md §1): every Trupp ever
    // registered, removed ones included (a number is never reused), and every unlinked chip.
    const at = serverNowIso()
    const t: Trupp = { ...t0, no: t0.no ?? nextTruppNo(liveTrupps?.() ?? trupps, counterNames?.() ?? placedNames()) }
    // The Eingangsdruck IS a measurement, taken at the Tafel before anybody goes anywhere — so it
    // opens the Druckverlauf rather than sitting outside it. It used to be recorded only in
    // `entryPressureBar`, and the log started at «Eingerückt»: a Sicherungstrupp that was never
    // sent in therefore printed «Kein Druckverlauf erfasst» on the Rapport under a Trupp whose
    // cylinder the Überwacher had read and typed in (08.08. Einsatz).
    // ⚠️ …and ONLY for a Trupp under PA. A plain work squad has no cylinder, so the row would open
    // its Druckverlauf with a «0 bar» reading nobody took — a measurement invented by the app on a
    // legal record. Its lifecycle rows (Eingerückt / Draussen) still append as usual.
    // …and the crew that was registered, as the first `crew` row (see crewRow).
    const registered: Trupp['readings'] = [
      ...(t.readings?.length ? t.readings
        : isAtemschutzTrupp(t) ? [{ t: at, bar: t.entryPressureBar, kind: 'registered' as const }] : []),
      crewRow(t, at),
    ]
    // a new card joins at the END of the hand-set order, never in the middle of a board somebody
    // arranged — `order` is synced, so it lands the same way on every device. The key comes from
    // nextTruppOrder, which reads the board in the SAME space the comparator sorts in (see there).
    setTrupps((ts) => [...ts, { ...t, readings: registered, order: t.order ?? nextTruppOrder(ts) }])
    // with the Eingangsdruck: it is the number the whole pressure trend is measured from, and
    // the Verlauf used to start the story without it — but only where there IS one to name
    // (see `hasEntryPressure`). Who LEADS the crew is not written into this sentence: it is the
    // Gruppenführer's Anwesenheits-Funktion, and the Verlauf prints that behind his name on its
    // own (lib/roleAssignment · truppRoleNote, lib/journalLinks · linkRanges).
    // …and WHAT this Trupp was registered FOR (09.09.): Auftrag/Ziel, Leitung, Kanal, and — since
    // neither register template says it — «ohne Atemschutz» where there is no cylinder. The
    // Anmeldung is one of the three rows that establish a deployment (truppDeploymentDetails).
    const az = appConfig.copy.atemschutz
    const line = withDetails(
      fillTemplate(
        hasEntryPressure(t, t.entryPressureBar) ? az.logRegister : az.logRegisterPlain,
        { name: truppLogName(t), bar: String(t.entryPressureBar) },
      ),
      truppDeploymentDetails(t, { noAs: !isAtemschutzTrupp(t) }),
    )
    log('flag', line, 'team', undefined, undefined, { subjectId: t.id })
    emit('atemschutz.register', { id: t.id })
    // ⚠️ Taking an Anmeldung back STAMPS `removedAt` — it does not splice the card out of the
    // array. Same doctrine as Löschen (17.08.): every Trupp ever registered prints on the
    // Atemschutz page, marked «vom Board entfernt». A Trupp registered on the wrong card at 3am
    // is still a thing that was written down, and the record says so.
    // The redo un-stamps it again, which is why `apply` is not the registration itself.
    // `removedAt` is the moment of the UNDO – read when it runs, not when the Trupp was registered.
    if (undoTimeline) {
      const present = () => (liveTrupps?.() ?? trupps).some((x) => x.id === t.id)
      const stamp = (v: string | undefined) => {
        if (!present()) return false
        setTrupps((ts) => ts.map((x) => (x.id === t.id ? { ...x, removedAt: v } : x)))
        return true
      }
      const step = (dir: 'undo' | 'redo', v: string | undefined): boolean => {
        if (!stamp(v)) return false
        logStep(dir, line, t.id)
        return true
      }
      undoTimeline.push({ domain: 'trupps', label: line, touches: () => [recordKey('trupps', t.id)], undo: () => step('undo', serverNowIso()), redo: () => step('redo', undefined) })
    }
  }

  /** Move a card one slot in the hand-set order. Re-keys the ONE card that moved (nextMoveOrder
   *  slots it between its neighbour and the next one along), so a concurrent edit on another
   *  device touches nothing this move wrote. Not logged: where a card sits is a way of looking at
   *  the board, not something that happened at the Einsatz — and the Verlauf is thin enough to
   *  keep for what did. */
  const moveTrupp = (id: string, dir: -1 | 1) => setTrupps((ts) => {
    // ⚠️ over the VISIBLE Trupps only. A soft-deleted one (types · Trupp.removedAt) still sits in
    // the array, so «nach oben» swapped places with a card nobody can see: the board did not move,
    // and the second tap was the one that appeared to work. At 3am that reads as a dead button.
    // ⚠️ …and only within the moved Trupp's OWN section (03.09.). The board draws Atemschutz and
    // «Weitere Trupps» apart (AtemschutzView), so a card whose neighbour in the global key space
    // sits in the other section jumped over something invisible — the same dead button in a new
    // costume. One key space, two sections: a move steps to the next card of the same kind.
    const self = ts.find((t) => t.id === id)
    if (!self) return ts
    const ordered = handOrder(ts.filter((t) =>
      !t.removedAt && isAtemschutzTrupp(t) === isAtemschutzTrupp(self)))
    const next = nextMoveOrder(ordered, ordered.findIndex((e) => e.t.id === id), dir)
    if (next === null) return ts
    return ts.map((t) => (t.id === id ? { ...t, order: next } : t))
  })

  /** The form's colour as a Trupp patch. `null` = «zurück auf automatisch» (drop the field),
   *  `undefined` = the form didn't carry one, so leave whatever the Trupp has. */
  const colorPatch = (f: TruppFields): Partial<Trupp> =>
    (f.color === undefined ? {} : { color: f.color ?? undefined })

  // edit a Trupp's Auftrag / team mid-incident (job changed, moved floor, crew swapped). Never
  // touches the live CLOCK. Keeps the plan chip label in sync.
  //
  // The Eingangsdruck IS editable here (2026-08-10) — it is the number the Verbrauch and the
  // «tiefster Druck» on the Rapport are measured against, and a 200 typed for 300 at der Anmeldung
  // previously had no correction path at all short of deleting the Trupp. What the correction
  // does and deliberately does not do is written at `correctEntryPressure`, which the card's own
  // Druck shares in the first minutes after the Eintritt (recordPressure).
  const editTrupp = (id: string, f: TruppFields) => {
    const tr = trupps.find((t) => t.id === id)
    const bar = f.pressure
    const pressurePatch = (t: Trupp): Partial<Trupp> => correctEntryPressure(t, bar)
    /**
     * The Art of a Trupp, changed after the fact — a work squad that ends up going in under PA,
     * or one registered under Atemschutz by mistake (04.09.). It is the one field here that
     * changes what the app WATCHES, so it writes more than itself:
     *
     * · Hochstufen starts the Überwachung NOW. The contact clock is stamped at this moment, not
     *   at the Eintritt — a crew that has been inside for forty minutes would otherwise be
     *   überfällig in the same second, with the tone going off over a Trupp nobody had failed to
     *   reach. The log gets a `paOn` row carrying the Eingangsdruck: the cylinder was opened now,
     *   and that is what «tiefster Druck» is measured from. `entryTime` is NOT touched — the
     *   crew's Einsatzzeit is unbroken by putting a mask on.
     * · Zurückstufen ends it. Everything measured stays on the record (readings, Eingangsdruck,
     *   tiefster Druck): the Atemschutz-Einsatz happened, and the sheet still prints it. What
     *   stops is the watching, and a `paOff` row says when. The confirm in front of this lives in
     *   the form (AtemschutzView · submitForm), where the operator can still change their mind.
     */
    const kindPatch = (t: Trupp): Partial<Trupp> => {
      const nowPa = (f.kind ?? 'atemschutz') === 'atemschutz'
      if (nowPa === isAtemschutzTrupp(t)) return {}
      const at = serverNowIso()
      if (!nowPa) {
        return { kind: 'einfach', readings: [...(t.readings ?? []), { t: at, bar: t.lastPressureBar ?? t.entryPressureBar, kind: 'paOff' }] }
      }
      return {
        kind: 'atemschutz',
        entryPressureBar: bar,
        lowestBar: bar,
        lastContactTime: at,
        readings: [...(t.readings ?? []), { t: at, bar, kind: 'paOn' }],
      }
    }
    // ⚠️ the kind patch comes LAST: on an upgrade it owns `readings`, `entryPressureBar` and
    // `lowestBar` outright, and `pressurePatch` would otherwise have rewritten the old Eintritt
    // row to the new Eingangsdruck — claiming the Trupp went in under PA all along.
    // ⚠️ Built once and kept: the timeline's ↷ re-applies THIS patch rather than re-running the
    // edit, so `kindPatch`'s Hochstuf-Zeitstempel is the one the record already carries.
    const patch = { name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNo: f.lineNo, funkkanal: f.funkkanal, leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds, equipment: f.equipment, ...colorPatch(f), ...(tr ? pressurePatch(tr) : {}), ...(tr ? kindPatch(tr) : {}) }
    // a changed crew is a `crew` row too, on top of whatever readings the two patches above
    // settled on — the Rapport reads the crew off the log, not off the card (see crewRow)
    const crewChanged = !!tr && (f.name !== tr.name || (f.members ?? []).join('\u0000') !== (tr.members ?? []).join('\u0000'))
    const crewAt = serverNowIso() // stamped ONCE, so the timeline's ↷ re-applies the same row
    const withCrew = (t: Trupp): Trupp => {
      const next = { ...t, ...patch }
      return crewChanged ? { ...next, readings: [...(next.readings ?? []), crewRow(next, crewAt)] } : next
    }
    setTrupps((ts) => ts.map((t) => (t.id === id ? withCrew(t) : t)))
    // Clearing (or changing) the Leitung number in the form IS how a Trupp lets go of a hose —
    // that is where the operator already is when they change their mind, so the card needs no
    // «lösen» icon. The anchor goes with it, or the tag would survive its own number.
    if (tr && f.lineNo !== tr.lineNo && tr.lineId) clearLineAnchor(id)
    if (tr && f.name !== tr.name) syncPlacementLabel(tr, f.name)
    // colour follows the Trupp, so a repaint (or a new Auftrag under a station colour rule) has
    // to reach the already-placed marker/chip too — otherwise board and map disagree
    if (tr) recolorPlacement({ ...tr, color: f.color === null ? undefined : f.color ?? tr.color, auftrag: f.auftrag })
    // «Trupp X: Auftrag angepasst» covered every field the form touches and named none of them —
    // so removing an AdF, swapping the Gruppenführer or changing the Funkkanal all read as the
    // same nothing, and a Trupp whose Auftrag was untouched said the opposite of what happened.
    // The line now lists what actually changed (same shape as the Sicherheitswerte line).
    /* ⚠️ NOTHING changed ⇒ NO row (04.09., Manuel's Rapport: «Trupp Brunner Thomas: bearbeitet»
     * at 16:20). The fallback line was written whenever the form was saved without touching a
     * tracked field — opening «Bearbeiten» to look at something and pressing Speichern, or moving
     * an AdF within the crew — and it named nothing at all. A Verlauf row that says a change was
     * made without saying what is worse than no row: the reader has to go looking for a change
     * that is not there. What DID change always has its own words (truppEditChanges). The audit
     * event still fires: that stream records the action, not the sentence. */
    const changes = truppEditChanges(tr, f)
    const line = changes.length
      ? fillTemplate(appConfig.copy.atemschutz.logEditFields, { name: truppLogName({ no: tr?.no, name: f.name, members: f.members }), changes: changes.join(', ') })
      : null
    if (line) log('pen', line, 'team', undefined, undefined, { subjectId: id })
    emit('atemschutz.edit', { id })
    // ⚠️ Undoable like every other Atemschutz mutation (Kontakt, Druck, raus, löschen) — via the
    // GLOBAL ↶ timeline (the board's confirm toasts went 09.09.). It rewrites the Eingangsdruck
    // that «Verbrauch» and «tiefster Druck» are measured against, and an AdF removed from the
    // crew here is removed from the record. Only the derived state comes back; the Verlauf keeps
    // its line, because the correction did happen.
    // Nothing changed ⇒ no row, and nothing on the timeline either: ↶ must never offer to take
    // back a save that wrote nothing (the operator would watch it do visibly nothing).
    if (line) remember(id, line, tr, withCrew)
  }

  /**
   * What the Trupp takes in (types · Trupp.equipment) — the ids from the station's list
   * (deploymentConfig · atemschutzEquipment), in whatever order the list has them.
   *
   * The form's «Ausrüstung» chips (components/TruppForm) travel as `TruppFields.equipment`
   * through `editTrupp`, so a save that touches the Auftrag AND the Ausrüstung is ONE Verlauf row.
   * This action is for a change made OUTSIDE the form (a card control, once there is one); its
   * row is the same housekeeping shape — «Trupp 1 (Meier Anna): Ausrüstung: Retthaube, WBK» —
   * with «keine» when the last item is taken off, so a reader never meets a bare «Ausrüstung:».
   * Nothing changed ⇒ nothing written, same rule as editTrupp; undoable on the global timeline
   * like every other Trupp edit. Ids are de-duplicated and unknown ones are kept: an id from an
   * older station list is still what was recorded.
   */
  const setTruppEquipment = (id: string, ids: readonly string[]) => {
    const tr = trupps.find((t) => t.id === id)
    if (!tr) return
    const next = [...new Set(ids.map((x) => x.trim()).filter(Boolean))]
    if (next.join('\u0000') === (tr.equipment ?? []).join('\u0000')) return
    const apply = (t: Trupp): Trupp => {
      const { equipment: _drop, ...rest } = t
      return next.length ? { ...rest, equipment: next } : rest
    }
    setTrupps((ts) => ts.map((t) => (t.id === id ? apply(t) : t)))
    const az = appConfig.copy.atemschutz
    const labels = truppEquipmentLabels(next)
    const line = fillTemplate(az.logEditFields, {
      name: truppLogName(tr),
      changes: labels.length ? fillTemplate(az.changeEquipment, { list: labels.join(', ') }) : az.changeEquipmentNone,
    })
    log('pen', line, 'team', undefined, undefined, { subjectId: id })
    emit('atemschutz.edit', { id })
    remember(id, line, tr, apply)
  }

  /**
   * Take one person OUT of the Trupp they are still recorded in, because they are being written
   * into another one — the tap behind «bereits in einem anderen Trupp» (components/TruppForm).
   *
   * The warning used to be a dead end: it named the obstacle, and clearing it meant throwing this
   * form away, finding the other card, editing it and starting over. This is that round trip, as
   * one tap on the sentence that complains.
   *
   * ⚠️ ONE Verlauf row, on the Trupp GIVING the person up, and it says where they went. The
   * receiving Trupp writes its own row anyway — its Anmeldung or its Bearbeitungszeile names the
   * whole new crew — so a second «dazugekommen» here would be the same fact twice, with a gap in
   * between in which the person was in no Trupp at all.
   *
   * ⚠️ NEVER out of a crew that is still deployed (lib/atemschutz · truppTransferState): its
   * Kontaktuhr is running and the Atemschutzüberwachung is watching exactly these people. The
   * caller hides the action in that state; this refuses it as well, because a guard that lives
   * only in the view is a guard a second call site can walk past.
   *
   * ⚠️ Crew fields ONLY — plus the `crew` row that records them (docs/trupp-naming.md §3).
   * Nothing here touches `status`, `entryTime`, `lastContactTime`, `exitTime` or any measured
   * reading — the safety clocks of the other Trupp keep running exactly as they were, which is
   * the invariant that lets this be a one-tap action at all.
   */
  const transferOutOfTrupp = (fromId: string, personId: string, toName?: string): boolean => {
    const tr = trupps.find((t) => t.id === fromId)
    if (!tr || truppTransferState(tr, personId) !== 'ready') return false
    const crew = truppCrewWithout(tr, personId)!
    // whose NAME is being moved — the slots are index-aligned, leader first (lib/personnel · truppSlots)
    const slotAt = [tr.leaderPersonId, ...(tr.memberPersonIds ?? [])].indexOf(personId)
    const who = ([tr.name, ...(tr.members ?? [])][slotAt] ?? '').trim()
    const patch: Partial<Trupp> = {
      name: crew.name, members: crew.members,
      leaderPersonId: crew.leaderPersonId, memberPersonIds: crew.memberPersonIds,
    }
    // ⚠️ …plus a `crew` row, which is the one thing here that touches `readings`: it records
    // WHO the Trupp is from now on, so the Rapport can say when this person left (see crewRow).
    const at = serverNowIso()
    const apply = (t: Trupp): Trupp => { const n = { ...t, ...patch }; return { ...n, readings: [...(n.readings ?? []), crewRow(n, at)] } }
    setTrupps((ts) => ts.map((t) => (t.id === fromId ? apply(t) : t)))
    // the Trupp's NAME is its Gruppenführer's (types · Trupp.name), so handing the leader over
    // renames it — and the chip/marker that carries that name has to follow, exactly as in editTrupp
    if (crew.name !== tr.name) syncPlacementLabel(tr, crew.name)
    const az = appConfig.copy.atemschutz
    const to = (toName ?? '').trim()
    // …and «in Trupp Frei Nina gewechselt» on the row about Frei Nina is not an answer: that is
    // the case where the transferred person IS the new Trupp's Gruppenführer (copy · logMovedOutPlain)
    const line = fillTemplate(to && to !== who ? az.logMovedOut : az.logMovedOutPlain,
      { name: truppLogName(tr, 'leader'), person: who, to })
    log('pen', line, 'team', undefined, undefined, { subjectId: fromId })
    // the same op_type the form's own save emits: this IS a crew edit of that Trupp, and a link
    // session may send `atemschutz.*` and nothing else (backend · auth/incident_link.py)
    emit('atemschutz.edit', { id: fromId })
    remember(fromId, line, tr, apply)
    return true
  }

  // re-deploy an exited Trupp (refilled bottle, going back inside): a fresh start — new pressure +
  // reset clocks/log — while letting the EL adjust the Auftrag/team on the way back in.
  //
  // `standby` decides WHERE the fresh start lands. A re-equipped Trupp is very often held back as
  // Sicherungstrupp rather than sent straight in, and forcing it to 'aktiv' started a contact
  // clock on a crew standing at the vehicle — a clock that goes überfällig on somebody who is
  // not under PA. Standby mirrors the create path exactly (angemeldet, no entryTime, empty log),
  // so the later «Eingerückt» stamps the entry the same way it does for a brand-new Trupp.
  const reactivateTrupp = (id: string, f: TruppFields, standby = false) => {
    const tr = trupps.find((t) => t.id === id)
    /* ⚠️ Only ONTO a Trupp that is out — the same guard `setTruppStatus` carries, for the same
     * reason (04.09., Feldtest: «erneuter Eintritt 2×»). «Wieder einrücken» is offered on a
     * `raus` card alone, so a second run of it can only be a second tap or a second device on a
     * card the merge has already moved on — and this one does not merely repeat a row: it resets
     * the contact clock, the Eingangsdruck and the whole running deployment. */
    if (tr && !isOutTrupp(tr)) return
    if (recorded.get(id) === 'redeploy') return // the same tap twice in one frame (see `recorded`)
    recorded.set(id, 'redeploy')
    const now = serverNowIso()
    /**
     * The ART of the deployment that is starting now (04.09., Feldtest: «Bei Wieder einrücken (AS)
     * habe ich keine Auswahl ob mit oder ohne AS»).
     *
     * The crew that fought the fire under PA goes back in to clear up without it, and the
     * Verkehrstrupp that has finished puts masks on for the cellar — so the form asks again, and
     * this is where the answer lands. Only when it CHANGED: `kind` is absent on every Trupp
     * recorded as «unter Atemschutz» (types · TruppKind), and stamping the default onto a card
     * that was not re-answered would make the record claim a decision nobody made.
     *
     * ⚠️ No `paOn`/`paOff` row, unlike the correction in `editTrupp`. Those two mark where the
     * watched stretch begins or ends INSIDE a running deployment. Here the boundary is the entry
     * row appended below: the previous Atemschutz-Einsatz already ended at its Austritt, and a
     * «Atemschutz beendet» stamped at the moment the crew goes back in would put the end of the
     * old watch after the start of the new deployment.
     */
    const nowPa = (f.kind ?? (tr ? (isAtemschutzTrupp(tr) ? 'atemschutz' : 'einfach') : 'atemschutz')) === 'atemschutz'
    const kindPatch: Partial<Trupp> = !tr || nowPa === isAtemschutzTrupp(tr) ? {}
      : { kind: nowPa ? 'atemschutz' : 'einfach' }
    const apply = (t: Trupp): Trupp => (
      { ...t, name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNo: f.lineNo, funkkanal: f.funkkanal,
          leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds, equipment: f.equipment, ...colorPatch(f), ...kindPatch,
          status: standby ? 'angemeldet' : 'aktiv',
          entryTime: standby ? '' : now, lastContactTime: standby ? '' : now, exitTime: undefined,
          entryPressureBar: f.pressure, lastPressureBar: undefined, lastPressureTime: undefined, lowestBar: f.pressure,
          // ⚠️ APPENDED, not replaced (17.08.). This used to start a new `readings` array, which
          // threw away the first deployment's entry pressure and every reading taken during it —
          // and `backend/app/report` prints exactly this array, so the crew that had been
          // under PA the longest was the half missing from the safety document. The card's own
          // numbers (entryPressureBar, lowestBar) still describe the RUNNING deployment; what is
          // «current» in the log is everything from here on (lib/atemschutz · currentRunStart).
          // standby is the create path exactly: the fresh cylinder was read, so the run opens with
          // that reading rather than empty (see createTrupp)
          // ⚠️ …and the row is appended for a Trupp WITHOUT Atemschutz as well, carrying bar 0.
          // It is not a measurement — it is WHEN this crew went back in, and the printed
          // Detailprotokoll reads its Eintritt/Austritt spans off exactly these rows (report ·
          // truppRunTimes), so a plain re-deployment would otherwise leave the sheet showing the
          // first cycle and not the second. The Druck column stays empty on its own: only a
          // measured, positive value prints (report · readingBarShown).
          // …and the crew going back in, as its own row (crewRow): the re-entry is a new cycle,
          // and the Rapport reads each cycle's crew off the log
          // `measured` when the form's Eingangsdruck was set on purpose (a bottle answer, a
          // dialled value) — the first Druckmeldung then never «corrects» it (entryPressureConfirmed)
          readings: [...(t.readings ?? []), { t: now, bar: f.pressure, kind: standby ? 'registered' : 'entry',
            ...(f.pressureMeasured && nowPa ? { measured: true as const } : {}) },
            crewRow({ name: f.name, members: f.members, entryPressureBar: f.pressure }, now)] })
    setTrupps((ts) => ts.map((t) => (t.id === id ? apply(t) : t)))
    if (tr && f.lineNo !== tr.lineNo && tr.lineId) clearLineAnchor(id)
    if (tr && f.name !== tr.name) syncPlacementLabel(tr, f.name)
    if (tr) recolorPlacement({ ...tr, color: f.color === null ? undefined : f.color ?? tr.color, auftrag: f.auftrag })
    const az = appConfig.copy.atemschutz
    // ⚠️ Against the NEW Art, not the card's old one: a Trupp going back in without Atemschutz has
    // no cylinder to name — and SAYS so, like every other Eintritt row does now. One going in
    // under it has a fresh cylinder. `logStandby` carries no number at all.
    // ⚠️ …and «ohne Atemschutz» is not the same statement as «no pressure recorded»: an
    // Atemschutz-Trupp whose gauge was not read keeps `logReenterPlain`, which drops the number
    // and claims nothing about masks.
    const reenterTpl = !nowPa ? az.logReenterNoAs
      : hasEntryPressure({ kind: 'atemschutz' }, f.pressure) ? az.logReenter : az.logReenterPlain
    // …with the deployment it opens (09.09.): the re-entry/Bereitstellung row is a new Einsatz for
    // this crew, so it names Auftrag, Leitung and Kanal the way the Anmeldung does. ⚠️ «ohne
    // Atemschutz» ONLY where the template did not already say it — `logReenterNoAs` does, so it is
    // the standby row of a Trupp without Atemschutz that needs it (`logStandby` says nothing about
    // masks). The «was hat sich geändert» row below stays separate: this clause is the state, that
    // one is the diff.
    const reenterLine = withDetails(
      fillTemplate(standby ? az.logStandby : reenterTpl, { name: truppLogName({ ...f, no: tr?.no }), bar: String(f.pressure ?? '') }),
      truppDeploymentDetails(f, { noAs: !nowPa && standby }),
    )
    log('flag', reenterLine, 'team', undefined, undefined, { subjectId: id })
    // ⚠️ «Wieder einrücken» never had a way back at all — it is the one Trupp action that resets
    // the safety clock, the Eingangsdruck AND lowestBar in one go, and a mis-tap on the card above
    // rewrote the running deployment of a crew that was already inside. It has one now, and it
    // arrives through the header rather than a new toast: the re-deploy form is a deliberate act
    // with a Speichern, not a per-tap confirmation that wants six seconds of pill over the board.
    remember(id, reenterLine, tr, apply)
    /* …and WHAT WAS CHANGED on the way back in (04.09., Feldtest: «Funkkanal wird gar nicht
     * protokolliert»). The re-deploy form is the full Trupp form — Art, Auftrag, Ziel, Funkkanal,
     * Leitung, Mannschaft — and every one of those edits used to vanish behind the re-entry row:
     * the Trupp went back in on channel 7 and the record still said 5. Same sentence the ⋯
     * «Bearbeiten» writes, so there is one wording for one kind of fact; nothing is written when
     * nothing moved, and the fresh cylinder is not reported as a correction (see
     * truppEditChanges · opts.pressure).
     *
     * ⚠️ The ART rides in this row too, rather than in a re-entry line of its own. A third
     * wording for «jetzt unter Atemschutz» would have to exist beside the two this app already
     * has, and it would buy nothing: this row is written anyway whenever the Auftrag came back
     * changed — which on a re-deployment it almost always did — so the special line would be an
     * EXTRA row in the common case rather than one fewer. `truppEditChanges` puts the Art first
     * in the list, for the reason documented there: it is the only entry that turns a safety
     * watch on or off. */
    const changes = truppEditChanges(tr, f, { pressure: false, crew: false })
    if (changes.length) log('pen', fillTemplate(az.logEditFields, { name: truppLogName({ no: tr?.no, name: f.name, members: f.members }), changes: changes.join(', ') }), 'team', undefined, undefined, { subjectId: id })
    emit('atemschutz.status', { id, status: standby ? 'angemeldet' : 'aktiv' })
  }

  const deleteTrupp = (id: string) => {
    const tr = trupps.find((t) => t.id === id)
    /* ⚠️ Never off the board while in a NOTFALL (review of #300): the removal would take it out of
     * every alarm with no «Notfall beendet» row and no end push — the record would show a Notfall
     * that simply stopped. The way is «Notfall beendet» first; refused here as well as in the
     * view, because a guard that lives only in the view is one a second call site walks past. */
    if (tr && truppInNotfall(tr)) { toast(appConfig.copy.atemschutz.notfall.removeBlocked, { icon: 'warn', tone: 'warn' }); return }
    // ⚠️ STAMPED, not removed (17.08.). The board loses it — that is what was asked for, and the
    // live list is filtered at the source (IncidentWorkspace) so no alarm, marker or roster lock
    // can still see it. But the Atemschutz page of the Rapport is a safety document: a crew that
    // was under PA and then taken off the Tafel used to vanish from the paper too, readings and
    // entry pressure with it. Every Trupp ever registered now prints.
    const at = serverNowIso()
    const apply = (t: Trupp): Trupp => ({ ...t, removedAt: at })
    setTrupps((ts) => ts.map((t) => (t.id === id ? apply(t) : t)))
    if (tr) dropPlacements(tr)
    // A Trupp leaving the Tafel is the one Atemschutz action the Verlauf never recorded: the
    // toast said so and vanished, and the reconstruction afterwards showed a crew that had been
    // under PA simply not existing. Every other lifecycle step has its line; so does this one.
    const line = fillTemplate(appConfig.copy.atemschutz.logRemoved, { name: tr ? truppLogName(tr, 'leader') : '' })
    log('trash', line, 'team', undefined, undefined, { subjectId: id })
    emit('atemschutz.delete', { id })
    // ⚠️ The undo CLEARS `removedAt`; it does not re-create the Trupp. Löschen is a stamp, so the
    // card never left the record and putting it back is un-stamping it — a fresh Trupp would be a
    // second registration of a crew that only ever registered once. The placement refs stay gone
    // (see restoreTrupp): the chip on the plan cannot be resurrected faithfully.
    // ⚠️ Three doors, one act: this ↶ timeline entry, the non-expiring «Entfernte Trupps» menu,
    // and — back since 25.09.2026 (staging N4) — the confirm-with-undo toast docs/undo.md asks of a
    // one-shot that DESTROYS something (the 09.09. sweep took it with the Kontakt/Druck toasts,
    // but a removal is not a Kontakt). The toast's «Rückgängig» restores through `restoreTrupp`
    // and drops this timeline entry, so the act is never undoable twice.
    // ⚠️ …and the placement refs are STRIPPED on the way back, exactly as `restoreTrupp` strips
    // them: `dropPlacements` above took the plan chip and the map marker with it, and they cannot
    // be resurrected faithfully. Restoring the card verbatim would point it at an annotation id
    // that no longer exists — the Trupp comes back and «auf Plan zeigen» leads nowhere. It is
    // re-placed via «Platzieren», which is what the other two doors already leave the operator to.
    const drop = remember(id, line, tr && { ...tr, annoId: undefined, planId: undefined, entityId: undefined }, apply)
    // ⚠️ guarded by the Trupp's record (lib/undoKeys · watchRecords): once a merge changed it, the
    // toast declines instead of restoring the card as it stood before the other device's write
    if (tr) undoToast(fillTemplate(appConfig.copy.atemschutz.removedToast, { name: truppLogName(tr) }), () => { drop(); restoreTrupp(tr) }, [recordKey('trupps', id)])
    return drop
  }

  // undo for deleteTrupp (the delete-now + Rückgängig toast): re-add the captured Trupp with
  // its full monitoring record (readings, times, pressures). The plan chip / map marker was
  // removed with it and can't be resurrected faithfully, so the placement refs are stripped —
  // the restored Trupp is re-placed via «Platzieren». No-op if the id already exists (double tap).
  const restoreTrupp = (t: Trupp) => {
    let restored = false
    setTrupps((ts) => {
      const cur = ts.find((x) => x.id === t.id)
      // it is still in the record (the delete only stamped it) — un-stamp, and put back the
      // captured monitoring state in case anything changed in between
      if (cur) {
        if (!cur.removedAt) return ts // already back — a double tap on «Rückgängig»
        restored = true
        return ts.map((x) => (x.id === t.id ? keepCrewFiled({ ...t, removedAt: undefined, annoId: undefined, planId: undefined, entityId: undefined }, x) : x))
      }
      // …and a Trupp from a workspace written before the stamp existed is genuinely gone: re-add it
      restored = true
      return [...ts, { ...t, removedAt: undefined, annoId: undefined, planId: undefined, entityId: undefined }]
    })
    // the undo gets its own line rather than erasing the delete: the log is a record of what was
    // done, and «gelöscht, dann doch nicht» is what happened
    if (restored) log('undo', fillTemplate(appConfig.copy.atemschutz.logRestored, { name: truppLogName(t, 'leader') }), 'team', undefined, undefined, { subjectId: t.id })
    emit('atemschutz.restore', { id: t.id })
  }

  return { createTrupp, moveTrupp, editTrupp, setTruppEquipment, transferOutOfTrupp, reactivateTrupp, deleteTrupp, restoreTrupp }
}
