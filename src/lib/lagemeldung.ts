// Lagemeldung auf Knopfdruck (KP Front F3, 09.10.2026) — the deterministic composer.
//
// It reads the record, decides what matters right now, says what changed since the last
// Lagemeldung, and fits it into one radio call. No AI, no hidden state: the same Saved + Verlauf
// give the same draft on every device, and everything it knows is in the record and in the anchor
// row. It only ever OFFERS text, like lib/gerettete — nothing is written until «Gemeldet».
//
// The pipeline, each step one pure function:
//   1. collectFacts — the RULES turn the record into ~20 facts with a stable key
//      (`pers.vermisst = 1`, `as.alarm.<trupp> = pressure|Trupp 2`, `mittel.vorOrt = [ADL, TLF]`).
//      Hundreds of contact readings and symbol moves collapse into a handful of facts.
//   2. diffFacts — now vs. the last Lagemeldung (the ANCHOR, a Verlauf row carrying the facts it
//      reported): NEU · SCHLECHTER · BESSER · ERLEDIGT · = (gleich). Unchanged facts are hidden
//      (S9) — except tier 0, which is said every time while it lasts.
//   3. fitBudget — ≤ 60 words (≈ 35 s Funk). Tier-2 lines first switch to their short form, then
//      the lowest score drops into «Ausgeblendet · über Funklänge». Tier 0 is never cut, tier 0
//      and 1 are never shortened.
//
// Tiers: 0 Leben (Trupp in Alarm, Vermisste) · 1 Lage-ändernd (Gerettete, Gefahren, Meilensteine,
// dringender Bedarf, a wind shift beside a hazard) · 2 Kontext (Lage, Massnahmen, Mittel,
// geschätzte Ablösung, Nächste Meldung) · 3 Hintergrund (own Aufträge, Erinnerungen — offered,
// never pre-ticked). Score = tier base + change + boost; the score only decides what survives the
// budget, the PRINT order is the fixed slot order (SLOT_ORDER).
//
// ⚠️ Every hidden item says WHY it is hidden («unverändert seit 21:17», «Routine», «über
// Funklänge») — the 3am tenet applied to a filter: the EL sees what the machine decided and
// overrules it with one tap.
// ⚠️ Free-text Verlauf rows are matched only against the station's own quick phrases
// (appConfig.lagemeldung.phrases — exact, case-insensitive, the «Auftrag · » tag stripped, more
// words may follow). No language guessing.
// ⚠️ Persons are never named (S8): Trupps by number, people by role. The radio is not private.
// ⚠️ The dispatch text (reportMeta.alarmText) is never repeated — the ELZ wrote it (S4).
// ⚠️ An estimate says so: the projected Atemschutz-Ablösung carries the «Schätzung» tag
// (Planungshilfe), a building fact from the registers the «Register» tag.
//
// The seam for an optional LLM «Glätten» (not built) and for the Rück port: `composeLagemeldung`
// returns STRUCTURE (lines with key, slot, tier, change, text), never a bare string.

import { appConfig } from '../config/appConfig'
import { fillTemplate, formatSymbolName, hhmm } from './format'
import { norm } from './quickPhrases'
import { deriveTruppLive, estimatePressure, truppAlarm } from './atemschutz'
import { truppAuftragLabel } from './report'
import { floorLabel } from './whiteboard'
import { doneOf } from './objectDone'
import { lookupErg } from './erg'
import { parseErgDistance } from './ergRings'
import { HAZARD_ENERGY } from './buildingCard'
import type { BuildingInfo } from './api/building'
import type { OpenReminder } from './reminders'
import type { FahrzeugZeit } from './workspace'
import type { ObjectDone, TimelineEvent, Trupp } from '../types'
import type { LageAnchor, LageAnchorRef } from './lageRhythm'

// ── the vocabulary ──────────────────────────────────────────────────────────────────────────────

/** The fixed print order of a Lagemeldung. `zusatz` holds the EL's own lines, before «Nächste». */
export type LageSlot = 'zuerst' | 'lage' | 'menschen' | 'gefahren' | 'massnahmen' | 'mittel' | 'bedarf' | 'zusatz' | 'naechste'
export const SLOT_ORDER: readonly LageSlot[] = ['zuerst', 'lage', 'menschen', 'gefahren', 'massnahmen', 'mittel', 'bedarf', 'zusatz', 'naechste']

export type LageTier = 0 | 1 | 2 | 3
export type LageChange = 'neu' | 'schlechter' | 'besser' | 'erledigt' | 'gleich'
/** «Seit letzter» (the ELZ, default) or «Vollständig» (Übergabe, Nachbarwehr, Rück) */
export type LageMode = 'seit' | 'voll'
/** A fact's fingerprint — a VALUE, not a hash, so the Rapport can later show what was reported when. */
export type LageValue = string | number | string[]

/** Which rule produced a fact (the design's rule table, f3.html §04). */
export type LageRule =
  | 'L2' | 'L3'
  | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8'
  | 'K1' | 'K2' | 'K3' | 'K4' | 'K5'
  | 'H1' | 'H2'
  | 'EL'

/** How a changed value reads. `count-worse`: a higher number is worse (Vermisste) · `count-better`
 *  (Gerettete) · `list-worse`: a longer list is worse (Brand spreading) · `rank`: the value's
 *  position in `ranks` — later is better (Gas present → abgestellt, unter Kontrolle → Feuer aus). */
export type LageTrend = 'count-worse' | 'count-better' | 'list-worse' | 'rank'

export interface LageFact {
  key: string
  rule: LageRule
  slot: LageSlot
  tier: LageTier
  value: LageValue
  text: string
  /** the T2 short form the budget switches to before it drops anything */
  short?: string
  trend?: LageTrend
  ranks?: readonly string[]
  boost?: number
  /** Planungshilfe (an estimate) or a register hint — printed as a tag beside the line */
  tag?: 'schaetzung' | 'register'
  /** an EVENT that happened after the anchor (a wind shift, a Nachalarm, an order): always NEU,
   *  never stored in the anchor — it simply is not there next time */
  event?: boolean
  /** T3: offered in «Ausgeblendet», never pre-ticked */
  offer?: boolean
}

/** What a sent Lagemeldung row carries (TimelineEvent.lagemeldung) — see lib/lageRhythm. */
export type { LageAnchor, LageAnchorRef } from './lageRhythm'
export { findAnchor } from './lageRhythm'

export interface LageDoctrine {
  contactIntervalMin: number
  contactGraceSec: number
  alarmBar?: number
  alarmBarRueckzug?: number
  cylinderLiters: number
  estConsumptionLPerMin: number
}

/** A placed symbol — a Lage entity or a plan annotation; both views of one record share the id. */
export interface LageSymbol {
  id?: string
  kind?: string
  symbol?: string
  label?: string
  count?: number
  fields?: Record<string, string>
  floor?: number
  floorFrom?: number
  floorTo?: number
  done?: ObjectDone
}

