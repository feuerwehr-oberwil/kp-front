import type { HelpOnly } from '../config/copy/de'

/**
 * Which device-specific help this screen gets (29.09.2026). On a phone the help describes the two
 * bottom bars, not the left and right rails, and the shortcut / mouse parts are gone — there is
 * no keyboard. A tablet with only a finger (no fine pointer anywhere) drops those too; one with a
 * trackpad or mouse keeps them, since that is where a keyboard is. Help that describes another
 * device contradicts the screen it is read on, which at 3am is worse than no help.
 */
export function helpShows(only: HelpOnly | undefined, d: { phone: boolean; finePointer: boolean }): boolean {
  if (!only) return true
  if (only === 'phone') return d.phone
  if (only === 'wide') return !d.phone
  return !d.phone && d.finePointer
}
