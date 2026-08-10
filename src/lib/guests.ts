import type { AttendanceState, Person } from '../types'

/**
 * The people who are on this Einsatz but not on the Mannschaftsliste — a Gast, a Nachbarwehr,
 * an AdF whose roster row never synced. They exist only as an Anwesenheits-Eintrag whose id
 * matches no Person row, so every picker that reads the roster used to be blind to them: once
 * somebody was recorded as here, they still could not be named as a Fahrer, as Einsatzleiter,
 * or on a second Trupp. The one surface that knew about them was the Anwesenheit itself.
 *
 * Shaped like a Person so every list, sort and row action works on them unchanged; `guest: true`
 * is what lets a picker mark the row without having to know where it came from.
 */
export function guestsFromAttendance(attendance: AttendanceState, roster: Person[]): Person[] {
  const known = new Set(roster.map((p) => p.id))
  return Object.entries(attendance)
    .filter(([id]) => !known.has(id))
    .map(([id, a]) => ({
      id,
      displayName: a.displayNameSnapshot || id,
      active: true,
      updatedAt: '',
      guest: true,
    }))
}

/**
 * The roster plus those guests — what a person picker should offer.
 *
 * ⚠️ Guests come LAST, not sorted in. Every picker sorts its own options afterwards (present
 * first, then rank), and a guest carries no Dienstgrad, so their position falls out of that
 * sort like anyone else's. The order here only decides ties.
 */
export function rosterWithGuests(roster: Person[], attendance: AttendanceState): Person[] {
  const guests = guestsFromAttendance(attendance, roster)
  return guests.length ? [...roster, ...guests] : roster
}