export interface LageInput {
  /** the deployment clock, ms */
  now: number
  /** the Einsatz's Stichwort/title («Brand MFH») */
  title: string
  /** the dispatch text — never repeated, only named in «Ausgeblendet» (S4) */
  alarmText?: string
  /** entities ∪ every plan's annotations — deduped by id here */
  symbols: readonly LageSymbol[]
  trupps: readonly Trupp[]
  doctrine: LageDoctrine
  /** the folded Verlauf (patches applied, retracted rows gone), any order */
  rows: readonly TimelineEvent[]
  /** the open Pendenzen / Erinnerungen (lib/reminders · deriveReminders) */
  reminders: readonly OpenReminder[]
  fahrzeuge: readonly FahrzeugZeit[]
  fleet: readonly { id: string; label: string }[]
  /** Anwesenheit: how many are present */
  present: number
  building?: BuildingInfo | null
  /** K5: the next Lagemeldung — ms, or 'handover' (bei Übergabe), or null (none planned) */
  next?: number | 'handover' | null
}

/** One line of the draft. */
export interface LageLine {
  key: string
  rule: LageRule
  slot: LageSlot
  tier: LageTier
  change: LageChange
  score: number
  /** what is said — the full form, or the short one once the budget switched it */
  text: string
  /** the full form (the short one replaced it in `text` when `shortened`) */
  full: string
  short?: string
  shortened?: boolean
  tag?: LageFact['tag']
  value?: LageValue
  event?: boolean
  /** the rule order within a slot (collection order) — the print order after the tier */
  order?: number
}

export type LageHiddenReason = 'gleich' | 'declined' | 'budget' | 'routine' | 'offer' | 'superseded' | 'dispatch'

/** An item in «Ausgeblendet». With a `line` it can be added back with one tap; without one it is
 *  only an account of what was folded away (routine counts, the dispatch). */
export interface LageHidden {
  key: string
  text: string
  reason: LageHiddenReason
  /** filled into the reason's template: the anchor time, the superseding phrase */
  detail?: string
  line?: LageLine
}

export interface LageDraft {
  mode: LageMode
  /** no anchor: the Erstmeldung — every fact of tier 0–2 is new */
  first: boolean
  anchorAt: number | null
  /** shown and pre-ticked, in print order */
  lines: LageLine[]
  hidden: LageHidden[]
  /** «Feuer aus» stands: the composer offers to stretch the rhythm (30′ / bei Übergabe / Aus) */
  windDown: boolean
}

const TIER_BASE: Record<LageTier, number> = { 0: 100, 1: 60, 2: 30, 3: 10 }
const CHANGE_BONUS: Record<LageChange, number> = { neu: 20, schlechter: 20, besser: 10, erledigt: 10, gleich: 0 }

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

const C = () => appConfig.copy.lagemeldung
const P = () => appConfig.lagemeldung.phrases
type PhraseId = keyof typeof appConfig.lagemeldung.phrases

const ms = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : NaN)
const clock = (t: number): string => hhmm(new Date(t))

function sameValue(a: LageValue | undefined, b: LageValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
  return a === b
}

/** «2. OG» · «EG» · «1.–3. OG» — the storey a symbol stands on, or '' when it says none. */
function floorText(s: LageSymbol): string {
  if (s.floorFrom != null && s.floorTo != null && s.floorFrom !== s.floorTo) {
    const lo = Math.min(s.floorFrom, s.floorTo)
    const hi = Math.max(s.floorFrom, s.floorTo)
    return `${floorLabel(lo)}–${floorLabel(hi)}`
  }
  const f = s.floor ?? s.floorFrom ?? s.floorTo
  return f == null ? '' : floorLabel(f)
}

/** Lage entities and plan annotations are two VIEWS of one record (lib/tacticalObjects): one id,
 *  counted once — the same rule lib/gerettete applies. */
function uniqueSymbols(all: readonly LageSymbol[]): LageSymbol[] {
  const seen = new Set<string>()
  const out: LageSymbol[] = []
  for (const s of all) {
    if (!s.symbol || (s.kind && s.kind !== 'symbol')) continue
    if (s.id != null) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
    }
    out.push(s)
  }
  return out
}

/** The entry's body without the «Auftrag · » / «Sofortmassnahme · » tag composeJournalText puts on. */
function rowBody(e: TimelineEvent): string {
  const tags = Object.values(appConfig.copy.journal.entryTypes)
  for (const t of tags) {
    if (e.text.startsWith(`${t} · `)) return e.text.slice(t.length + 3)
  }
  return e.text
}

/** Does this row say the phrase? Exact, case-insensitive; more words may follow the phrase. */
function says(e: TimelineEvent, phrase: string): boolean {
  const body = norm(rowBody(e))
  const p = norm(phrase)
  if (!p || !body.startsWith(p)) return false
  const next = body.charAt(p.length)
  return next === '' || /[\s,.;:!–-]/.test(next)
}

/** The operator's own entries — what the phrase rules read. Server lifecycle rows, rows that
 *  arrived after the close (S7), Wiedervorlage bookkeeping and earlier Lagemeldungen (S5) are not. */
function isEntry(e: TimelineEvent): boolean {
  return !e.lifecycle && !e.receivedAfterClose && !e.lagemeldung && !e.reminder?.purpose
    && (e.kind === undefined || e.kind === 'journal' || e.kind === 'note' || e.kind === 'reminder' || e.kind === 'audio')
}

function truppWord(t: Trupp): string {
  return t.no != null ? fillTemplate(C().truppNo, { n: t.no }) : C().truppBare
}

function where(w: string): string {
  return w ? fillTemplate(C().where, { w }) : ''
}

function joinList(xs: readonly string[]): string {
  return xs.join(', ')
}

/** Words as the radio counts them: whitespace-separated tokens. */
export function wordCount(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/** ≈ seconds on the radio for a word count. */
export function radioSeconds(words: number): number {
  return Math.round(words / appConfig.lagemeldung.wordsPerSecond)
}

// ── 1. the rules ────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  input: LageInput
  syms: LageSymbol[]
  /** the operator's entries, oldest first */
  entries: TimelineEvent[]
  /** entries after the anchor (all of them for an Erstmeldung) */
  fresh: TimelineEvent[]
  anchor: LageAnchorRef | null
  prev: Record<string, LageValue>
}

/** The latest entry saying a phrase, or null. */
function lastSaid(entries: readonly TimelineEvent[], id: PhraseId): TimelineEvent | null {
  const phrase = P()[id]
  for (let i = entries.length - 1; i >= 0; i--) if (says(entries[i], phrase)) return entries[i]
  return null
}

/** L2 — a Trupp in Alarm: überfällig or at its Alarmdruck. Tier 0, «Zuerst», repeated while true.
 *  «Kontakt fällig» (severity 1) is the AS-Überwacher's business, not the ELZ's. */
