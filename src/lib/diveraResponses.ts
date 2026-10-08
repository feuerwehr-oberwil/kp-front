// The Anwesenheit's «Anrückend» block, as data: the Divera Rückmeldungen of this Einsatz laid
// over the Mannschaft and over who is already here.
//
// ⚠️ A Divera answer is NEVER presence. This module only sorts the answers into what the block
// shows; somebody is anwesend once a person on the scene taps «da», which is the ordinary
// attendance write (useAttendanceActions · markPresent) and nothing here.
import type { AttendanceState, Person } from '../types'
import type { DiveraAnswer, DiveraResponseKind, DiveraResponses } from './api/divera'

export interface AnrueckendRow {
  person: Person
  kind: DiveraResponseKind
  /** the Einheit's own word for the answer («Komme in 10 min»); empty when it could not be named */
  statusName: string
  statusId: number
  answeredAt: string | null
  /** an ESTIMATE (answer + the status's minutes), shown as «ca.» */
  eta: string | null
  note: string
}

export interface Anrueckend {
  /** every answer, whoever gave it — the head line («9 kommen · 2 kommen nicht») */
  counts: Record<DiveraResponseKind, number>
  /** answered and already recorded here (anwesend, or here and gone again) */
  here: number
  /** addressed by the alarm and not answered (yet) */
  unanswered: number
  /** said they come, not recorded yet — soonest first */
  coming: AnrueckendRow[]
  /** said they DON'T come — their own, muted group; still tappable (a misclick happens) */
  notComing: AnrueckendRow[]
  /** an answer that is neither («Rückruf erbeten») */
  other: AnrueckendRow[]
  /** answers from somebody the Mannschaftsliste does not know (never synced, or a guest) */
  unmapped: number
  updatedAt: string | null
}

/** Divera user id → roster person, through the `divera` external identity. */
export function personByDiveraId(people: Person[]): Map<string, Person> {
  const out = new Map<string, Person>()
  for (const p of people) {
    for (const ident of p.externalIdentities ?? []) {
      if (ident.provider === 'divera' && ident.externalId) out.set(String(ident.externalId), p)
    }
  }
  return out
}

const byTime = (a: string | null, b: string | null) => (a ?? '￿').localeCompare(b ?? '￿')

export function buildAnrueckend(
  resp: DiveraResponses | null | undefined,
  people: Person[],
  attendance: AttendanceState,
): Anrueckend | null {
  if (!resp?.available) return null
  const answers: DiveraAnswer[] = resp.answers ?? []
  const names = new Map((resp.statuses ?? []).map((s) => [s.id, s.name]))
  const roster = personByDiveraId(people)
  const counts: Record<DiveraResponseKind, number> = { coming: 0, not_coming: 0, other: 0 }
  const coming: AnrueckendRow[] = []
  const notComing: AnrueckendRow[] = []
  const other: AnrueckendRow[] = []
  let here = 0
  let unmapped = 0
  for (const a of answers) {
    const kind: DiveraResponseKind = a.kind === 'coming' || a.kind === 'not_coming' ? a.kind : 'other'
    counts[kind]++
    const person = roster.get(String(a.ucr_id))
    if (!person) { unmapped++; continue }
    // Recorded here in ANY state — anwesend, or here and gone again. Either way the Anwesenheit
    // below already carries them; listing them again as «anrückend» would be a second, stale row.
    if (attendance[person.id]) { here++; continue }
    const row: AnrueckendRow = {
      person, kind, statusId: a.status_id, statusName: names.get(a.status_id) ?? '',
      answeredAt: a.answered_at, eta: kind === 'coming' ? a.eta : null, note: a.note ?? '',
    }
    if (kind === 'coming') coming.push(row)
    else if (kind === 'not_coming') notComing.push(row)
    else other.push(row)
  }
  // who is here first: the estimate where there is one, else the moment they answered
  coming.sort((a, b) => byTime(a.eta ?? a.answeredAt, b.eta ?? b.answeredAt)
    || a.person.displayName.localeCompare(b.person.displayName, 'de'))
  const byName = (a: AnrueckendRow, b: AnrueckendRow) => a.person.displayName.localeCompare(b.person.displayName, 'de')
  notComing.sort(byName)
  other.sort(byName)
  return {
    counts, here, unmapped,
    unanswered: resp.counts?.unanswered ?? 0,
    coming, notComing, other,
    updatedAt: resp.updated_at ?? null,
  }
}
