// The Meldeleiste's model: what a message IS, and which one gets the row.
//
// What this replaces was not a stack but a PILE: five banners anchored 4px apart on the same
// axis with no awareness of each other, so the z-index decided who could be read — and it
// decided wrong. The 700px «Einsatzdaten prüfen» card (z 57) covered the 440px due-Wiedervorlage
// card (z 45) completely, i.e. the one message whose whole doctrine is «stays up until handled —
// the 3am rule» was the least visible thing on the screen.
//
// The rule here is CLASS BEFORE TIME: what stays until somebody acts always outranks what goes
// away by itself, whatever arrived last. That is what makes «Update bereit» structurally
// incapable of covering an overdue Wiedervorlage — by construction, not by luck.

/** Colour class of a message. Drives the left edge, the glyph and the +n pill; never the
 *  ranking (a `warn`-toned Prüfen row does not overtake a due Wiedervorlage). */
export type MeldungTone = 'alarm' | 'warn' | 'info' | 'calm'

/** The ranking, and the whole design in seven lines. Lower gets the row; the rest queue behind
 *  the +n pill. Adding a kind means deciding, once, where it stands — which is the point. */
export const MELDUNG_RANK = {
  /** a fresh dispatch, or an Einsatz that appeared without a human in the loop */
  alarm: 1,
  /** a Wiedervorlage that has come due — persists until erledigt, never expires silently */
  reminder: 2,
  /** a vehicle a drawn Leitung is attached to has driven off; its anchor is off-screen */
  gps: 3,
  /** the alarm source's guesses have not been checked yet */
  review: 4,
  /** another tab of this browser holds the edit lock */
  tabLock: 5,
  /** a new build is waiting for the next app start */
  update: 6,
  /** «KP Front als App installieren» */
  install: 7,
} as const

export type MeldungKind = keyof typeof MELDUNG_RANK

/** Ranks 1–2 are the messages that mean somebody is waiting on a decision. They can displace
 *  EACH OTHER (that is what a pin is for) — nothing below them ever can. */
export const PROTECTED_RANK = 2

/** One button in the row. Two at most: the third action of any message is the row itself. */
export interface MeldungAction {
  label: string
  icon?: string
  /** spin the glyph — the action is running (taking an alarm reaches the server) */
  busy?: boolean
  onClick: () => void
  /** the row's one filled action (AGENTS.md button spec) */
  primary?: boolean
  disabled?: boolean
}

/** A message, as a record. Every banner this layer replaced used to be a component with its own
 *  geometry, z-index and live region; now each is one of these and the strip owns all three. */
export interface Meldung {
  /** stable per source — the reminder's row keeps its identity while its text changes */
  id: string
  kind: MeldungKind
  tone: MeldungTone
  /** sprite id from lib/icons */
  icon: string
  title: string
  sub?: string
  actions?: MeldungAction[]
  /** tapping the row itself — the reminder's «In Verlauf öffnen» is exactly this */
  onOpen?: () => void
  /** the ✕. Present only where waving the message away is legitimate: a due Wiedervorlage can
   *  be erledigt or verschoben, never dismissed. */
  dismiss?: { label: string; onClick: () => void }
}

export interface RankedMeldungen {
  /** the one message on the strip; null means the strip does not exist */
  lead: Meldung | null
  /** everything else, best first — reachable through the +n pill, never paged past */
  queue: Meldung[]
  /** tone of the highest-ranked WAITING message, so a queued warning is announced by the pill
   *  instead of hiding behind a neutral counter. Null when nothing waits. */
  pillTone: MeldungTone | null
}

/**
 * Rank the published messages and pick the one that gets the row.
 *
 * `pinnedId` is the operator pulling a queued row forward (tapping it in the open list). The pin
 * holds against rank 3+ and between the two protected ranks — pulling the due Wiedervorlage in
 * front of an alarm is a deliberate, legitimate move. It never holds a calm message in front of
 * either of them: a pin is a preference, and rank 1–2 is not negotiable.
 */
export function rankMeldungen(items: readonly Meldung[], pinnedId?: string | null): RankedMeldungen {
  if (items.length === 0) return { lead: null, queue: [], pillTone: null }
  // Array.prototype.sort is stable, so inside one kind the publication order (= arrival) holds:
  // class decides first, time only breaks the tie.
  const sorted = [...items].sort((a, b) => MELDUNG_RANK[a.kind] - MELDUNG_RANK[b.kind])
  const best = sorted[0]
  const pinned = pinnedId != null ? sorted.find((m) => m.id === pinnedId) : undefined
  const lead = pinned != null
    && (MELDUNG_RANK[pinned.kind] <= PROTECTED_RANK || MELDUNG_RANK[best.kind] > PROTECTED_RANK)
    ? pinned
    : best
  const queue = sorted.filter((m) => m !== lead)
  return { lead, queue, pillTone: queue[0]?.tone ?? null }
}
