/**
 * «An account is known on this page» — after the boot probe, a login, the demo's auto-login, a
 * link page's own `/me`. main.tsx registers the station plan calibration here (its route needs
 * a session); lib/auth · AuthProvider fires it.
 *
 * A callback in a module of its own, not an import from lib/auth: that module is in the entry
 * chunk, and importing the calibration from it pulled the whole drawing graph in with it
 * (+25 % on the bundle budget).
 */
const listeners: (() => void)[] = []

/** Run `fn` whenever an account becomes known (the boot's calibration load, the field-app warm-up). */
export function onAccountKnown(fn: () => void): void {
  listeners.push(fn)
}

export function notifyAccountKnown(): void {
  for (const fn of listeners) fn()
}
