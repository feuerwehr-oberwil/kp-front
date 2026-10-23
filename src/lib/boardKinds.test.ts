import { describe, expect, it } from 'vitest'
import kinds from '../../backend/app/data/board_kinds.json'
import type { BoardKind } from '../types'
import { BOARD_KINDS, WORKSPACE_SCHEMA_VERSION } from './workspace'

// The server keeps a stored board object a save from an OLDER build left out (backend
// app/workspace_kinds.py), by the version each kind arrived with. That table and this build's
// kinds were kept equal by a sentence in the docs; a kind added here without its row would be
// deleted for every device by the first save from a build that predates it.
//
// Compile time: a BoardKind without a row fails tsc on this line.
const since: Record<BoardKind, number> = kinds.since

describe('board kinds ↔ the server version table (backend/app/data/board_kinds.json)', () => {
  it('lists exactly the kinds this build draws', () => {
    expect(Object.keys(since).sort()).toEqual([...BOARD_KINDS].sort())
  })

  it('names no version this build has not reached', () => {
    for (const v of Object.values(since)) expect(v).toBeLessThanOrEqual(WORKSPACE_SCHEMA_VERSION)
  })
})
