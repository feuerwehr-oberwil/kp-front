/*
 * **The Auswertung is a Beilage of the PDF, not a screen** (F7, 09.10.2026 — owner: «maybe just
 * on the pdf export?»). Key figures + a swimlane timeline + the Lehren, printed on its own
 * landscape sheet at the END of the Rapport (backend · report_pdf · `_auswertung_story`), so the
 * Kader copy carries it and the signed part handed to a Gemeinde can be stapled without it.
 * Switched by `ReportOptions.auswertung` (on for the Rapport sheet, off for the QR-Erfassung's own
 * PDF).
 *
 * Everything is DERIVED from what the record already holds, here, where the ISO timestamps are —
 * the server gets minute offsets and finished strings (the same split as `personalSummary`: a
 * second derivation from printed clock text would be a second answer that can disagree):
 *   · vehicles   — `reportMeta.fahrzeuge` (Ausgerückt / Vor Ort / Zurück, the GPS «ab»)
 *   · Trupps     — the append-only reading log (lib/atemschutz · the contact clock rules)
 *   · milestones — the checklist milestone rows of the Verlauf («☑ …», minus the taken-back ones)
 *                  and the symbols marked «Gelöscht / erledigt» (lib/objectDone)
 *   · phases     — the tick times of each checklist phase
 * ⚠️ A figure without its data prints «—», never an estimate: no Vor-Ort time is not «0 min».
 */

import type { FahrzeugZeit } from './workspace'
import type { TimelineEvent, Trupp, TruppReading } from '../types'
import type { ChecklistState, ChecklistTemplate } from './checklists'
import { isAtemschutzTrupp } from './atemschutz'
import { eventIso, spanAwareClock } from './report'
import { appConfig } from '../config/appConfig'
import { fillTemplate, fmtSpanShort } from './format'
import { closedPauses } from './reopenClocks'

const MIN = 60_000
const HOUR = 60 * MIN
/** the widest axis the sheet draws — a three-day Elementarereignis fits, a mistyped year does not */
const MAX_AXIS = 7 * 24 * HOUR
/** how far past the alarm / the Einsatzende the axis may reach for a return trip or a late tick */
const AXIS_MARGIN = 2 * HOUR

