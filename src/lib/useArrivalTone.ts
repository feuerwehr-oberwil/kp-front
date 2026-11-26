import { useEffect, useRef } from 'react'
import { arrivalTone } from './alarm'

/**
 * Ring the «Neuer Alarm» tone once when a new alarm row arrives (owner pick UX journeys B3·7,
 * 25.11.2026). App hands in the key of the alarm row on the strip – `alarm:<divera_id>` for an
 * untaken dispatch, `incident:<id>` for an Einsatz that opened by itself – and whether this
 * device rings now: on the Karte home, not inside an Einsatz.
 *
 * Every key is rung for at most once per page, and a key seen while `ring` was false counts as
 * seen: walking from the Einsatz back to the Karte must not ring an alarm that is already on
 * the strip. A row that is there at boot rings nothing either – the audio is still locked then,
 * and the first tap only arms it.
 */
export function useArrivalTone(key: string | null, ring: boolean): void {
  const seen = useRef(new Set<string>())
  useEffect(() => {
    if (key == null || seen.current.has(key)) return
    seen.current.add(key)
    if (ring) arrivalTone()
  }, [key, ring])
}
