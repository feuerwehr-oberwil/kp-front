import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RECORD_SLICE_KEYS } from './workspaceSync'

// The `el` record slice sends these keys, and the server stores only the keys of its allowlist
// (backend api/incidents · RECORD_WORKSPACE_KEYS). A key the client sends that the server drops
// is a save that only looks landed. Both read one file; read from disk, not imported, because the
// image's frontend stage holds `src/` alone (see lib/boardKinds.test.ts).
const shared: string[] = JSON.parse(
  readFileSync(new URL('../../../backend/app/data/record_slice_keys.json', import.meta.url), 'utf-8'),
).keys

describe('record slice keys ↔ the server allowlist (backend/app/data/record_slice_keys.json)', () => {
  it('sends exactly the keys the server accepts', () => {
    expect([...RECORD_SLICE_KEYS].sort()).toEqual([...shared].sort())
  })
})