function ruleTruppAlarm(c: Ctx): LageFact[] {
  const { now, doctrine } = c.input
  const out: LageFact[] = []
  for (const t of c.input.trupps) {
    if (t.removedAt) continue
    const live = deriveTruppLive(t, now, doctrine.contactIntervalMin, doctrine.contactGraceSec)
    const a = truppAlarm(t, live, doctrine.contactIntervalMin, doctrine.contactGraceSec, { alarmBar: doctrine.alarmBar, alarmBarRueckzug: doctrine.alarmBarRueckzug })
    if (a.sev < 2 || !a.reason) continue
    const who = truppWord(t)
    const text = a.reason === 'pressure'
      ? fillTemplate(C().truppPressure, { trupp: who, bar: Math.round(live.currentBar), where: where(t.ziel?.trim() ?? '') })
      : fillTemplate(C().truppContact, { trupp: who, m: Math.floor((live.sinceContactSec ?? 0) / 60), where: where(t.ziel?.trim() ?? '') })
    out.push({ key: `as.alarm.${t.id}`, rule: 'L2', slot: 'zuerst', tier: 0, value: `${a.reason}|${who}`, text, boost: a.reason === 'pressure' ? 10 : 0 })
  }
  return out
}

/** The Rettungs-Symbole by Status. An unset count is one person (lib/gerettete). */
function rescues(c: Ctx): { status: string; n: number; where: string }[] {
  const rescue = appConfig.symbols.rescueName
  return c.syms.filter((s) => s.symbol === rescue).map((s) => ({
    status: (s.fields?.Status ?? '').trim().toLowerCase(),
    n: s.count ?? 1,
    where: floorText(s),
  }))
}

/** L3 — Vermisste / Eingeschlossene, tier 0. Gone → one ERLEDIGT «Keine weiteren Vermissten». */
function ruleVermisst(c: Ctx): LageFact[] {
  const rs = rescues(c)
  const sum = (st: string) => rs.filter((r) => r.status === st)
  const vermisst = sum('vermisst')
  const ein = sum('eingesperrt')
  const nV = vermisst.reduce((a, r) => a + r.n, 0)
  const nE = ein.reduce((a, r) => a + r.n, 0)
  if (!nV && !nE) return []
  const places = (xs: typeof rs) => joinList([...new Set(xs.map((r) => r.where).filter(Boolean))])
  const parts: string[] = []
  if (nV) parts.push(fillTemplate(nV === 1 ? C().vermisstOne : C().vermisstMany, { n: nV, where: where(places(vermisst)) }))
  if (nE) parts.push(fillTemplate(nE === 1 ? C().eingesperrtOne : C().eingesperrtMany, { n: nE, where: where(places(ein)) }))
  return [{ key: 'pers.vermisst', rule: 'L3', slot: 'menschen', tier: 0, value: nV + nE, text: parts.join(' '), trend: 'count-worse' }]
}

/** G1 — Gerettete: the Rettungs-Symbole on «gerettet», or the «Person gerettet» entries, whichever
 *  counts more (the same rescue is often both a symbol and an entry). */
function ruleGerettet(c: Ctx): LageFact[] {
  const bySymbol = rescues(c).filter((r) => r.status === 'gerettet').reduce((a, r) => a + r.n, 0)
  const byEntry = c.entries.filter((e) => says(e, P().gerettet)).length
  const n = Math.max(bySymbol, byEntry)
  if (!n) return []
  const extra = lastSaid(c.entries, 'sanitaetUebergeben') ? C().anSanitaet : ''
  return [{
    key: 'pers.gerettet', rule: 'G1', slot: 'menschen', tier: 1, value: n, trend: 'count-better',
    text: fillTemplate(n === 1 ? C().gerettetOne : C().gerettetMany, { n, extra }),
  }]
}

/** G2 — «Gebäude geräumt» / «Keine Personen im Gebäude». A state once said. */
function ruleGeraeumt(c: Ctx): LageFact[] {
  const out: LageFact[] = []
  if (lastSaid(c.entries, 'geraeumt')) out.push({ key: 'pers.geraeumt', rule: 'G2', slot: 'menschen', tier: 1, value: 'ja', text: C().geraeumt })
  if (lastSaid(c.entries, 'keinePersonen')) out.push({ key: 'pers.keine', rule: 'G2', slot: 'menschen', tier: 1, value: 'ja', text: C().keinePersonen })
  return out
}

/** G3 + G4 — the hazards on the map. A placard with a UN number is G3 (with the ERG isolation
 *  distance where the material is TIH); every other hazard sign is G4. A sign marked «erledigt»
 *  (lib/objectDone) is gone from the facts, which the diff reads as ERLEDIGT. */
function ruleHazards(c: Ctx): LageFact[] {
  const hz = new Set(appConfig.lagemeldung.hazardSymbols)
  const unField = appConfig.copy.contextPanel.unField
  const stoffField = appConfig.copy.contextPanel.stoffField
  const out: LageFact[] = []
  const seenUn = new Set<string>()
  for (const s of c.syms) {
    if (!s.symbol || !hz.has(s.symbol) || doneOf(s)) continue
    const un = (s.fields?.[unField] ?? '').replace(/\D/g, '')
    if (un) {
      if (seenUn.has(un)) continue
      seenUn.add(un)
      const stoff = (s.fields?.[stoffField] ?? '').trim()
      const si = lookupErg(un)?.tih?.[0]?.si
      const m = parseErgDistance(si)
      out.push({
        key: `hz.un.${un}`, rule: 'G3', slot: 'gefahren', tier: 1, value: `${un}|${stoff}`, boost: 15,
        text: fillTemplate(C().un, { un, stoff: stoff ? ` ${stoff}` : '', dist: m ? fillTemplate(C().unDist, { m }) : '' }),
      })
      continue
    }
    const label = (s.label?.trim() || formatSymbolName(s.symbol))
    out.push({
      key: `hz.sym.${s.id ?? `${s.symbol}|${floorText(s)}`}`, rule: 'G4', slot: 'gefahren', tier: 1, value: label, boost: 5,
      text: fillTemplate(C().hazard, { label, where: where(floorText(s)) }),
    })
  }
  return out
}

/** G5 — the building (F5, the Gebäude-Steckbrief): gas / oil heating and PV are hazards, more than
 *  three storeys is Lage. «Gas abgestellt» / «Strom abgeschaltet» turn the hazard BESSER. Register
 *  facts carry the «Register» tag — the register can be years behind the building. */
function ruleBuilding(c: Ctx): LageFact[] {
  const b = c.input.building
  const g = b?.gwr_status === 'ok' ? b.gwr : null
  const heat = new Set([...(g?.heating ?? []), ...(g?.hot_water ?? [])].filter((e) => HAZARD_ENERGY.has(e)))
  const pv = b?.pv_status === 'ok' && b.plants.some((p) => p.kind === 'pv')
  const gasAb = !!lastSaid(c.entries, 'gasAb')
  const stromAb = !!lastSaid(c.entries, 'stromAb')
  const out: LageFact[] = []
  if (heat.has('gas') || gasAb) {
    out.push({
      key: 'hz.gas', rule: 'G5', slot: 'gefahren', tier: 1, value: gasAb ? 'ab' : 'present', trend: 'rank', ranks: ['present', 'ab'],
      text: gasAb ? C().gasAb : C().gas, tag: gasAb ? undefined : 'register',
    })
  }
  if (heat.has('oil')) out.push({ key: 'hz.oil', rule: 'G5', slot: 'gefahren', tier: 1, value: 'present', text: C().oil, tag: 'register' })
  if (pv) out.push({ key: 'hz.pv', rule: 'G5', slot: 'gefahren', tier: 1, value: 'present', text: C().pv, tag: 'register' })
  if (stromAb) out.push({ key: 'hz.strom', rule: 'G5', slot: 'gefahren', tier: 1, value: 'ab', text: C().stromAb })
  if (g?.floors != null && g.floors > 3) {
    out.push({ key: 'lage.geschosse', rule: 'G5', slot: 'lage', tier: 2, value: g.floors, text: fillTemplate(C().geschosse, { n: g.floors }), tag: 'register' })
  }
  return out
}

