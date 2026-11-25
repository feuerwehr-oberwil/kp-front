// The Meldeleiste's model: what a message IS, and in which order the messages stand.
//
// What this replaces was not a stack but a PILE: five banners anchored 4px apart on the same
// axis with no awareness of each other, so the z-index decided who could be read — and it
// decided wrong. The 700px «Einsatzdaten prüfen» card (z 57) covered the 440px due-Wiedervorlage
// card (z 45) completely, i.e. the one message whose whole doctrine is «stays up until handled —
// the 3am rule» was the least visible thing on the screen.
//
// The rule here is CLASS BEFORE TIME: what stays until somebody acts always outranks what goes
// away by itself, whatever arrived last. That is what makes «Update bereit» structurally
// incapable of standing above an overdue Wiedervorlage — by construction, not by luck.

import type { MenuActionItem, MenuHeading, MenuSeparator } from './overlays/Menu'

/** Colour class of a message. Drives the row's left edge and its glyph; never the order (a
 *  `warn`-toned Prüfen row does not overtake a due Wiedervorlage). */
export type MeldungTone = 'alarm' | 'warn' | 'info' | 'calm'

/** The ranking, and the whole design in a dozen lines. Lower stands higher on the strip. Adding a
 *  kind means deciding, once, where it stands — the point. */
export const MELDUNG_RANK = {
  /** an Atemschutznotfall — somebody HELD «Notfall» on a Trupp (F1, 08.10.2026). A person said a
   *  crew is in distress, which outranks every clock: above the überfällig/Alarmdruck row, above
   *  a fresh dispatch, above everything. Its own kind so the alarm rows' bookkeeping (one row per
   *  reason, «Zum Trupp» takes it down) never touches it — this row stays until «Notfall beendet». */
  notfall: 0,
  /** an Atemschutztrupp is überfällig or has reached its Alarmdruck — the audible alarm's own
   *  row, and the ONLY message on this strip about somebody who can die in the next minutes.
   *  It outranks the dispatch on purpose: a fresh alarm can wait twenty seconds, a Trupp out of
   *  contact cannot, and it belongs to the Einsatz the operator is already in. Its own kind
   *  rather than `alarm` so `useMeldungKindPending('alarm')` keeps meaning «a dispatch is
   *  waiting to be taken» — see ReviewBanner, which must not blink out and back every time a
   *  contact clock runs over. */
  atemschutz: 1,
  /** a fresh dispatch, or an Einsatz that appeared without a human in the loop */
  alarm: 2,
  /** the Einsatz on screen was closed — or reopened — on ANOTHER device (N3, 25.09.2026): the
   *  screen just changed from live to read-only (or back) under the operator's hands, and the row
   *  says why — above everything that belongs to the Einsatz itself */
  lifecycle: 3,
  /** local storage is full (S1, 20.10.2026): what is typed now is NOT saved on this device and is
   *  lost when the app closes — the one state that loses work. Right after the lifecycle row and
   *  above everything about the Einsatz's content; below the Notfall and Atemschutz rows (a
   *  person) and a fresh dispatch (the strip's whole reason to exist). No ✕: it stays while true. */
  storage: 4,
  /** an act the operator just tapped was REFUSED («Erst «Notfall beendet» halten …») – on a
   *  surface with no toasts, the Atemschutz-Link (FEEDBACK.1, 17.11.2026, lib/meldungenRefusal):
   *  a refusal is never a silent tap. Right under what blocks work; it answers the hand that is
   *  still on the screen. */
  refused: 5,
  /** an Atemschutz-Trupp is inside and no Sicherungstrupp stands ready (FEEDBACK.1, 17.11.2026 –
   *  components/SafetyMissingMeldung): a standing fact about the people inside, so above every
   *  row about the Einsatz's content; below the alarms, a dispatch and what loses work. */
  safety: 6,
  /** a Wiedervorlage that has come due — persists until erledigt, never expires silently */
  reminder: 7,
  /** the wind has turned (≥ 45° at ≥ 10 km/h, held over two readings) — the server observed it
   *  and wrote the Verlauf row; this is that row, once per device (24.09.2026, D2). Above the
   *  GPS-follow row: a Lüfter blowing the wrong way is about the crew inside. */
  wind: 8,
  /** a vehicle a drawn Leitung is attached to has driven off; its anchor is off-screen */
  gps: 9,
  /** the alarm source's guesses have not been checked yet */
  review: 10,
  /** the Einsatz's saved data came from a NEWER build, or had entries the load gate skipped
   *  (useWorkspaceBlob, S3 20.10.2026) — true for as long as this build reads that blob */
  workspace: 11,
  /** a closed Einsatz's Fotos / Sprachnotizen are still only on this device (useIncidentLifecycle · completeRapport,
   *  S3 20.10.2026) — stands while the queue holds them */
  media: 12,
  /** another tab of this browser holds the edit lock */
  tabLock: 13,
  /** the tactical symbol pack failed to load — Karte and Kroki run without glyphs */
  symbols: 14,
  /** offline with no cached basemap for this view — the map is a flat colour */
  basemap: 15,
  /** the session cookie expired — the sync is standing still until the operator signs in again.
   *  Also the row about ANOTHER account's unsent edits parked on this device
   *  (ForeignUnsentMeldung, sweep 09.11.2026 UX.2): the same subject — work that waits for a
   *  sign-in — and the same standing, below everything about the Einsatz itself. */
  session: 16,
  /** a new build is waiting for the next app start */
  update: 17,
  /** «KP Front als App installieren» */
  install: 18,
} as const

export type MeldungKind = keyof typeof MELDUNG_RANK

