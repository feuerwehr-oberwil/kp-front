import type { ReactNode } from 'react'

/**
 * The action row at the foot of a sheet — ONE element for every sheet that has one: drawn by
 * <Sheet> (`footer`), and worn by each bespoke frame whose footer is its bottom edge on a phone
 * (the Trupp form, the Mittel note, the Georef transfer).
 *
 * ⚠️ Its insets are the primitive's, not the caller's (26.09.2026, owner on an iPhone): on a phone
 * the sheet is flush with the screen's rounded corners, so the row pays the safe area on three
 * sides — 15-mobile.css · `.ui-sheet-foot`. The Trupp form had its own footer class and its own
 * insets, and a later rule of the same weight quietly took them back: «Abbrechen» and «Im Einsatz»
 * sat 12px off the glass and 10px above the bottom edge, inside the display's corner curve. A
 * caller keeps its look (`className`); where the row stands is not its business.
 */
export function SheetFoot({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={className ? `ui-sheet-foot ${className}` : 'ui-sheet-foot'}>{children}</div>
}