/** «Wind dreht: W → NO (286° → 66°) · Lüfter prüfen» (backend · observations) → the bearing it
 *  turned to, or null when the row does not read that way. */
function windTo(text: string): number | null {
  const m = /→\s*(\d{1,3})°\s*\)/.exec(text)
  return m ? Number(m[1]) % 360 : null
}

/** G6 — a wind shift the server observed after the anchor. Lage-ändernd (tier 1) beside a hazard
 *  or where air is being moved (a Lüfter, «Entrauchung»); otherwise context. */
function ruleWind(c: Ctx, hazards: boolean): LageFact[] {
  const air = new Set(appConfig.lagemeldung.airSymbols)
  const moving = hazards || c.syms.some((s) => s.symbol && air.has(s.symbol)) || !!lastSaid(c.entries, 'entrauchung')
  const shifts = c.input.rows
    .filter((r) => r.id.startsWith('wxd-') && !r.retracted && (!c.anchor || ms(r.at) > c.anchor.at || ms(r.writtenAt) > c.anchor.at))
    .sort((a, b) => ms(a.at) - ms(b.at))
  const last = shifts[shifts.length - 1]
  if (!last) return []
  const to = windTo(last.text)
  const cardinals = appConfig.copy.weather.cardinalsLong
  const text = to != null
    ? fillTemplate(C().wind, { dir: cardinals[Math.round(to / 45) % 8] })
    : `${last.text.split(' · ')[0]}.`
  return [{ key: 'wind.shift', rule: 'G6', slot: 'gefahren', tier: moving ? 1 : 2, value: last.id, text, event: true, boost: moving ? 20 : 0 }]
}

/** G7 — the milestones of a fire: «Brand unter Kontrolle» < «Feuer aus» (+ «Nachlöscharbeiten
 *  laufen»). Only the latest of the chain is said; the earlier one, if it fell in the same interval,
 *  is shown in «Ausgeblendet» as superseded. */
function ruleMilestone(c: Ctx): { facts: LageFact[]; superseded: LageHidden[]; windDown: boolean } {
  const kontrolle = lastSaid(c.entries, 'unterKontrolle')
  const aus = lastSaid(c.entries, 'feuerAus')
  if (!kontrolle && !aus) return { facts: [], superseded: [], windDown: false }
  if (aus) {
    const nach = lastSaid(c.entries, 'nachloesch')
    const extra = nach && ms(nach.at) >= ms(aus.at) - 60_000 ? C().nachloesch : ''
    const superseded: LageHidden[] = kontrolle && c.fresh.includes(kontrolle)
      ? [{ key: 'lage.stand.kontrolle', text: P().unterKontrolle, reason: 'superseded', detail: P().feuerAus }]
      : []
    return {
      facts: [{ key: 'lage.stand', rule: 'G7', slot: 'lage', tier: 1, value: 'aus', trend: 'rank', ranks: ['kontrolle', 'aus'], text: fillTemplate(C().feuerAus, { t: clock(ms(aus.at)), extra }), boost: 10 }],
      superseded,
      windDown: true,
    }
  }
  return {
    facts: [{ key: 'lage.stand', rule: 'G7', slot: 'lage', tier: 1, value: 'kontrolle', trend: 'rank', ranks: ['kontrolle', 'aus'], text: fillTemplate(C().unterKontrolle, { t: clock(ms(kontrolle!.at)) }), boost: 10 }],
    superseded: [],
    windDown: false,
  }
}

const inField = (t: Trupp) => !t.removedAt && (t.status === 'aktiv' || t.status === 'rueckzug' || t.status === 'ueberfaellig')
const isAs = (t: Trupp) => (t.kind ?? 'atemschutz') === 'atemschutz'

/** G8 — dringender Bedarf (tier 1): the urgent Pendenzen, «Verstärkung angefordert» with nothing
 *  arrived since, and a Trupp in Rückzug with no relief angemeldet.
 *  K4 — the same relief, foreseen (tier 2, «Schätzung»): a Trupp estimated to reach its
 *  Alarmdruck within 10′ (lib/atemschutz · estimatePressure, a Planungshilfe). */
function ruleBedarf(c: Ctx): LageFact[] {
  const out: LageFact[] = []
  for (const r of c.input.reminders) {
    if (!r.urgent || r.dueAt || r.purpose) continue
    out.push({ key: `bedarf.p.${r.id}`, rule: 'G8', slot: 'bedarf', tier: 1, value: r.text, text: /[.!?]$/.test(r.text) ? r.text : `${r.text}.` })
  }
  const verst = lastSaid(c.entries, 'verstaerkung')
  if (verst) {
    const since = ms(verst.at)
    const arrived = c.input.fahrzeuge.some((f) => ms(f.vorOrt) > since || ms(f.gps?.an) > since)
      || c.entries.some((e) => ms(e.at) > since && says(e, P().nachbarVorOrt))
    if (!arrived) out.push({ key: 'bedarf.verstaerkung', rule: 'G8', slot: 'bedarf', tier: 1, value: C().verstaerkung, text: C().verstaerkung })
  }
  const { now, doctrine } = c.input
  // a relief is an Atemschutz-Trupp angemeldet for WORK — the Sicherheitstrupp is held back for
  // the crews inside and is nobody's relief
  const relief = c.input.trupps.some((t) => !t.removedAt && t.status === 'angemeldet' && isAs(t) && t.auftrag !== 'sichern')
  if (!relief) {
    // has to come out now: in Rückzug, or at its Alarmdruck (lib/atemschutz · truppAlarm)
    const mustOut = c.input.trupps.some((t) => {
      if (!inField(t) || !isAs(t)) return false
      if (t.status === 'rueckzug') return true
      const live = deriveTruppLive(t, now, doctrine.contactIntervalMin, doctrine.contactGraceSec)
      return truppAlarm(t, live, doctrine.contactIntervalMin, doctrine.contactGraceSec, { alarmBar: doctrine.alarmBar, alarmBarRueckzug: doctrine.alarmBarRueckzug }).reason === 'pressure'
    })
    if (mustOut) {
      out.push({ key: 'bedarf.as', rule: 'G8', slot: 'bedarf', tier: 1, value: C().abloesungJetzt, text: C().abloesungJetzt, boost: 10 })
    } else if (doctrine.alarmBar != null && doctrine.alarmBar > 0) {
      let soonest: number | null = null
      for (const t of c.input.trupps) {
        if (!inField(t) || !isAs(t)) continue
        const est = estimatePressure(t, now, doctrine.cylinderLiters, doctrine.estConsumptionLPerMin)
        if (!est || !(est.rateBarPerMin > 0) || est.bar <= doctrine.alarmBar) continue
        const mins = (est.bar - doctrine.alarmBar) / est.rateBarPerMin
        if (mins <= appConfig.lagemeldung.reliefLeadMin && (soonest == null || mins < soonest)) soonest = mins
      }
      if (soonest != null) {
        const m = Math.max(1, Math.round(soonest))
        out.push({ key: 'bedarf.as.bald', rule: 'K4', slot: 'bedarf', tier: 2, value: C().abloesungJetzt, text: fillTemplate(C().abloesungBald, { m }), tag: 'schaetzung' })
      }
    }
  }
  return out
}

