/*
 * **Help describes the device it is read on** (29.09.2026). `HelpBlock` / `HelpSection` carry
 * `only: 'phone' | 'wide' | 'keyboard'` (`lib/helpDevice · helpShows`): a phone reads about the
 * two bottom bars and the FAB, never a left/right rail or a rail drag; the Tastaturkürzel section
 * and the mouse/keys parts show only off a phone and where a fine pointer exists. Every locale
 * carries its own sections array, so a device-specific block goes into all four
 * (`helpDevice.test` checks the phone text of every locale for rail words). **A surface's
 * explanation is one line; the long text lives in Hilfe**: the «Einsatz · lesen» share lede is
 * «Kein Login · gilt auch nach dem Abschluss.» in the share sheet and in Rapport › Weitergeben
 * alike; audiences and lifetimes are in Hilfe › Rapport & Abschluss.
 */

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
