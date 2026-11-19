// The Atemschutz tag (19.11.2026, owner: «quickly add all people to a Trupp based on an external
// tag»): each AdF carries a plastic tag with a QR code, and «Scan» beside «Person suchen» reads
// the whole Trupp's tags in one camera frame (components/TagScan). This module is the code's
// FORMAT and what one decoded code MEANS for the form – no camera, no React.
//
// ⚠️ The code carries the roster Person id and nothing else: no name, no rank (those are printed
// beside it for people – admin · tagPrint). A rename or a new rank never needs a new code, and
// there is no second id table to keep in sync – the roster id already survives a Divera sync
// (backend · personnel reconcile by external id).
// The version in the prefix is what lets the format change later without misreading old tags.

import type { Person } from '../types'

export const TAG_PREFIX = 'KPF1:'

/** The text a tag's QR code encodes for one person (admin · tagPrint). */
export const tagPayload = (personId: string) => `${TAG_PREFIX}${personId}`

/** The Person id on a decoded code, or undefined for a code that is not ours (a parcel label, a
 *  menu card). */
export function personIdFromTag(text: string): string | undefined {
  if (!text.startsWith(TAG_PREFIX)) return undefined
  const id = text.slice(TAG_PREFIX.length).trim()
  return id || undefined
}

/**
 * What one scanned tag does to the Trupp being formed:
 *  · `add`     – an active roster person, free to go: into the Trupp.
 *  · `taken`   – in another ACTIVE Trupp: shown, not added – one person, one Trupp, exactly what
 *                the picker greys out (TruppTeam · `assignedIds`).
 *  · `here`    – already standing in this form: nothing to do, and nothing to say either.
 *  · `unknown` – our code, but no active roster row (left the Wehr, a tag of another station).
 */
export type TagHit =
  | { kind: 'add' | 'taken' | 'here'; person: Person }
  | { kind: 'unknown'; id: string }

/** Reads one decoded code against the roster. `null` = not a tag of ours, ignored. */
export function tagHit(text: string, roster: ReadonlyMap<string, Person>, assignedIds: ReadonlySet<string>, chosenIds: ReadonlySet<string>): TagHit | null {
  const id = personIdFromTag(text)
  if (!id) return null
  const person = roster.get(id)
  if (!person?.active || person.guest) return { kind: 'unknown', id }
  if (chosenIds.has(id)) return { kind: 'here', person }
  if (assignedIds.has(id)) return { kind: 'taken', person }
  return { kind: 'add', person }
}

/** The stable key of a hit, so one tag seen in thirty frames is one row. */
export const tagHitKey = (h: TagHit) => (h.kind === 'unknown' ? `?${h.id}` : h.person.id)

/** One CSV line per person for whoever makes their own tags (a label program, a print shop):
 *  name, Dienstgrad and the exact text the QR code must hold (admin › «Tags drucken»). UTF-8 with
 *  a BOM, so Excel opens «Šimunović» as written. */
export function tagsCsv(people: { id: string; name: string; rank: string }[]): string {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`
  // a name or rank that starts like a formula (`=`, `+`, `-`, `@`) would RUN in Excel even quoted:
  // a leading apostrophe makes it text. The QR text stays verbatim – it is what gets encoded.
  const text = (v: string) => cell(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)
  const rows = people.map((p) => [text(p.name), text(p.rank), cell(tagPayload(p.id))].join(','))
  return `\uFEFF${['name', 'rank', 'qr'].join(',')}\n${rows.join('\n')}\n`
}