/** K1 — the Lage core: the Stichwort and the damage on the map, with its storeys. Every fire
 *  marked «gelöscht» and none left burning reads «Feuer gelöscht HH:MM». */
function ruleLageCore(c: Ctx, feuerAusSaid = false): LageFact[] {
  const damage = new Set(appConfig.lagemeldung.lageSymbols)
  const fire = new Set(appConfig.symbols.fireFamily)
  const parts: string[] = []
  let doneFireAt: number | null = null
  let activeFire = false
  for (const s of c.syms) {
    if (!s.symbol || !damage.has(s.symbol)) continue
    const d = doneOf(s)
    if (fire.has(s.symbol)) {
      if (d) { const t = ms(d.at); doneFireAt = doneFireAt == null ? t : Math.max(doneFireAt, t); continue }
      activeFire = true
    } else if (d) continue
    const f = floorText(s)
    const label = formatSymbolName(s.symbol)
    parts.push(f ? `${label} ${f}` : label)
  }
  const list = [...new Set(parts)].sort()
  const title = c.input.title.trim()
  if (!title && !list.length && doneFireAt == null) return []
  const texts: string[] = []
  if (title) texts.push(fillTemplate(C().lageTitle, { title }))
  if (list.length) texts.push(fillTemplate(C().lageDamage, { list: joinList(list) }))
  // «Feuer aus» said (G7) already tells it — the marked symbol is not said a second time
  const geloescht = !activeFire && doneFireAt != null && !feuerAusSaid
  const out = geloescht ? [...list, 'Feuer|gelöscht'] : list
  if (geloescht) texts.push(fillTemplate(C().feuerGeloescht, { t: clock(doneFireAt!) }))
  return [{ key: 'lage.kern', rule: 'K1', slot: 'lage', tier: 2, value: [title, ...out], text: texts.join(' '), trend: 'list-worse' }]
}

/** K2 — Massnahmen: the Trupps in the field by Auftrag and Ziel, the Sicherheitstrupp, and the
 *  quick phrases that name a measure. The VALUE ignores which Trupp does it, so a relief crew
 *  taking over the same job is not news. */
function ruleMassnahmen(c: Ctx): LageFact[] {
  const out: LageFact[] = []
  const field = c.input.trupps.filter(inField)
  const sitr = field.filter((t) => t.auftrag === 'sichern')
  const working = field.filter((t) => t.auftrag !== 'sichern')
  const angemeldet = c.input.trupps.filter((t) => !t.removedAt && t.status === 'angemeldet')
  const ready = angemeldet.filter((t) => t.auftrag === 'sichern')
  const job = (t: Trupp) => [truppAuftragLabel(t.auftrag) ?? '', t.ziel?.trim() ?? ''].filter(Boolean).join(' ') || truppWord(t)
  const jobs = working.map(job)
  // angemeldet for a job and waiting at the entry: «Bereit: Retten 3. OG»
  const waiting = [...new Set(angemeldet.filter((t) => t.auftrag && t.auftrag !== 'sichern').map(job))]
  const value = [...jobs.map((j) => `job|${j}`), ...waiting.map((j) => `ready|${j}`), ...(sitr.length || ready.length ? ['sitr'] : [])].sort()
  const hadTrupps = Array.isArray(c.prev['mass.trupps']) && (c.prev['mass.trupps'] as string[]).length > 0
  if (value.length) {
    const n = working.length
    const list = joinList([...new Set(jobs)])
    const texts: string[] = []
    if (n) texts.push(fillTemplate(n === 1 ? C().truppsOne : C().trupps, { n, list }))
    if (waiting.length) texts.push(fillTemplate(C().bereit, { list: joinList(waiting) }))
    if (sitr.length || ready.length) texts.push(C().sitr)
    const short = [n ? fillTemplate(n === 1 ? C().truppsShortOne : C().truppsShort, { n }) : '', sitr.length || ready.length ? C().sitr : ''].filter(Boolean).join(' ')
    out.push({ key: 'mass.trupps', rule: 'K2', slot: 'massnahmen', tier: 2, value, text: texts.join(' '), short })
  } else if (hadTrupps || c.input.trupps.some((t) => !t.removedAt && t.exitTime && isAs(t))) {
    // every Trupp is out: «Atemschutz beendet» — said once (value [] stays equal afterwards)
    out.push({ key: 'mass.trupps', rule: 'K2', slot: 'massnahmen', tier: 2, value: [], text: C().asEnded })
  }
  const measures: PhraseId[] = ['rekognoszierung', 'erkundungFertig', 'atemschutz', 'entrauchung', 'wasserversorgung', 'pumpen', 'strasseGesperrt', 'verkehrsdienst', 'oelspur', 'brandwache', 'retablierung', 'rueckbau']
  for (const id of measures) {
    if (id === 'atemschutz' && c.input.trupps.some((t) => !t.removedAt && isAs(t))) continue // the Trupps line says it
    const e = lastSaid(c.entries, id)
    if (e) out.push({ key: `mass.${id}`, rule: 'K2', slot: 'massnahmen', tier: 2, value: 'ja', text: `${P()[id]}.` })
  }
  // «Rekognoszierung läuft» is over once «Erkundung abgeschlossen» was said after it
  const rek = out.findIndex((f) => f.key === 'mass.rekognoszierung')
  const fertig = lastSaid(c.entries, 'erkundungFertig')
  if (rek >= 0 && fertig && ms(fertig.at) >= ms(lastSaid(c.entries, 'rekognoszierung')?.at)) out.splice(rek, 1)
  return out
}

/** On scene now: the server's GPS zone where there is one, else the Rapport's clocks. */
function onScene(f: FahrzeugZeit): boolean {
  if (f.gps) return f.gps.zone === 'scene'
  return !!f.vorOrt && !f.zurueck
}

/** K3 — Mittel: vehicles arrived / left since the anchor (the Rapport's Fahrzeugzeiten and the
 *  server's GPS presence), the partners on scene (Bereich symbols, «… vor Ort» entries), a
 *  Nachalarm, and the AdF count when it moved by ≥ 3. */
