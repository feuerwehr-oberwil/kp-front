// What this device remembers for the next visit (never synced): the people last typed into «Von».
// The accounts are shared station logins, so the person has to be typed, and the same two people
// usually do a whole tour — and the next tour, weeks later (owner, 05.10.2026: «remember the "von"
// person locally»).
//
// ⚠️ localStorage, not the prefs cookie it started in: Safari caps a cookie written by script
// (`document.cookie`) at seven days, so a name typed on one tour was gone by the next. The
// installed app's localStorage has no such cap. A name still in an old cookie is read once as the
// fallback, so nobody types it again after the update. No setting: the last names typed ARE the
// default, and the field stays editable on every visit.

import { loadPrefs } from '../lib/prefs'

const KEY = 'kp.ov.with'

/** «Muster Max, Frei Nina» → ['Muster Max', 'Frei Nina'] */
export const splitPeople = (text: string): string[] => text.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)

function stored(): string | null {
  try { return localStorage.getItem(KEY) } catch { return null }
}

/** The «Von» names last used on this device, for a new visit. */
export function lastWith(): string[] {
  const v = stored() ?? loadPrefs().ovWith
  return typeof v === 'string' ? splitPeople(v) : []
}

/** Remember «Von» for the next visit on this device (an empty field is remembered too). */
export function rememberWith(people: string[]): void {
  try { localStorage.setItem(KEY, people.join(', ')) } catch { /* private mode / full: the field still works, it just starts empty next time */ }
}
