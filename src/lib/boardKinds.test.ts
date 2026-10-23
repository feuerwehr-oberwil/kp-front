import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOARD_KINDS, WORKSPACE_SCHEMA_VERSION } from './workspace'

// The server keeps a stored board object a save from an OLDER build left out (backend
// app/workspace_kinds.py), by the version each kind arrived with. That table and this build's
// kinds were kept equal by a sentence in the docs; a kind added here without its row would be
// deleted for every device by the first save from a build that predates it.
//
// Read from disk, not imported: the JSON belongs to the backend, and the image's frontend stage
// type-checks `src/` alone (an import made the Railway build fail, 23.10.2026). BOARD_KINDS is
// the build's kind list (kindSet checks it against BoardKind), so key equality below is the
// same guarantee the compile-time check gave.
const since: Record<string, number> = JSON.parse(
  readFileSync(new URL('../../backend/app/data/board_kinds.json', import.meta.url), 'utf-8'),
).since

describe('board kinds ↔ the server version table (backend/app/data/board_kinds.json)', () => {
  it('lists exactly the kinds this build draws', () => {
    expect(Object.keys(since).sort()).toEqual([...BOARD_KINDS].sort())
  })

  it('names no version this build has not reached', () => {
    for (const v of Object.values(since)) expect(v).toBeLessThanOrEqual(WORKSPACE_SCHEMA_VERSION)
  })
})