function ruleMittel(c: Ctx): LageFact[] {
  const out: LageFact[] = []
  const name = (id: string) => c.input.fleet.find((v) => v.id === id)?.label ?? id
  const on = c.input.fahrzeuge.filter(onScene).map((f) => name(f.id))
  const coming = c.input.fahrzeuge.filter((f) => !onScene(f) && f.ausgerueckt && !f.vorOrt && !f.zurueck && !f.gps).map((f) => name(f.id))
  const partners = new Set<string>()
  const orgs = appConfig.symbols.partnerOrgSymbols
  for (const s of c.syms) if (s.symbol && orgs[s.symbol]?.[0] && !doneOf(s)) partners.add(orgs[s.symbol][0])
  const said: [PhraseId, string][] = [['sanitaetVorOrt', 'Sanität'], ['polizeiVorOrt', 'Polizei'], ['nachbarVorOrt', 'Nachbarfeuerwehr']]
  for (const [id, who] of said) if (lastSaid(c.entries, id)) partners.add(who)
  const present = [...new Set([...on, ...partners])].sort()
  const value = [...present, ...[...new Set(coming)].sort().map((n) => `~${n}`)]
  if (value.length) {
    const prev = Array.isArray(c.prev['mittel.vorOrt']) ? (c.prev['mittel.vorOrt'] as string[]) : null
    let text: string
    let short: string
    if (!prev) {
      text = [present.length ? fillTemplate(C().mittelOn, { list: joinList(present) }) : '', coming.length ? fillTemplate(C().mittelComing, { list: joinList(coming) }) : ''].filter(Boolean).join(', ')
      short = fillTemplate(C().mittelShortOn, { n: present.length })
    } else {
      const prevOn = prev.filter((x) => !x.startsWith('~'))
      const added = present.filter((x) => !prevOn.includes(x))
      const left = prevOn.filter((x) => !present.includes(x))
      const newComing = coming.filter((x) => !prev.includes(`~${x}`) && !prevOn.includes(x))
      text = [
        added.length ? fillTemplate(C().mittelNew, { list: joinList(added) }) : '',
        newComing.length ? fillTemplate(C().mittelComing, { list: joinList(newComing) }) : '',
        left.length ? fillTemplate(C().mittelLeft, { list: joinList(left) }) : '',
      ].filter(Boolean).join('; ') || fillTemplate(C().mittelOn, { list: joinList(present) })
      short = fillTemplate(C().mittelShort, { n: added.length })
    }
    out.push({ key: 'mittel.vorOrt', rule: 'K3', slot: 'mittel', tier: 2, value, text: `${text}.`, short: `${short}.` })
  }
  // a Nachalarm the server attached after the anchor («Alarm hinzugefügt (21:30): Gruppe Grün …»)
  for (const r of c.input.rows) {
    if (c.anchor && !(ms(r.at) > c.anchor.at)) continue
    const m = /^Alarm hinzugefügt \(\d{1,2}:\d{2}\): (.+?)(?: — | · |$)/.exec(r.text)
    if (m) out.push({ key: `mittel.nachalarm.${r.id}`, rule: 'K3', slot: 'mittel', tier: 2, value: m[1], text: fillTemplate(C().nachalarm, { title: m[1].trim() }), event: true })
  }
  const n = c.input.present
  if (n > 0) {
    const prevN = typeof c.prev['mittel.adf'] === 'number' ? (c.prev['mittel.adf'] as number) : null
    // a drift below the threshold is not news: the anchor's figure stays what was reported
    const v = prevN != null && Math.abs(n - prevN) < appConfig.lagemeldung.adfDelta ? prevN : n
    out.push({ key: 'mittel.adf', rule: 'K3', slot: 'mittel', tier: 2, value: v, text: fillTemplate(C().adf, { n: v }) })
  }
  return out
}

/** H1 — own Aufträge / Sofortmassnahmen written since the anchor that no rule above read. T3. */
function ruleOrders(c: Ctx, read: ReadonlySet<string>): LageFact[] {
  return c.fresh
    .filter((e) => (e.entryType === 'auftrag' || e.entryType === 'sofort') && !read.has(e.id))
    .map((e) => ({ key: `h1.${e.id}`, rule: 'H1' as const, slot: 'massnahmen' as const, tier: 3 as const, value: e.text, text: /[.!?]$/.test(e.text) ? e.text : `${e.text}.`, event: true, offer: true }))
}

/** H2 — Erinnerungen due within 10′ (not the Lagemeldung's own). T3. */
function ruleReminders(c: Ctx): LageFact[] {
  const lead = appConfig.lagemeldung.reminderLeadMin * 60_000
  return c.input.reminders
    .filter((r) => r.dueAt && !r.purpose && ms(r.dueAt) <= c.input.now + lead)
    .map((r) => ({ key: `h2.${r.id}`, rule: 'H2' as const, slot: 'bedarf' as const, tier: 3 as const, value: r.dueAt!, text: fillTemplate(C().reminderSoon, { text: r.text, t: clock(ms(r.dueAt)) }), event: true, offer: true }))
}

/** K5 — «Nächste Meldung ca. 21:57». Always last, never cut, never diffed. */
function ruleNext(c: Ctx): LageFact[] {
  const next = c.input.next
  if (next === undefined) return []
  return [{ key: 'naechste', rule: 'K5', slot: 'naechste', tier: 2, value: '', text: nextText(next), event: true }]
}

/** The «Nächste» sentence for a time (ms), the handover, or none planned (null). */
export function nextText(next: number | 'handover' | null): string {
  return next === 'handover' ? C().nextHandover : next == null ? C().nextNone : fillTemplate(C().next, { t: clock(next) })
}

/** The «Nächste» line on its own — the composer keeps it out of the draft and swaps it as the EL
 *  picks the rhythm, without re-composing the rest. */
export function nextLine(next: number | 'handover' | null): LageLine {
  const text = nextText(next)
  return { key: 'naechste', rule: 'K5', slot: 'naechste', tier: 2, change: 'neu', score: 0, text, full: text, event: true }
}

function context(input: LageInput, anchor: LageAnchorRef | null): Ctx {
  const entries = input.rows.filter(isEntry).slice().sort((a, b) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id))
  const fresh = anchor ? entries.filter((e) => ms(e.at) > anchor.at) : entries
  return { input, syms: uniqueSymbols(input.symbols), entries, fresh, anchor, prev: anchor?.anchor.facts ?? {} }
}

/** Every fact the record holds right now — rules L2 … K5, H1, H2. Pure. */
export function collectFacts(input: LageInput, anchor: LageAnchorRef | null = null): LageFact[] {
  return collect(context(input, anchor)).facts
}

function collect(c: Ctx): { facts: LageFact[]; superseded: LageHidden[]; windDown: boolean } {
  const hazards = ruleHazards(c)
  const milestone = ruleMilestone(c)
  const facts = [
    ...ruleTruppAlarm(c),
    ...ruleLageCore(c, milestone.windDown),
    ...milestone.facts,
    ...ruleVermisst(c),
    ...ruleGerettet(c),
    ...ruleGeraeumt(c),
    ...hazards,
    ...ruleBuilding(c),
    ...ruleWind(c, hazards.length > 0),
    ...ruleMassnahmen(c),
    ...ruleMittel(c),
    ...ruleBedarf(c),
  ]
  // the orders a phrase rule already read are not offered a second time (H1)
  const phrases = Object.values(P())
  const read = new Set(c.fresh.filter((e) => phrases.some((p) => says(e, p))).map((e) => e.id))
  facts.push(...ruleOrders(c, read), ...ruleReminders(c), ...ruleNext(c))
  return { facts, superseded: milestone.superseded, windDown: milestone.windDown }
}

