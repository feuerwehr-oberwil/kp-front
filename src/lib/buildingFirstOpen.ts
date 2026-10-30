// The Gebäude card opens BY ITSELF the first time this device shows the Karte of an Einsatz whose
// building has anything to show (owner, 10.10.2026: «the first time an emergency is opened those
// also appear, so that they are read always»; since sweep 30.10.2026 #6 for every building with
// content, not only for a hazard or notes). The policy is pure and the flag is
// storage-injectable, so the rule is node-testable; BuildingFloat owns the pixels, the workspace
// says WHEN the Karte is really in front of the operator (useBuildingFirstOpen · `eligible`).
//
// The rules:
//   · for every building the card has something to say about (lib/buildingCard · hasBuildingContent):
//     Geschosse and Baujahr are read too, on every new Einsatz (owner pick «Both», 30.10.2026). A
//     building with nothing at all has no chip and no card, so nothing opens;
//   · once per DEVICE per Einsatz per building: another tablet on the same Einsatz has its own
//     operator who has not read it, so the flag never reaches the synced workspace. A building is
//     the Einsatzort the answer was asked for plus its Objekt (`buildingReadKey`): an address
//     corrected in «Bearbeiten» or a manual Objekt pick is a new building and is shown once again;
//   · READ means closed (✕ / Esc / the chip). Left open and the surface or the app gone, it was not
//     dismissed and comes back the next time the Karte is shown; the chip stays to reopen it;
//   · operational VIEW state, so it lives in IndexedDB (lib/idb, docs/sync-and-offline.md · «Operational browser
//     state lives in IndexedDB»), mirrored in memory so a surface switch never waits for the read
//     and a device whose storage refuses still shows it only once per session.
import { useCallback, useEffect, useState } from 'react'
import type { BuildingInfo } from './api/building'
import { hasBuildingContent } from './buildingCard'
import { idbRead, idbSet } from './idb'

/** Which building an answer is about: the Einsatzort it was asked for (`buildingWhere`, stamped on
 *  every answer the device keeps) and the Objekt whose notes it carries. */
export function buildingReadKey(b: BuildingInfo): string {
  return `${b.where ?? b.egid ?? ''}#${b.object?.id ?? ''}`
}

/**
 * Should the card open by itself now?
 *
 * `read` is null until this device's flag has been read — never before, or a reload would flash
 * the card open over a building already read. `eligible` is the workspace's «the Karte is in front
 * of the operator»: the opening cover gone, a running Einsatz, no replay, a session that sees it.
 */
export function shouldAutoOpenBuilding(
  { info, read, eligible }: { info: BuildingInfo | null | undefined; read: readonly string[] | null; eligible: boolean },
): boolean {
  if (!eligible || !read || !info || !hasBuildingContent(info)) return false
  return !read.includes(buildingReadKey(info))
}

// --- the device's flag ---------------------------------------------------------------------------

const idbKey = (incidentId: string) => `kp-front-building-read:${incidentId}`
const memory = new Map<string, string[]>()

type Read = (key: string) => Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>
type Write = (key: string, value: unknown) => Promise<boolean>

/** The buildings this device has read in this Einsatz. A store that cannot answer reads as none:
 *  showing a card twice is cheaper than never showing Sofortmassnahmen. */
export async function loadReadBuildings(incidentId: string, read: Read = idbRead): Promise<string[]> {
  const got = await read(idbKey(incidentId)).catch(() => ({ ok: false as const, error: null }))
  const stored = got.ok && Array.isArray(got.value) ? got.value.filter((k): k is string => typeof k === 'string') : []
  // …joined with what was closed here while the read was in flight
  const all = [...new Set([...stored, ...(memory.get(incidentId) ?? [])])]
  memory.set(incidentId, all)
  return all
}

/** …and one more of them: memory at once, then the device's store — re-read first, so a close
 *  before the first read answered never writes over the buildings read on an earlier day. */
export async function markBuildingRead(incidentId: string, key: string, write: Write = idbSet, read: Read = idbRead): Promise<string[]> {
  memory.set(incidentId, [...new Set([...(memory.get(incidentId) ?? []), key])])
  const all = await loadReadBuildings(incidentId, read)
  await write(idbKey(incidentId), all).catch(() => false)
  return all
}

/** test seam: a reload (the session memory is gone, the device's store is not) */
export const resetBuildingReadMemory = () => memory.clear()

/**
 * The card's first open for the workspace: `autoOpen` while the card should stand open by itself,
 * `markRead` when the operator closes it (any way). Nothing opens before the flag is read.
 */
export function useBuildingFirstOpen(incidentId: string | undefined, info: BuildingInfo | null, eligible: boolean) {
  const [read, setRead] = useState<{ id: string; keys: string[] } | null>(() =>
    incidentId && memory.has(incidentId) ? { id: incidentId, keys: memory.get(incidentId)! } : null)
  useEffect(() => {
    if (!incidentId) return
    let live = true
    void loadReadBuildings(incidentId).then((keys) => { if (live) setRead({ id: incidentId, keys }) })
    return () => { live = false }
  }, [incidentId])
  const keys = read && read.id === incidentId ? read.keys : null
  const autoOpen = shouldAutoOpenBuilding({ info, read: keys, eligible })
  const markRead = useCallback(() => {
    if (!incidentId || !info || !hasBuildingContent(info)) return
    const key = buildingReadKey(info)
    setRead({ id: incidentId, keys: [...new Set([...(memory.get(incidentId) ?? []), key])] })
    void markBuildingRead(incidentId, key)
  }, [incidentId, info])
  return { autoOpen, markRead }
}
