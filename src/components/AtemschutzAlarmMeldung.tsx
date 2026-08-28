import { useEffect, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import { deriveTruppLive, truppAlarm } from '../lib/atemschutz'
import { fillTemplate } from '../lib/format'
import { useMeldung } from '../lib/useMeldung'
import type { Trupp } from '../types'

// The Atemschutz alarm's row in the Meldeleiste — the missing half of the loudest thing this
// app does.
//
// Until 23.08. an überfällig Trupp (or one at its Alarmdruck) drove a tone, a wake-lock and an
// OS notification, and on every surface except the Atemschutz board itself the only things on
// screen were a chip in the top bar and a dot on the nav rail. A noise whose cause is not named
// is a noise the operator has to INVESTIGATE — at 3am, in the dark, with the tone still going —
// instead of act on. So the alarm publishes a message like everything else that stays until it
// is handled, and the message says which Trupp and why.
//
// Three decisions, all deliberate:
//  · ONE ROW PER TRUPP, not one «2 Trupps in Alarm». Same argument the Wiedervorlagen made the
//    same day: a collapsed row's button acts on something the row does not name, and here the
//    two Trupps can be in alarm for DIFFERENT reasons — one out of contact, one out of air.
//    One row can only carry one of those words, and either choice is a lie about the other.
//  · NO ✕. A Trupp that is überfällig cannot be waved away with nothing done. «Zum Trupp» is
//    the one dismissal (28.08., field feedback): it acknowledges, silences the device AND takes
//    the row down — the operator is now standing on the very board that shows the alarm in
//    full, and the strip was covering the controls they need next (the mute bell among them).
//    The row returns the moment a NEW emergency starts: the tier clearing and re-crossing, or
//    the reason changing (a Trupp out of contact whose air then also runs out).
//  · Only tier 2 — the tier that sounds. The amber «Kontakt fällig» lead is silent and
//    board-only by doctrine, and a row for it would make the strip nag before anything is wrong.
//    That keeps the invariant this file exists for: tone ⇔ row.

/** One alarming Trupp, reduced to what the row has to say about it. */
export interface AtemschutzAlarmRow {
  id: string
  /** the Trupp's own name — empty for a marker whose name was never typed */
  name: string
  /** the rest of the crew (Trupp.members). The row prints them after the leader when they fit
   *  (28.08. field feedback): at 3am «who exactly is overdue» is the question, and the board is
   *  one tap away, not zero. `.ml-title` ellipsizes, so a narrow screen simply shows less. */
  members?: string[]
  /** WHY it is in alarm. `contact` is fixed by a radio check, `pressure` is not — the wording
   *  has to distinguish them (lib/atemschutz · TruppAlarm). */
  reason: 'contact' | 'pressure'
  /** the pressure it dropped to, and the line it is held to — a `pressure` alarm only */
  bar?: number
  line?: number
}

/**
 * Which Trupps get a row, and what each row is about.
 *
 * ⚠️ The TIER comes from `severities`, i.e. from the very fold that drives the tone
 * (peakAtemschutzAlarm → AtemschutzAlarmHost), never from a second evaluation here. That is what
 * makes «there is a row for every tone» true by construction rather than by two clocks agreeing.
 * The REASON is asked of `truppAlarm`, the one place it is decided, so the row can never name a
 * contact clock for a Trupp whose air is gone.
 */
export function atemschutzAlarmRows(
  trupps: readonly Trupp[],
  severities: Record<string, 1 | 2>,
  now: number,
  intervalMin: number,
  graceSec: number,
  doctrine: { alarmBar?: number; alarmBarRueckzug?: number },
): AtemschutzAlarmRow[] {
  const rows: AtemschutzAlarmRow[] = []
  for (const t of trupps) {
    if (severities[t.id] !== 2) continue
    const live = deriveTruppLive(t, now, intervalMin, graceSec)
    const { reason, line } = truppAlarm(t, live, intervalMin, graceSec, doctrine)
    if (reason === 'pressure') rows.push({ id: t.id, name: t.name, members: t.members, reason, bar: live.currentBar, line: line ?? undefined })
    // …anything else that is loud enough to sound is the contact clock: `truppAlarm` only ever
    // answers `pressure`, `contact` or null, and null cannot happen for a Trupp the fold rated 2.
    else rows.push({ id: t.id, name: t.name, members: t.members, reason: 'contact' })
  }
  return rows
}

/**
 * Publish one Meldeleiste row per Trupp in alarm. Renders nothing itself (the strip paints) —
 * mount it wherever the alarm state lives, beside the other publishers.
 */
export function AtemschutzAlarmMeldungen({ trupps, severities, intervalMin, graceSec, onAcknowledge, onGoToTrupp }: {
  trupps: readonly Trupp[]
  /** per-Trupp tier from the alarm fold; only `2` is published (see the header) */
  severities: Record<string, 1 | 2>
  /** per-incident Funkkontakt-Intervall (min) + Nachfrist (sec) */
  intervalMin: number
  graceSec: number
  /** silence this device's audible/OS alarm before navigating */
  onAcknowledge?: () => void
  /** open the Atemschutz board with this Trupp's card pointed at */
  onGoToTrupp: (id: string) => void
}) {
  // No 1 Hz tick here, deliberately: the row carries no running clock (that is the TopBar chip's
  // job). The wall clock is only re-read when something about the Trupps changes, and every event
  // that can flip a reason — a Druckmeldung, a Funkkontakt, a tier crossing — rewrites `trupps`
  // or `severities` anyway. A stale reading cannot mis-word a row: the pressure half of
  // `truppAlarm` never looks at the clock, and the contact half is only ever consulted for a
  // Trupp the fold has already rated tier 2. So this render cannot disagree with the next one,
  // which is why the impure read is fine where it stands.
  // eslint-disable-next-line react-hooks/purity -- justified directly above
  const rows = atemschutzAlarmRows(trupps, severities, Date.now(), intervalMin, graceSec, atemschutzDoctrine())
  // «Zum Trupp» took the operator to the alarm — the row goes with it (see the header). Keyed by
  // id AND reason, so the same emergency stays acknowledged while a different one resurfaces.
  const [visited, setVisited] = useState<Record<string, AtemschutzAlarmRow['reason']>>({})
  const liveKey = rows.map((r) => `${r.id}:${r.reason}`).join('|')
  useEffect(() => {
    // an entry whose alarm ended is forgotten, so the NEXT crossing publishes a fresh row
    setVisited((v) => {
      const kept = Object.fromEntries(Object.entries(v).filter(([id, reason]) => rows.some((r) => r.id === id && r.reason === reason)))
      return Object.keys(kept).length === Object.keys(v).length ? v : kept
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows is derived; liveKey IS its identity
  }, [liveKey])
  return <>{rows.filter((r) => visited[r.id] !== r.reason).map((r) => (
    <AtemschutzAlarmMeldung key={r.id} row={r} onAcknowledge={onAcknowledge}
      onGo={(id) => { setVisited((v) => ({ ...v, [r.id]: r.reason })); onGoToTrupp(id) }} />
  ))}</>
}

function AtemschutzAlarmMeldung({ row, onAcknowledge, onGo }: { row: AtemschutzAlarmRow; onAcknowledge?: () => void; onGo: (id: string) => void }) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const az = appConfig.copy.atemschutz
  const pressure = row.reason === 'pressure'
  // the whole crew, leader first — the title ellipsizes, so what does not fit falls away
  const name = [row.name || az.truppFallbackName, ...(row.members ?? [])].filter(Boolean).join(' · ')
  const go = () => { onAcknowledge?.(); onGo(row.id) }
  useMeldung({
    id: `atemschutz:${row.id}`,
    kind: 'atemschutz',
    tone: 'alarm',
    // the SAME two glyphs the TopBar chip uses for the same two reasons — the operator who
    // learned them on the chip does not have to learn them twice
    icon: pressure ? 'drop' : 'gauge',
    title: fillTemplate(pressure ? az.alarmRowPressure : az.alarmRowOverdue, { name }),
    sub: pressure
      ? fillTemplate(az.alarmRowPressureSub, { bar: row.bar ?? '', line: row.line ?? '' })
      : az.alarmRowOverdueSub,
    // ONE move, and it is forward: the board is where a Funkkontakt or a Druckmeldung is
    // entered, i.e. where this row is actually ended.
    actions: [{ label: az.alarmRowGo, icon: 'gauge', primary: true, onClick: go }],
    // …and the Trupp's name is the way there too, like every other row whose message has a place
    // (Meldeleiste · MeldungTitle). The filled button STAYS: this is the loudest row the app can
    // show, and it has to read as actionable at a glance, from across the Kommandoraum — the
    // tappable title is the shortcut for the hand that is already on the name, not a replacement.
    onOpen: { label: az.alarmRowGo, onClick: go },
  })
  return null
}
