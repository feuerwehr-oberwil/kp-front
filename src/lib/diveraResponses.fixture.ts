import type { DiveraResponses } from './api/divera'
import type { Person } from '../types'

/** What GET /api/divera/responses/{id} returns for the fixture alarm in
 *  backend/tests/fixtures/divera (the REAL Divera shape) — generated from the backend's own
 *  `divera_responses.summarise` with Divera users 101–106 on the roster as p101–p106, so the two
 *  halves are tested against one payload. User 999 is on nobody's roster: a count, no row. */
export const FIXTURE: DiveraResponses = {
  "available": true,
  "updated_at": "2026-10-08T18:03:00+00:00",
  "counts": {
    "coming": 4,
    "not_coming": 2,
    "other": 1,
    "answered": 7,
    "addressed": 10,
    "unanswered": 3,
    "unmapped": 1,
    "read": 8
  },
  "statuses": [
    {
      "id": 11,
      "name": "Komme",
      "kind": "coming",
      "minutes": 0,
      "count": 2
    },
    {
      "id": 12,
      "name": "Komme in 10 min",
      "kind": "coming",
      "minutes": 10,
      "count": 2
    },
    {
      "id": 13,
      "name": "Komme nicht",
      "kind": "not_coming",
      "minutes": 0,
      "count": 2
    },
    {
      "id": 17,
      "name": "Rückruf erbeten",
      "kind": "other",
      "minutes": 0,
      "count": 1
    }
  ],
  "answers": [
    {
      "person_id": "p101",
      "status_id": 11,
      "kind": "coming",
      "answered_at": "2026-10-08T17:01:00+00:00",
      "eta": null,
      "note": ""
    },
    {
      "person_id": "p102",
      "status_id": 11,
      "kind": "coming",
      "answered_at": "2026-10-08T17:01:15+00:00",
      "eta": null,
      "note": "bin im Magazin"
    },
    {
      "person_id": "p103",
      "status_id": 12,
      "kind": "coming",
      "answered_at": "2026-10-08T17:01:30+00:00",
      "eta": "2026-10-08T17:11:30+00:00",
      "note": "5 min"
    },
    {
      "person_id": "p104",
      "status_id": 13,
      "kind": "not_coming",
      "answered_at": "2026-10-08T17:01:40+00:00",
      "eta": null,
      "note": "Ferien"
    },
    {
      "person_id": "p105",
      "status_id": 13,
      "kind": "not_coming",
      "answered_at": "2026-10-08T17:01:50+00:00",
      "eta": null,
      "note": ""
    },
    {
      "person_id": "p106",
      "status_id": 17,
      "kind": "other",
      "answered_at": "2026-10-08T17:02:10+00:00",
      "eta": null,
      "note": ""
    }
  ]
}

const person = (id: string, name: string, ucr?: number, rank?: string): Person => ({
  id, displayName: name, active: true, updatedAt: 't', rank,
  externalIdentities: ucr ? [{ provider: 'divera', externalId: String(ucr), syncedAt: 't' }] : [],
})
export const ROSTER: Person[] = [
  person('p101', 'Muster Hans', 101, 'gfr'),
  person('p102', 'Meier Anna', 102),
  person('p103', 'Keller Peter', 103, 'wm'),
  person('p104', 'Huber Lea', 104),
  person('p105', 'Weber Marco', 105),
  person('p106', 'Frei Sara', 106),
  person('p200', 'Ohne Divera', undefined),
]