// ── 2. the diff ─────────────────────────────────────────────────────────────────────────────────

function rankOf(f: LageFact, v: LageValue | undefined): number {
  return typeof v === 'string' && f.ranks ? f.ranks.indexOf(v) : -1
}

/** How the fact moved since the anchor. Pure. */
export function changeOf(f: LageFact, prev: LageValue | undefined, hasAnchor: boolean): LageChange {
  if (!hasAnchor || f.event) return 'neu'
  if (prev === undefined) return 'neu'
  if (sameValue(f.value, prev)) return 'gleich'
  if (f.trend === 'count-worse' && typeof f.value === 'number' && typeof prev === 'number') return f.value > prev ? 'schlechter' : 'besser'
  if (f.trend === 'count-better' && typeof f.value === 'number' && typeof prev === 'number') return f.value > prev ? 'besser' : 'schlechter'
  if (f.trend === 'list-worse' && Array.isArray(f.value) && Array.isArray(prev) && f.value.length !== prev.length) {
    return f.value.length > prev.length ? 'schlechter' : 'besser'
  }
  if (f.trend === 'rank') {
    const a = rankOf(f, prev)
    const b = rankOf(f, f.value)
    if (a >= 0 && b >= 0 && a !== b) return b > a ? 'besser' : 'schlechter'
  }
  return 'neu'
}

function toLine(f: LageFact, change: LageChange, order: number): LageLine {
  return {
    key: f.key, rule: f.rule, slot: f.slot, tier: f.tier, change, order,
    score: TIER_BASE[f.tier] + CHANGE_BONUS[change] + (f.boost ?? 0),
    text: f.text, full: f.text, short: f.short, tag: f.tag, value: f.value, event: f.event,
  }
}

/** The ERLEDIGT line for a fact that WAS said and is gone now — or null for the facts whose
 *  disappearance is not news (a replaced value is a new value, not a finished one). */
function erledigt(key: string, value: LageValue): LageLine | null {
  const mk = (slot: LageSlot, tier: LageTier, text: string): LageLine => ({
    key, rule: 'EL', slot, tier, change: 'erledigt', score: TIER_BASE[tier] + CHANGE_BONUS.erledigt, text, full: text,
  })
  const s = typeof value === 'string' ? value : ''
  if (key.startsWith('as.alarm.')) return mk('zuerst', 1, fillTemplate(C().truppEnded, { trupp: s.split('|')[1] || C().truppBare }))
  if (key === 'pers.vermisst') return mk('menschen', 1, C().keineVermissten)
  if (key.startsWith('hz.un.')) return mk('gefahren', 1, fillTemplate(C().unDone, { un: s.split('|')[0] }))
  if (key.startsWith('hz.sym.')) return mk('gefahren', 1, fillTemplate(C().hazardDone, { label: s }))
  if (key.startsWith('bedarf.')) return mk('bedarf', 1, fillTemplate(C().bedarfDone, { text: s.replace(/[.!?]$/, '') }))
  return null
}

const lineOrder = (a: LageLine, b: LageLine) =>
  SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || a.tier - b.tier
  || (a.order ?? Infinity) - (b.order ?? Infinity) || b.score - a.score || a.key.localeCompare(b.key)

/**
 * Facts now vs. the anchor → the lines to say and the ones to hide, each hidden one with its reason.
 *
 *   NEU — a key the anchor did not have (or an event since the anchor)
 *   SCHLECHTER / BESSER — an ordered value moved (count, list length, rank)
 *   ERLEDIGT — a key that was said and is gone (a sign marked erledigt, the last Vermisste found)
 *   = gleich — unchanged: hidden («unverändert seit 21:17»), EXCEPT tier 0, which is said every
 *     time while it lasts. In «Vollständig» nothing is hidden for being unchanged (S9 off).
 * A fact the EL unticked last time (`declined`) stays quiet while unchanged — tier 0 excepted.
 */
export function diffFacts(facts: readonly LageFact[], anchor: LageAnchorRef | null, mode: LageMode): { lines: LageLine[]; hidden: LageHidden[] } {
  const prev = anchor?.anchor.facts ?? {}
  const declined = new Set(anchor?.anchor.declined ?? [])
  const at = anchor ? clock(anchor.at) : ''
  const lines: LageLine[] = []
  const hidden: LageHidden[] = []
  for (const [i, f] of facts.entries()) {
    const change = changeOf(f, prev[f.key], !!anchor)
    const line = toLine(f, change, i)
    if (f.offer) { hidden.push({ key: f.key, text: f.text, reason: 'offer', line }); continue }
    if (f.tier > 0 && change === 'gleich' && f.slot !== 'naechste') {
      if (declined.has(f.key)) { hidden.push({ key: f.key, text: f.text, reason: 'declined', detail: at, line }); continue }
      if (mode === 'seit') { hidden.push({ key: f.key, text: f.text, reason: 'gleich', detail: at, line }); continue }
    }
    lines.push(line)
  }
  if (anchor) {
    const now = new Set(facts.map((f) => f.key))
    const gone = Object.keys(prev).filter((k) => !now.has(k) && !declined.has(k))
    const bedarfNow = facts.some((f) => f.slot === 'bedarf' && !f.offer)
    const bedarfGone = gone.filter((k) => k.startsWith('bedarf.'))
    if (bedarfGone.length && !bedarfNow) {
      // every need was met: one line, «Bedarf: keiner mehr»
      lines.push({ key: 'bedarf.none', rule: 'EL', slot: 'bedarf', tier: 1, change: 'erledigt', score: TIER_BASE[1] + CHANGE_BONUS.erledigt, text: C().bedarfNone, full: C().bedarfNone })
    }
    for (const k of gone) {
      if (k.startsWith('bedarf.') && !bedarfNow) continue
      const l = erledigt(k, prev[k])
      if (l) lines.push(l)
    }
  }
  return { lines: lines.sort(lineOrder), hidden }
}

// ── 3. the budget ───────────────────────────────────────────────────────────────────────────────

/** The radio text of a set of lines: one sentence group per slot, in print order; «Nächste» last,
 *  without its label. */
export function radioText(lines: readonly Pick<LageLine, 'slot' | 'text'>[], sep = '\n'): string {
  const bySlot = new Map<LageSlot, string[]>()
  for (const l of lines) {
    const t = l.text.trim()
    if (!t) continue
    bySlot.set(l.slot, [...(bySlot.get(l.slot) ?? []), t])
  }
  const out: string[] = []
  for (const s of SLOT_ORDER) {
    const xs = bySlot.get(s)
    if (!xs) continue
    out.push(s === 'naechste' ? xs.join(' ') : `${C().slots[s]}: ${xs.join(' ')}`)
  }
  return out.join(sep)
}

/**
 * Fit the radio: over the budget, tier-2 lines switch to their short form first (lowest score
 * first), and only then the lowest-scoring line drops into «Ausgeblendet · über Funklänge».
 * Tier 0 is never cut; tier 0 and 1 are never shortened; «Nächste» always stays.
 */
