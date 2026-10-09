import type { DiveraResponses } from './api/divera'
import type { Person } from '../types'

/** What GET /api/divera/responses/{id} returns for the fixture alarm in
 *  backend/tests/fixtures/divera (the REAL Divera shape) with Divera users 101–106 on the roster
 *  as p101–p106 — the same payload backend/tests/test_divera_responses.py pins. User 999 said
 *  «Komme in 10 min» and is on nobody's roster: a count, no id. 106's «Rückruf erbeten» is
 *  neither yes nor no, and is not sent at all. */
export const FIXTURE: DiveraResponses = {
  available: true,
  coming: ['p101', 'p102', 'p103'],
  not_coming: ['p104', 'p105'],
  counts: { coming: 4, not_coming: 2, unmapped: 1 },
}

const person = (id: string, name: string, rank?: string): Person => ({
  id, displayName: name, active: true, updatedAt: 't', rank,
})
export const ROSTER: Person[] = [
  person('p101', 'Muster Hans', 'gfr'),
  person('p102', 'Meier Anna'),
  person('p103', 'Keller Peter', 'wm'),
  person('p104', 'Huber Lea'),
  person('p105', 'Weber Marco'),
  person('p106', 'Frei Sara'),
  person('p200', 'Ohne Divera'),
]
