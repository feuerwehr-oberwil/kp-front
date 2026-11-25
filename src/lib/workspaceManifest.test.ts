import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import manifest from './workspaceManifest.json'
import { MERGE_POLICY } from './mergeWorkspace'
import { ENTITY_KINDS, WORKSPACE_SCHEMA_VERSION } from './workspace'

// A build rebuilds the blob from the keys and kinds it knows, and the server refuses only a save
// from an OLDER build. So a key or kind that joins without a version bump is deleted by every build
// in the field at the same version (`reportSignatures` joined v3 that way on 15.10.2026). The
// manifest pins each version's set; these tests fail when the set changes without a bump.

const keys: Record<string, number> = manifest.keys
const kinds: Record<string, number> = manifest.entityKinds
const shipped: Record<string, string> = manifest.shipped

/** The set a build at version `v` knows, as one short fingerprint. */
const fingerprint = (v: number) => createHash('sha256').update([
  ...Object.entries(keys).filter(([, since]) => since <= v).map(([k]) => `key:${k}`),
  ...Object.entries(kinds).filter(([, since]) => since <= v).map(([k]) => `kind:${k}`),
].sort().join('\n')).digest('hex').slice(0, 16)

describe('workspace manifest (src/lib/workspaceManifest.json)', () => {
  it('lists exactly the synced keys', () => {
    const synced = Object.entries(MERGE_POLICY).filter(([, p]) => p !== 'local').map(([k]) => k)
    expect(Object.keys(keys).sort()).toEqual(synced.sort())
  })

  it('lists exactly the entity kinds', () => {
    expect(Object.keys(kinds).sort()).toEqual([...ENTITY_KINDS].sort())
  })

  it('names no version this build has not reached', () => {
    for (const since of [...Object.values(keys), ...Object.values(kinds)]) {
      expect(Number.isInteger(since) && since >= 1 && since <= WORKSPACE_SCHEMA_VERSION).toBe(true)
    }
  })

  it('changes no shipped version: a new key or kind needs the next version and a bump', () => {
    for (let v = 1; v <= WORKSPACE_SCHEMA_VERSION; v++) {
      expect(fingerprint(v), `version ${v}: builds in the field know this set, so a new key or kind `
        + `needs "since": ${WORKSPACE_SCHEMA_VERSION + 1} and WORKSPACE_SCHEMA_VERSION ${WORKSPACE_SCHEMA_VERSION + 1}. `
        + `A new version adds its line to "shipped"; a shipped line is never edited.`).toBe(shipped[v])
    }
    expect(Object.keys(shipped).map(Number)).toEqual(Array.from({ length: WORKSPACE_SCHEMA_VERSION }, (_, i) => i + 1))
  })
})
