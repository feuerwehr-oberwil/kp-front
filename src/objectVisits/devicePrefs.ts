// What this device remembers for the next visit (a device preference — the prefs cookie, never
// synced): the people last typed into «Von». The accounts are shared station logins, so the
// person has to be typed, and the same two people usually do a whole tour.

import { loadPrefs, savePrefs } from '../lib/prefs'

/** «Muster Max, Frei Nina» → ['Muster Max', 'Frei Nina'] */
export const splitPeople = (text: string): string[] => text.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)

/** The «Von» names last used on this device, for a new visit. */
export function lastWith(): string[] {
  const v = loadPrefs().ovWith
  return typeof v === 'string' ? splitPeople(v) : []
}

/** Remember «Von» for the next visit on this device (an empty field is remembered too). */
export function rememberWith(people: string[]): void {
  savePrefs({ ...loadPrefs(), ovWith: people.join(', ') })
}
