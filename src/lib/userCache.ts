import { idbGet } from './idb'

/** The IndexedDB key of the signed-in account this device last confirmed (lib/auth keeps it). */
export const USER_CACHE = 'kp-front-user'

/** Does this device hold a confirmed account? Read straight at boot by main.tsx to warm the field
 *  app beside the boot's own awaits – waiting for React to adopt the account first doubled the
 *  warm reload (hunt 24.11.2026, performance F3 follow-up). Never rejects. */
export function hasCachedUser(): Promise<boolean> {
  return idbGet<unknown>(USER_CACHE).then((u) => !!u, () => false)
}