/** ms of an ISO stamp, or null for an empty/unparseable one */
function ms(iso?: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

// ----------------------------------------------------------------------------- the model

export type BarKind = 'travel' | 'scene' | 'return' | 'as' | 'work' | 'standby' | 'phase'

export interface Bar { from: number; to: number; kind: BarKind }

/** The part of one contact interval past the Funkkontakt-Intervall: 1 = fällig (amber, the
 *  interval passed), 2 = überfällig (red, the grace on top passed too). */
export interface Gap { from: number; to: number; level: 1 | 2 }

export interface Lane {
  label: string
  bars: Bar[]
  /** single known instants with no span (a vehicle that rolled and never reported vor Ort) */
  marks: number[]
  /** recorded Funkkontakte (contact / Druck / Rückzug / Wiedereinstieg) */
  contacts: number[]
  gaps: Gap[]
}

export interface Milestone { at: number; label: string }

export interface ContactStats {
  /** contact intervals that ENDED (by a contact or an Austritt), plus open ones already overdue */
  intervals: number
  /** …of them, ended before the Trupp was überfällig */
  kept: number
  overruns: number
}

export interface Auswertung {
  alarmAt: number | null
  endAt: number | null
  /** the axis: alarm (or the first fact) → Einsatzende (or `now`, or the last fact) */
  t0: number
  t1: number
  firstOnScene: { at: number; ms: number; label: string } | null
  firstAs: { at: number; ms: number; label: string } | null
  contacts: ContactStats | null
  longestAs: { ms: number; label: string } | null
  totalMs: number | null
  vehicles: Lane[]
  trupps: Lane[]
  phases: Lane[]
  milestones: Milestone[]
}

export interface AuswertungInput {
  /** reportMeta.alarmiertAt ?? incident.started_at */
  alarmedAt?: string | null
  /** reportMeta.endedAt ?? the close time — null while the Einsatz runs */
  endedAt?: string | null
  /** the deployment clock (serverNow), for what is still open on a running Einsatz */
  now: number
  vehicles: { label: string; zeit?: FahrzeugZeit }[]
  trupps: Trupp[]
  contactIntervalMin: number
  contactGraceSec: number
  events: TimelineEvent[]
  /** symbols marked «Gelöscht / erledigt», already worded («Feuer gelöscht») */
  doneMarks?: { at: string; label: string }[]
  checklists?: ChecklistState
  templates?: ChecklistTemplate[]
}

// ----------------------------------------------------------------------------- Trupps

/** the reading kinds that RESTART the contact clock (lib/atemschutz · lastContactTime) */
const RESETS = new Set<TruppReading['kind']>(['contact', 'pressure', 'alarm', 'rueckzug', 'resume'])

export interface TruppStretches {
  /** each deployment, Eintritt → Austritt (end = `openEnd` when no Austritt was recorded) */
  runs: { from: number; to: number; open: boolean }[]
  /** the parts of the runs under PA — the watched stretches */
  watched: { from: number; to: number; open: boolean }[]
  /** Anmeldung → Eintritt / Austritt: a crew standing ready (a Sicherungstrupp) */
  standby: { from: number; to: number }[]
  contacts: number[]
  /** false when the Trupp has no log to read contacts off (a record from before 09.08.) */
  logged: boolean
}

/**
 * Read one Trupp's deployments off its log.
 *
 * Under PA or not is decided PER RUN: the first `paOn`/`paOff` row inside a run says what the
 * run started as (a `paOn` means it started unwatched), and a run without either is what the
 * Trupp is now. A kind changed between two runs by «Wieder einrücken» leaves no row behind
 * (useTruppActions · reactivateTrupp), so that one case reads as the current kind — the same
 * simplification the Atemschutz page makes by printing only today's PA Trupps.
 */
export function truppStretches(t: Trupp, openEnd: number): TruppStretches {
  const rows = [...(t.readings ?? [])]
    .map((r) => ({ r, at: ms(r.t) }))
    .filter((x): x is { r: TruppReading; at: number } => x.at != null)
    .sort((a, b) => a.at - b.at)
  const out: TruppStretches = { runs: [], watched: [], standby: [], contacts: [], logged: rows.length > 0 }
  if (!rows.length) {
    // the older shape: the card's own pair, nothing in between
    const entry = ms(t.entryTime)
    if (entry == null) return out
    const exit = ms(t.exitTime)
    const run = { from: entry, to: exit ?? Math.max(entry, openEnd), open: exit == null }
    out.runs.push(run)
    if (isAtemschutzTrupp(t)) out.watched.push({ ...run })
    return out
  }
  let run: { from: number; watched: boolean; watchFrom: number | null } | null = null
  let standbyFrom: number | null = null
  for (let i = 0; i < rows.length; i++) {
    const { r, at } = rows[i]
    if (r.kind === 'registered') {
      if (!run && standbyFrom == null) standbyFrom = at
    } else if (r.kind === 'entry') {
      if (standbyFrom != null) { out.standby.push({ from: standbyFrom, to: at }); standbyFrom = null }
      if (run) closeRun(at, false) // an Eintritt without the Austritt before it: the old run ends here
      let watched = isAtemschutzTrupp(t)
      for (let j = i + 1; j < rows.length && rows[j].r.kind !== 'exit' && rows[j].r.kind !== 'entry'; j++) {
        if (rows[j].r.kind === 'paOn') { watched = false; break }
        if (rows[j].r.kind === 'paOff') { watched = true; break }
      }
      run = { from: at, watched, watchFrom: watched ? at : null }
    } else if (r.kind === 'paOn') {
      if (run && run.watchFrom == null) run.watchFrom = at
    } else if (r.kind === 'paOff') {
      if (run && run.watchFrom != null) { out.watched.push({ from: run.watchFrom, to: at, open: false }); run.watchFrom = null }
    } else if (r.kind === 'exit') {
      if (run) closeRun(at, false)
      else if (standbyFrom != null) { out.standby.push({ from: standbyFrom, to: at }); standbyFrom = null }
    } else if (RESETS.has(r.kind) && run?.watchFrom != null) {
      out.contacts.push(at)
    }
  }
  if (run) closeRun(Math.max(run.from, openEnd), true)
  if (standbyFrom != null) out.standby.push({ from: standbyFrom, to: Math.max(standbyFrom, openEnd) })
  return out

  function closeRun(at: number, open: boolean) {
    if (!run) return
    out.runs.push({ from: run.from, to: at, open })
    if (run.watchFrom != null) out.watched.push({ from: run.watchFrom, to: at, open })
    run = null
  }
}

/**
 * The contact intervals of the watched stretches, judged against the Einsatz's own rule: fällig
 * once the interval has passed, überfällig once the grace on top has passed too (the same two
 * tiers as lib/atemschutz · contactSeverity). An interval runs from the Eintritt or a contact to
 * the next contact, or to the Austritt. One that is still OPEN (no Austritt recorded) counts only
 * once it was already overdue — that much is a fact; whether the rest would have been kept is not.
 *
 * ⚠️ `pauses` are the stretches the Einsatz stood CLOSED (reopenClocks · closedPauses). The clock
 * does not run while closed and RESTARTS at the reopen without any reading in the Trupp's log
 * (reopenClocks · clocksAfterReopen) — read without them, the closed hour is a phantom overrun.
 * The interval the close cut short is open like one without an Austritt.
 */
export function contactIntervals(
  s: TruppStretches, intervalMin: number, graceSec: number, pauses: readonly { from: number; to: number }[] = [],
): { gaps: Gap[]; stats: ContactStats } {
  const I = intervalMin * MIN
  const G = graceSec * 1000
  const gaps: Gap[] = []
  const stats: ContactStats = { intervals: 0, kept: 0, overruns: 0 }
  if (!s.logged || I <= 0) return { gaps, stats }
  const pieces = s.watched.flatMap((w) => without(w, pauses).map((p) => ({ ...p, open: p.to < w.to || w.open })))
  for (const w of pieces) {
    const marks = [w.from, ...s.contacts.filter((c) => c > w.from && c < w.to), w.to]
    for (let i = 0; i < marks.length - 1; i++) {
      const a = marks[i]
      const b = marks[i + 1]
      const last = i === marks.length - 2
      const overdue = b - a >= I + G
      if (b - a > I) gaps.push({ from: a + I, to: Math.min(b, a + I + G), level: 1 })
      if (overdue && b > a + I + G) gaps.push({ from: a + I + G, to: b, level: 2 })
      if (last && w.open && !overdue) continue
      stats.intervals++
      if (overdue) stats.overruns++
      else stats.kept++
    }
  }
  return { gaps, stats }
}

function truppLabel(t: Trupp): string {
  const name = t.name.trim()
  return typeof t.no === 'number' ? fillTemplate(appConfig.copy.auswertung.truppLane, { no: t.no, name }) : name
}

// ----------------------------------------------------------------------------- milestones, phases

/** The checklist milestones that STAND: every «☑ …» row of the Verlauf, minus the ones a later
 *  «Meilenstein zurückgenommen: …» row took back (lib/useChecklistActions · milestoneRow). The
 *  latest tick wins when one was ticked twice. */
export function verlaufMilestones(events: TimelineEvent[], fallbackDate?: string): Milestone[] {
  const [pre, post = ''] = appConfig.copy.checklists.milestoneUndone.split('{text}')
  const rows = events
    .map((e) => ({ e, at: ms(eventIso(e, fallbackDate)) }))
    .filter((x): x is { e: TimelineEvent; at: number } => x.at != null)
    .sort((a, b) => a.at - b.at)
  const standing = new Map<string, number>()
  for (const { e, at } of rows) {
    const text = e.text.trim()
    if (text.startsWith('☑')) standing.set(text.replace(/^☑\s*/, ''), at)
    else if (pre && text.startsWith(pre) && text.endsWith(post)) standing.delete(text.slice(pre.length, text.length - post.length).trim())
  }
  return [...standing].map(([label, at]) => ({ label, at }))
}

/** One band per checklist phase that has ticks: first tick → last tick. */
export function phaseLanes(state: ChecklistState | undefined, templates: ChecklistTemplate[] | undefined): Lane[] {
  if (!state || !templates?.length) return []
  const withPhases = templates.filter((tpl) => tpl.phases?.length && state[tpl.id])
  const lanes: Lane[] = []
  for (const tpl of withPhases) {
    const ticks = state[tpl.id].ticks ?? {}
    for (const ph of tpl.phases ?? []) {
      const ids = [...ph.items, ...(ph.branches ?? []).flatMap((b) => b.items)].map((it) => it.id)
      const at = ids.map((id) => ms(ticks[id]?.t)).filter((x): x is number => x != null)
      if (!at.length) continue
      const label = withPhases.length > 1 ? `${tpl.title} · ${ph.title}` : ph.title
      lanes.push({ label, bars: [{ from: Math.min(...at), to: Math.max(...at), kind: 'phase' }], marks: [], contacts: [], gaps: [] })
    }
  }
  return lanes
}

// ----------------------------------------------------------------------------- the whole

const emptyLane = (label: string): Lane => ({ label, bars: [], marks: [], contacts: [], gaps: [] })

/** One lane cut to the axis window: spans clamped at its edges, instants outside it dropped. */
function clipLane(l: Lane, lo: number, hi: number): Lane {
  const clamp = <T extends { from: number; to: number }>(x: T): T | null =>
    x.to < lo || x.from > hi ? null : { ...x, from: Math.max(x.from, lo), to: Math.min(x.to, hi) }
  const inside = (t: number) => t >= lo && t <= hi
  return {
    label: l.label,
    bars: l.bars.map(clamp).filter((b): b is Bar => !!b),
    marks: l.marks.filter(inside),
    contacts: l.contacts.filter(inside),
    gaps: l.gaps.map(clamp).filter((g): g is Gap => !!g),
  }
}

/** `span` minus every interval in `cut` — the pieces that remain, in order */
function without(span: { from: number; to: number }, cut: readonly { from: number; to: number }[]): { from: number; to: number }[] {
  let parts = [{ from: span.from, to: span.to }]
  for (const c of cut) {
    parts = parts.flatMap((p) => {
      if (c.to <= p.from || c.from >= p.to) return [p]
      return [{ from: p.from, to: c.from }, { from: c.to, to: p.to }].filter((q) => q.to > q.from)
    })
  }
  return parts
}

export function computeAuswertung(input: AuswertungInput): Auswertung {
  const alarmAt = ms(input.alarmedAt)
  const endAt = ms(input.endedAt)
  const openEnd = endAt ?? input.now

  // vehicles: Anfahrt (ausgerückt → vor Ort), vor Ort (→ the GPS «ab», else → zurück), Rückfahrt
  const vehicles: Lane[] = []
  let firstOnScene: Auswertung['firstOnScene'] = null
  for (const v of input.vehicles) {
    const z = v.zeit
    if (!z) continue
    // ⚠️ The GPS «ab» ends the stay only once the vehicle is AWAY: a shuttle to the depot and back
    // also stamps an «ab», and the vehicle is on scene again after it (types · FahrzeugGps)
    const aus = ms(z.ausgerueckt), vor = ms(z.vorOrt), zur = ms(z.zurueck), ab = z.gps?.zone === 'away' ? ms(z.gps.ab) : null
    const lane = emptyLane(v.label)
    if (aus != null && vor != null && vor >= aus) lane.bars.push({ from: aus, to: vor, kind: 'travel' })
    else if (aus != null) lane.marks.push(aus)
    if (vor != null) {
      const left = ab != null && ab >= vor ? ab : zur != null && zur >= vor ? zur : null
      lane.bars.push({ from: vor, to: left ?? Math.max(vor, openEnd), kind: 'scene' })
      if (ab != null && zur != null && zur >= ab && ab >= vor) lane.bars.push({ from: ab, to: zur, kind: 'return' })
      if (alarmAt != null && vor >= alarmAt && (!firstOnScene || vor < firstOnScene.at)) {
        firstOnScene = { at: vor, ms: vor - alarmAt, label: v.label }
      }
    } else if (zur != null) lane.marks.push(zur)
    if (lane.bars.length || lane.marks.length) vehicles.push(lane)
  }

  // Trupps: every one that ever went in, the removed ones included (the record — types ·
  // Trupp.removedAt), each ending where it was taken off the Tafel. A removed one that never
  // went in (an Anmeldung taken back) is not something that happened at the Einsatz.
  const pauses = closedPauses(input.events)
  const trupps: Lane[] = []
  const totals: ContactStats = { intervals: 0, kept: 0, overruns: 0 }
  let anyWatched = false
  let firstAs: Auswertung['firstAs'] = null
  let longestAs: Auswertung['longestAs'] = null
  for (const t of input.trupps) {
    const removed = ms(t.removedAt)
    const s = truppStretches(t, removed != null ? Math.min(openEnd, removed) : openEnd)
    if (!s.runs.length && (!s.standby.length || removed != null)) continue
    const label = truppLabel(t)
    const { gaps, stats } = contactIntervals(s, input.contactIntervalMin, input.contactGraceSec, pauses)
    totals.intervals += stats.intervals; totals.kept += stats.kept; totals.overruns += stats.overruns
    const lane = emptyLane(label)
    for (const sb of s.standby) lane.bars.push({ ...sb, kind: 'standby' })
    // «im Einsatz ohne Atemschutz» is what is LEFT of a run once its watched stretches are taken
    // out — drawn under them it would be a frame nobody sees and a legend entry for nothing
    for (const r of s.runs) for (const part of without(r, s.watched)) lane.bars.push({ ...part, kind: 'work' })
    for (const w of s.watched) {
      anyWatched = true
      lane.bars.push({ from: w.from, to: w.to, kind: 'as' })
      if (alarmAt != null && w.from >= alarmAt && (!firstAs || w.from < firstAs.at)) firstAs = { at: w.from, ms: w.from - alarmAt, label }
      // the longest is a DONE deployment — a crew still inside has not finished its time
      if (!w.open && (!longestAs || w.to - w.from > longestAs.ms)) longestAs = { ms: w.to - w.from, label }
    }
    lane.contacts = s.contacts
    lane.gaps = gaps
    trupps.push(lane)
  }

  const milestones = [
    ...verlaufMilestones(input.events, input.alarmedAt ?? undefined),
    ...(input.doneMarks ?? []).flatMap((d) => { const at = ms(d.at); return at == null ? [] : [{ at, label: d.label }] }),
  ].sort((a, b) => a.at - b.at)
  const phases = phaseLanes(input.checklists, input.templates)

  // ⚠️ The axis is CLAMPED around the Einsatz (alarm − 2 h … Einsatzende/now + 2 h, at most a
  // week): one mistyped date («04.06.2025» in a Zurück field) otherwise stretches it to a year and
  // squeezes every real bar into a hairline. What falls outside is cut at the edge or left off the
  // picture; the figures above it still read the record as it is.
  const hi = openEnd + AXIS_MARGIN
  const lo = Math.max(alarmAt != null ? alarmAt - AXIS_MARGIN : -Infinity, hi - MAX_AXIS)
  const lanesIn = (ls: Lane[]) => ls.map((l) => clipLane(l, lo, hi)).filter((l) => l.bars.length || l.marks.length)
  const [cv, ct, cp] = [lanesIn(vehicles), lanesIn(trupps), lanesIn(phases)]
  const cm = milestones.filter((m) => m.at >= lo && m.at <= hi)

  // the axis spans everything that is drawn, so nothing falls off either end
  const instants = [
    ...[...cv, ...ct, ...cp].flatMap((l) => [...l.bars.flatMap((b) => [b.from, b.to]), ...l.marks]),
    ...cm.map((m) => m.at),
  ]
  const t0 = Math.min(...[alarmAt, ...instants].filter((x): x is number => x != null && x >= lo), openEnd)
  const t1 = Math.max(...[endAt, ...instants].filter((x): x is number => x != null && x <= hi), t0 + MIN)

  return {
    alarmAt, endAt, t0, t1,
    firstOnScene, firstAs,
    contacts: anyWatched && totals.intervals > 0 ? totals : null,
    longestAs,
    totalMs: alarmAt != null && endAt != null && endAt >= alarmAt ? endAt - alarmAt : null,
    vehicles: cv, trupps: ct, phases: cp, milestones: cm,
  }
}

// ----------------------------------------------------------------------------- for the paper

/** A tick step (minutes) that puts 5–12 labels on the axis. */
export function tickStepMin(spanMin: number): number {
  const steps = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
  return steps.find((s) => spanMin / s <= 12) ?? 1440 * Math.ceil(spanMin / 1440 / 12)
}

/**
 * The payload block the server prints (backend · report_pdf · AuswertungIn). Times are MINUTES
 * after the axis start; every string is finished, in the deployment's language.
 */
export function auswertungForPdf(a: Auswertung, input: Pick<AuswertungInput, 'contactIntervalMin' | 'contactGraceSec'>, lehren?: string) {
  const C = appConfig.copy.auswertung
  const dash = C.missing
  const clock = spanAwareClock({ alarmedAt: new Date(a.t0).toISOString(), endedAt: new Date(a.t1).toISOString() })
  const at = (t: number) => clock(new Date(t).toISOString()) ?? ''
  const off = (t: number) => Math.round(((t - a.t0) / MIN) * 100) / 100
  const span = fmtSpanShort
  const pct = a.contacts ? Math.round((a.contacts.kept / a.contacts.intervals) * 100) : null
  // the grace as it IS — «20 s», «1 min», «1 min 30 s»; rounded to minutes a 20 s grace read «0»
  const g = Math.max(0, Math.round(input.contactGraceSec))
  const grace = [
    g >= 60 ? fillTemplate(C.graceMin, { n: Math.floor(g / 60) }) : '',
    g % 60 ? fillTemplate(C.graceSec, { n: g % 60 }) : '',
  ].filter(Boolean).join(' ')

  const figures = [
    {
      label: C.firstOnScene,
      value: a.firstOnScene ? span(a.firstOnScene.ms) : dash,
      sub: a.firstOnScene ? `${a.firstOnScene.label} · ${at(a.firstOnScene.at)}` : undefined,
      footnote: C.firstOnSceneDef,
    },
    {
      label: C.firstAs,
      value: a.firstAs ? span(a.firstAs.ms) : dash,
      sub: a.firstAs ? `${a.firstAs.label} · ${at(a.firstAs.at)}` : undefined,
      footnote: C.firstAsDef,
    },
    {
      label: C.contacts,
      value: pct != null ? `${pct} %` : dash,
      sub: a.contacts ? fillTemplate(C.contactsSub, { n: a.contacts.overruns, total: a.contacts.intervals }) : undefined,
      footnote: fillTemplate(grace ? C.contactsDef : C.contactsDefNoGrace, { n: input.contactIntervalMin, g: grace }),
      // the one figure that is a judgement: an overrun is worth the reader's eye on paper
      alert: !!a.contacts?.overruns,
    },
    {
      label: C.longestAs,
      value: a.longestAs ? span(a.longestAs.ms) : dash,
      sub: a.longestAs?.label,
      footnote: C.longestAsDef,
    },
    {
      label: C.total,
      value: a.totalMs != null ? span(a.totalMs) : dash,
      sub: a.totalMs == null && a.alarmAt != null && a.endAt == null ? C.totalRunning : undefined,
      footnote: C.totalDef,
    },
  ]

  const laneOut = (l: Lane) => ({
    label: l.label,
    bars: l.bars.map((b) => ({ start: off(b.from), end: off(b.to), kind: b.kind })),
    marks: l.marks.map(off),
    contacts: l.contacts.map(off),
    gaps: l.gaps.map((g) => ({ start: off(g.from), end: off(g.to), level: g.level })),
  })
  const groups = [
    { label: C.groupPhases, lanes: a.phases.map(laneOut) },
    { label: C.groupVehicles, lanes: a.vehicles.map(laneOut) },
    { label: C.groupTrupps, lanes: a.trupps.map(laneOut) },
  ].filter((g) => g.lanes.length)

  const spanMin = Math.max(1, (a.t1 - a.t0) / MIN)
  const step = tickStepMin(spanMin)
  // ticks on round clock times (a multiple of the step since local midnight), not on «alarm + n»
  const d0 = new Date(a.t0)
  const midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime()
  const ticks: { at: number; label: string }[] = []
  for (let t = midnight + Math.ceil((a.t0 - midnight) / (step * MIN)) * step * MIN; t <= a.t1; t += step * MIN) {
    ticks.push({ at: off(t), label: at(t) })
  }

  const hasTimeline = groups.length > 0 || a.milestones.length > 0
  return {
    heading: C.heading,
    note: C.note,
    figures,
    timeline: hasTimeline
      ? {
          span: Math.round(spanMin * 100) / 100,
          ticks,
          groups,
          milestonesLabel: C.groupMilestones,
          milestones: a.milestones.map((m) => ({ at: off(m.at), label: m.label, time: at(m.at) })),
        }
      : null,
    noTimeline: hasTimeline ? undefined : C.noTimeline,
    legend: {
      travel: C.legendTravel, scene: C.legendScene, back: C.legendReturn,
      pa: C.legendAs, work: C.legendWork, standby: C.legendStandby,
      contact: C.legendContact, faellig: C.legendFaellig, ueberfaellig: C.legendUeberfaellig,
      milestone: C.legendMilestone, phase: C.legendPhase,
    },
    footnotesHead: C.footnotesHead,
    // ⚠️ A pointer, not the text (review of #303): the Lehren print on page 1 with the signed
    // record, and a second copy here would be two places to read one answer from
    lehrenNote: lehren?.trim() ? C.lehrenSeePage1 : undefined,
  }
}

export type AuswertungPdf = ReturnType<typeof auswertungForPdf>
