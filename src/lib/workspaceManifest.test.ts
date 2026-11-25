import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import manifest from './workspaceManifest.json'
import { MERGE_POLICY } from './mergeWorkspace'
import { DRAW_KINDS, ENTITY_KINDS, WORKSPACE_SCHEMA_VERSION } from './workspace'

// A build rebuilds the blob from the keys and kinds it knows, and the server refuses only a save
// from an OLDER build. So a key or kind that joins without a version bump is deleted by every build
// in the field at the same version (`reportSignatures` joined v3 that way on 15.10.2026). The
// manifest pins each version's set; these tests fail when the set changes without a bump.

const keys: Record<string, number> = manifest.keys
const kinds: Record<string, number> = manifest.entityKinds
const drawKinds: Record<string, number> = manifest.drawKinds
const shipped: Record<string, string> = manifest.shipped
const shippedDrawKinds: Record<string, string> = manifest.shippedDrawKinds

/** The entries of one section a build at version `v` knows, one line each. */
const known = (section: Record<string, number>, tag: string, v: number) =>
  Object.entries(section).filter(([, since]) => since <= v).map(([k]) => `${tag}:${k}`)
/** A set of lines as one short fingerprint. */
const fingerprint = (lines: string[]) => createHash('sha256').update(lines.sort().join('\n')).digest('hex').slice(0, 16)

describe('workspace manifest (src/lib/workspaceManifest.json)', () => {
  it('lists exactly the synced keys', () => {
    const synced = Object.entries(MERGE_POLICY).filter(([, p]) => p !== 'local').map(([k]) => k)
    expect(Object.keys(keys).sort()).toEqual(synced.sort())
  })

  it('lists exactly the entity kinds', () => {
    expect(Object.keys(kinds).sort()).toEqual([...ENTITY_KINDS].sort())
  })

  it('lists exactly the drawing kinds', () => {
    expect(Object.keys(drawKinds).sort()).toEqual([...DRAW_KINDS].sort())
  })

  it('names no version this build has not reached', () => {
    for (const since of [...Object.values(keys), ...Object.values(kinds), ...Object.values(drawKinds)]) {
      expect(Number.isInteger(since) && since >= 1 && since <= WORKSPACE_SCHEMA_VERSION).toBe(true)
    }
  })

  // The drawing kinds have their own line per version: they joined the manifest after versions
  // 1–3 shipped, and folding them into `shipped` would have rewritten those lines.
  it('changes no shipped version: a new key or kind needs the next version and a bump', () => {
    const versions = Array.from({ length: WORKSPACE_SCHEMA_VERSION }, (_, i) => i + 1)
    const hint = `builds in the field know this set, so a new key or kind needs "since": ${WORKSPACE_SCHEMA_VERSION + 1} `
      + `and WORKSPACE_SCHEMA_VERSION ${WORKSPACE_SCHEMA_VERSION + 1}. A new version adds its line to "shipped" and `
      + `"shippedDrawKinds"; a shipped line is never edited.`
    for (const v of versions) {
      expect(fingerprint([...known(keys, 'key', v), ...known(kinds, 'kind', v)]), `version ${v}: ${hint}`).toBe(shipped[v])
      expect(fingerprint(known(drawKinds, 'draw', v)), `version ${v} (drawing kinds): ${hint}`).toBe(shippedDrawKinds[v])
    }
    expect(Object.keys(shipped).map(Number)).toEqual(versions)
    expect(Object.keys(shippedDrawKinds).map(Number)).toEqual(versions)
  })
})
