/**
 * A typed clock time is HH:MM, never «2339» – the ONE rule for every field a time is typed into:
 * the wheel popover's typed field (WheelPicker) and the Tafel's «Wann» cells (TafelFormPage · Cell).
 * ⚠️ Owner pick «variant B» (UX journeys, 26.11.2026: «2359 isn't a time, 23:53 is»; the Tafel
 * got the same rule the same day): the colon appears as you type, so the iPhone's digit pad (no
 * colon key, `inputMode="numeric"`) stays, and what is saved is what stood in the field. Hours need
 * two digits – «0930», never «930». Before that, «930», «9.05» and «1124» were read as times by
 * themselves (the Tafel's old `normalizeTime`).
 *
 * Use: run every change through `autoColon(prev, raw)` and show its result; commit only what
 * `parseTypedTime` accepts, else say `copy.wheel.invalidTime` under the field and write nothing.
 */

/**
 * What the field shows after a keystroke: the digits as HH:MM, the colon put in after the second
 * digit. «2» «3» → «23:», «5» «3» → «23:53»; a pasted «2353» or «23.53» → «23:53». Backspace over
 * the colon takes the hour's last digit with it («23:» → «2»), else the colon would come straight back.
 */
export function autoColon(prev: string, raw: string): string {
  let digits = raw.replace(/\D/g, '').slice(0, 4)
  if (raw.length < prev.length && prev.endsWith(':') && !raw.includes(':')) digits = digits.slice(0, -1)
  return digits.length < 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`
}

/** '23:53' → [h, mi]; null while it is still being typed («23:5») or out of range («24:00», «23:60»). */
export function parseTypedTime(raw: string): [h: number, mi: number] | null {
  const m = /^(\d{2}):(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  return h <= 23 && mi <= 59 ? [h, mi] : null
}
