// Per-incident workspace blob: get/put + the live-follow poll. The blob is opaque here — the
// App owns its `Saved` structure; we only move it to/from the server. Offline caching + the
// debounced merge-on-save engine live alongside in ./workspaceSync.
import { ApiError, apiBeacon, apiGet, apiGetRaw, apiPut } from '../api'

export type Workspace = Record<string, unknown>

export const getWorkspace = (id: string) =>
  apiGet<{ workspace: Workspace | null; workspace_rev: number }>(`/api/incidents/${id}/workspace`)
export const putWorkspace = (id: string, workspace: Workspace, base_rev: number) =>
  apiPut<{ workspace: Workspace | null; workspace_rev: number }>(`/api/incidents/${id}/workspace`, {
    workspace,
    base_rev,
  })
/** Fire-and-forget workspace PUT for page teardown — survives the document unloading. */
export const putWorkspaceBeacon = (id: string, workspace: Workspace, base_rev: number) =>
  apiBeacon(`/api/incidents/${id}/workspace`, { workspace, base_rev }, 'PUT')

/** Live-follow poll: 304 → null (unchanged); 200 → the current workspace + rev. */
export async function pollWorkspaceSince(
  id: string,
  sinceRev: number,
): Promise<{ workspace: Workspace | null; workspace_rev: number } | null> {
  const res = await apiGetRaw(`/api/incidents/${id}/workspace?since=${sinceRev}`)
  if (res.status === 304) return null
  if (!res.ok) throw new ApiError(res.status, 'Workspace-Poll fehlgeschlagen')
  return res.json()
}