export function fitBudget(lines: readonly LageLine[], budgetWords: number): { lines: LageLine[]; hidden: LageHidden[] } {
  let kept = lines.map((l) => ({ ...l }))
  const words = () => wordCount(radioText(kept))
  const byScore = (a: LageLine, b: LageLine) => a.score - b.score || b.key.localeCompare(a.key)
  for (const l of kept.filter((x) => x.tier === 2 && x.short && x.slot !== 'naechste').sort(byScore)) {
    if (words() <= budgetWords) break
    l.text = l.short!
    l.shortened = true
  }
  const hidden: LageHidden[] = []
  while (words() > budgetWords) {
    const victim = kept.filter((x) => x.tier > 0 && x.slot !== 'naechste').sort(byScore)[0]
    if (!victim) break
    kept = kept.filter((x) => x !== victim)
    hidden.push({ key: victim.key, text: victim.full, reason: 'budget', line: { ...victim, text: victim.full, shortened: false } })
  }
  return { lines: kept, hidden }
}

// ── routine: what was folded away, said as counts ───────────────────────────────────────────────

function routine(c: Ctx): LageHidden[] {
  const rows = c.anchor ? c.input.rows.filter((r) => ms(r.at) > c.anchor!.at) : c.input.rows
  const out: LageHidden[] = []
  let symbols = 0
  let photos = 0
  let team = 0
  for (const r of rows) {
    if (r.kind === 'symbol' || r.kind === 'layer' || r.kind === 'snapshot') symbols++
    else if (r.kind === 'photo' || r.photoUrl || r.photoUrls?.length) photos++
    else if (r.kind === 'team') team++
  }
  if (team) out.push({ key: 'routine.team', text: team === 1 ? C().routineTeamOne : fillTemplate(C().routineTeam, { n: team }), reason: 'routine' })
  if (symbols) out.push({ key: 'routine.symbols', text: symbols === 1 ? C().routineSymbolsOne : fillTemplate(C().routineSymbols, { n: symbols }), reason: 'routine' })
  if (photos) out.push({ key: 'routine.photos', text: photos === 1 ? C().routinePhotosOne : fillTemplate(C().routinePhotos, { n: photos }), reason: 'routine' })
  if (c.fresh.some((e) => says(e, P().elUebernommen))) out.push({ key: 'routine.el', text: C().routineElTaken, reason: 'routine' })
  if (!c.anchor && c.input.alarmText?.trim()) out.push({ key: 'routine.dispatch', text: C().routineDispatch, reason: 'dispatch' })
  return out
}

// ── the whole draft ─────────────────────────────────────────────────────────────────────────────

/** The draft for «now»: collect → diff → fit. Pure; the same input gives the same draft anywhere. */
export function composeLagemeldung(input: LageInput, opts: { mode: LageMode; anchor: LageAnchorRef | null; budgetWords?: number }): LageDraft {
  const c = context(input, opts.anchor)
  const { facts, superseded, windDown } = collect(c)
  const diff = diffFacts(facts, opts.anchor, opts.mode)
  const fit = fitBudget(diff.lines, opts.budgetWords ?? appConfig.lagemeldung.budgetWords)
  return {
    mode: opts.mode,
    first: !opts.anchor,
    anchorAt: opts.anchor?.at ?? null,
    lines: fit.lines,
    hidden: [...fit.hidden, ...diff.hidden, ...superseded, ...routine(c)],
    windDown,
  }
}

/** «5 Änderungen, 1 dringend» — the due row's own count, so the EL knows before opening whether
 *  it is a long or a short call. Changes = lines that are not merely repeated; dringend = tier 0. */
export function changeSummary(draft: Pick<LageDraft, 'lines'>): { changes: number; urgent: number } {
  const real = draft.lines.filter((l) => l.slot !== 'naechste' && l.change !== 'gleich')
  return { changes: real.length, urgent: draft.lines.filter((l) => l.tier === 0).length }
}

// ── what the EL did with the draft, and what is stored ──────────────────────────────────────────

/** The EL's hand on the draft: ticks, edited wordings, added hidden items, own lines. */
export interface LageEdits {
  /** key → ticked. Absent = the draft's default (shown lines ticked). */
  ticked?: Record<string, boolean>
  /** key → the edited wording; the line keeps its key, so the diff still works next time */
  text?: Record<string, string>
  /** hidden items brought back, by key */
  added?: string[]
  /** the EL's own lines, in the «Zusatz» slot */
  own?: string[]
}

/** The lines as they will be said: the draft's lines plus the added hidden ones, ticks and
 *  wordings applied, in print order. Unticked lines are returned with `ticked: false`. */
export function finalLines(draft: LageDraft, edits: LageEdits): (LageLine & { ticked: boolean })[] {
  const added = new Set(edits.added ?? [])
  const fromHidden = draft.hidden.filter((h) => h.line && added.has(h.key)).map((h) => h.line!)
  // keyed by the line's place in `edits.own`, so an empty line being typed keeps its key
  const own: LageLine[] = (edits.own ?? []).flatMap((raw, i) => {
    const t = raw.trim()
    if (!t) return []
    const text = /[.!?]$/.test(t) ? t : `${t}.`
    return [{ key: `own.${i}`, rule: 'EL' as const, slot: 'zusatz' as const, tier: 1 as const, change: 'neu' as const, score: 0, text, full: text, order: i }]
  })
  return [...draft.lines, ...fromHidden, ...own]
    .map((l) => {
      const edited = edits.text?.[l.key]
      const text = edited != null && edited.trim() ? edited.trim() : l.text
      const ticked = edits.ticked?.[l.key] ?? true
      return { ...l, text, ticked }
    })
    .sort(lineOrder)
}

/**
 * What the sent row stores: the fingerprint of every fact that was SAID, the facts that stayed
 * hidden because they were unchanged (still what was reported — carried forward from the old
 * anchor), and the ones the EL deliberately unticked (`declined`, with their current value).
 * Facts the budget pushed out, T3 offers and events are not stored: never said, they get another
 * chance next time.
 */
export function anchorFor(draft: LageDraft, edits: LageEdits, prev: LageAnchorRef | null): LageAnchor {
  const facts: Record<string, LageValue> = {}
  const declined: string[] = []
  const lines = finalLines(draft, edits)
  for (const l of lines) {
    if (l.event || l.value === undefined || l.rule === 'EL' || l.slot === 'naechste') continue
    if (l.ticked) facts[l.key] = l.value
    else { facts[l.key] = l.value; declined.push(l.key) }
  }
  for (const h of draft.hidden) {
    if (!h.line || h.line.event || h.line.value === undefined) continue
    if (facts[h.key] !== undefined) continue
    if (h.reason === 'gleich' && prev && prev.anchor.facts[h.key] !== undefined) facts[h.key] = prev.anchor.facts[h.key]
    if (h.reason === 'declined' && prev && prev.anchor.facts[h.key] !== undefined) {
      facts[h.key] = prev.anchor.facts[h.key]
      declined.push(h.key)
    }
  }
  return declined.length ? { v: 1, mode: draft.mode, facts, declined: declined.sort() } : { v: 1, mode: draft.mode, facts }
}