/** One button in the row. Two at most — and, together with the ✕ and the row's title where it has
 *  an `onOpen`, the ONLY things in a row that do anything: the rest of the body is inert (see
 *  `Meldeleiste`). WORD ONLY (button sweep SHEETS.4, 17.11.2026): the row's leading glyph already
 *  carries its tone, and a row where two buttons had a glyph and the third none read the bare one
 *  as lesser – so there is no `icon` to set. Only a busy loader takes the glyph slot. */
export type MeldungAction = {
  label: string
  /** a loader leads the word — the action is running (taking an alarm reaches the server) */
  busy?: boolean
  /** the row's one filled action (docs/ui-conventions.md · Buttons) */
  primary?: boolean
  /** a primary whose move KEEPS things safely as they are, filled green like the Atemschutz
   *  «Eintritt» (`--green`) — «Am Einsatzort lassen» (GpsFollowMeldung, D3-a). Only with `primary`. */
  go?: boolean
  disabled?: boolean
} & (
  | { onClick: () => void; menu?: never }
  /** …or the button OPENS a menu of these rows instead of acting itself – a choice that belongs to
   *  the row (the missing Sicherungstrupp's «Bestimmen», lib/safetyPick) */
  | { menu: (MenuActionItem | MenuHeading | MenuSeparator)[]; onClick?: never }
)

/** A piece of a sub-line: plain text, or a word the row emphasises – `ins` what is new, `del`
 *  what it replaces, `b` a value to read (the «Alarm aktualisiert» diff, Banners · AlarmUpdateBanner).
 *  Markup as data, never HTML: a sub-line carries text from outside (an alarm). */
export type MeldungSpan = string | { ins: string } | { del: string } | { b: string }
/** A sub-line: one string, or spans with emphasis. */
export type MeldungText = string | readonly MeldungSpan[]

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
  sub?: MeldungText
  /** a second sub-line, under `sub` – for a row that has two things to say (old → new, and the
   *  new Meldung). Two at most: a third is a sheet, not a row. */
  sub2?: MeldungText
  actions?: MeldungAction[]
  /** Where this message LEADS — and, if it is set, the row's title becomes the way there.
   *  The title only: the sub-line, the glyph and the space beside them stay dead, because a row
   *  whose whole body acts is what let a tap meant to READ a message take an alarm (23.08.).
   *  `label` is the full sentence («In Verlauf öffnen»): the visible title says what the message
   *  is about, never what following it does, so the accessible name has to carry both. */
  onOpen?: { label: string; onClick: () => void }
  /** the ✕. Present only where waving the message away is legitimate: a due Wiedervorlage can
   *  be erledigt or verschoben, never dismissed. */
  dismiss?: { label: string; onClick: () => void }
  /** Title and sub-line WRAP instead of ellipsizing — for a row whose whole sentence is the
   *  message and whose point sits at its end («… abgeschlossen (14:45)»): cut at 360px it read
   *  «Einsatz wurde auf einem ander…», which says nothing (N3, 25.09.2026). Every other row keeps
   *  its one line; a strip of wrapping rows would push the surface down. */
  wrap?: boolean
  /** The sub-line IS the message — a due Wiedervorlage's task, under the generic «Erinnerung
   *  fällig · 21:40» — so it wraps to two lines before the ellipsis, where every other sub-line
   *  keeps one (20.10.2026, UX sweep S2: «Rückmeldung Strom an EBL: Hauptschalter …» lost the
   *  part that says what to do). The title still opens the whole text in the Verlauf. */
  subLines?: 2
}

/**
 * Order the published messages: purely by class, and inside a class by arrival. Every one of them
 * becomes a row — the strip has no head, no queue and no disclosure since 23.08., because the
 * numbers said it almost always holds zero or one message and a permanent mechanism was being
 * paid for a pile-up that only happens when a Wiedervorlage with a Fälligkeit meets an alarm.
 *
 * The order is therefore the only guarantee left, and it is enough: a rank-1–2 message is at the
 * top, and nothing below it is hidden.
 */
export function rankMeldungen(items: readonly Meldung[]): Meldung[] {
  // Array.prototype.sort is stable, so inside one kind the publication order (= arrival) holds:
  // class decides first, time only breaks the tie.
  return [...items].sort((a, b) => MELDUNG_RANK[a.kind] - MELDUNG_RANK[b.kind])
}

/** The «Neuere App-Version nötig» row (workspace/useWorkspaceBlob) — named here because the
 *  Atemschutz-Link lets it through while the rest of its kind stays out. */
export const NEWER_BUILD_MELDUNG_ID = 'workspace:newer'

/** The kinds that BLOCK work on the Atemschutz-Link: the Einsatz closed (or the link refused —
 *  both `lifecycle`), another tab holding the lock, a dead session — and the two Atemschutz alarm
 *  kinds, which step aside on the board anyway (`onBoard`) but must never be filtered by accident.
 *  Plus what the board would otherwise only have said in a toast the link does not show
 *  (FEEDBACK.1, 17.11.2026): a refused act, and «Kein Sicherungstrupp bereit» – a sentence that
 *  refuses or warns about safety never rides on a toast alone. */
const LINK_KINDS: ReadonlySet<MeldungKind> = new Set(['notfall', 'atemschutz', 'lifecycle', 'tabLock', 'session', 'refused', 'safety'])

/** What the Atemschutz-Link's Meldeleiste shows (sweep 30.10.2026 #23 — owner: «drop the
 *  notifications entirely since they just hide things», picked «No toasts, keep blockers»): a row
 *  that stops the board from working, a refusal, the missing Sicherungstrupp – nothing else. Its toasts are off at the host (App · Overlays). */
export const linkShowsMeldung = (m: Meldung): boolean => LINK_KINDS.has(m.kind) || m.id === NEWER_BUILD_MELDUNG_ID
