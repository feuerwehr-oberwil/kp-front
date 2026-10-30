// The server's refusal of a save from an OLDER build than the one that wrote its blob (sweep
// 30.10.2026 #19). Rules: docs/sync-and-offline.md · «…and a build OLDER than the blob writes nothing to it».

import { ApiError } from './api'

/** The refusal's name — mirrors backend workspace_kinds · WORKSPACE_OLDER_BUILD_CODE. */
export const WORKSPACE_OLDER_BUILD_CODE = 'workspace_older_build'

/** Did the server refuse this save because a newer build wrote the stored blob? A plain 409 is the
 *  revision conflict (merge and retry); this one stays until a newer build saves. */
export function isOlderBuildRefusal(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && e.code === WORKSPACE_OLDER_BUILD_CODE
}
