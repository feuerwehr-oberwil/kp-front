// «Alarm aktualisiert» – what the Meldeleiste row says about a pending Divera update (the server's
// diff: backend app/alarm_update). Pure, so the row's words are testable without the strip.
//
// The row (Mock Variante A, 15.11.2026): old → new per changed field, the new parts emphasised;
// the Meldung as the full new text with what is new marked. A field the crew changed by hand
// keeps its value and the row says so – «Adresse bleibt … (von euch) · Alarm neu: …» – and the
// filled button names only what it will take.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import type { MeldungSpan } from './meldungen'
import type { AlarmUpdate, AlarmUpdateField } from './incidents'

// words and the punctuation between them, separators kept, so a diff can splice the original text
const tokens = (s: string): string[] => s.split(/(\s+|[,;.])/).filter(Boolean)

/** The common head, the old middle, the new middle and the common tail of two texts, by word. */
function splitDiff(from: string, to: string): { head: string; was: string; now: string; tail: string } {
  const a = tokens(from)
  const b = tokens(to)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let j = 0
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  return {
    head: a.slice(0, i).join(''),
    was: a.slice(i, a.length - j).join('').trim(),
    now: b.slice(i, b.length - j).join('').trim(),
    tail: a.slice(a.length - j).join(''),
  }
}

/** `to` in full with what `from` lacked marked new – the Meldung, and a kept field's alarm value. */
export function markNew(from: string, to: string): MeldungSpan[] {
  const d = splitDiff(from, to)
  if (!d.now) return [to]
  // the middle as it stands in `to`, with the separator that leads it («, Person vermisst»)
  const mid = to.slice(d.head.length, to.length - d.tail.length)
  return [d.head, { ins: mid }, d.tail].filter((s) => s !== '')
}

/** One line «old → new» in place: the replaced words struck, the new ones marked. */
export function inlineDiff(from: string, to: string): MeldungSpan[] {
  const d = splitDiff(from, to)
  const out: MeldungSpan[] = [d.head]
  if (d.was) out.push({ del: d.was })
  if (d.was && d.now) out.push(' ')
  if (d.now) out.push({ ins: d.now })
  out.push(d.tail)
  return out.filter((s) => s !== '')
}

/** One field's part of the row. */
function fieldLine(f: AlarmUpdateField): MeldungSpan[] {
  const C = appConfig.copy.intake.alarmUpdate
  const label = C.fields[f.field] ?? f.field
  const current = f.current ?? '–'
  const alarm = f.alarm ?? '–'
  if (f.edited) {
    return [`${fillTemplate(C.keeps, { field: label })} `, { b: current }, ` ${C.byHand} · ${C.alarmNew} `, ...markNew(current, alarm)]
  }
  return [`${label} `, ...(f.field === 'text' ? markNew(current, alarm) : inlineDiff(current, alarm))]
}

export interface AlarmUpdateRow {
  title: string
  sub: MeldungSpan[]
  sub2?: MeldungSpan[]
  /** the filled button's label, or null when every changed field was edited by hand */
  takeLabel: string | null
}

/** The row for one pending update: address and Stichwort on the first line, the Meldung on the
 *  second (or alone on the first). `einsatzTitle` names the row when the alarm carries no title. */
export function alarmUpdateRow(u: AlarmUpdate, einsatzTitle: string): AlarmUpdateRow {
  const C = appConfig.copy.intake.alarmUpdate
  // the Einsatzart – the part of an alarm title before the first comma (backend divera · _einsatzart)
  const kind = (u.title || einsatzTitle).split(',')[0].trim()
  const head = u.fields.filter((f) => f.field !== 'text')
  const text = u.fields.find((f) => f.field === 'text')
  const join = (fs: AlarmUpdateField[]) => fs.flatMap((f, i) => (i ? [' · ', ...fieldLine(f)] : fieldLine(f)))
  const lines = [head.length ? join(head) : null, text ? fieldLine(text) : null].filter((l) => l != null)
  const untouched = u.fields.filter((f) => !f.edited)
  const takeLabel = untouched.length === 0 ? null
    : untouched.length === u.fields.length ? C.take
    : fillTemplate(C.takeSome, { fields: untouched.map((f) => C.fields[f.field] ?? f.field).join(' + ') })
  return { title: `${C.title} – ${kind}`, sub: lines[0] ?? [], sub2: lines[1], takeLabel }
}
