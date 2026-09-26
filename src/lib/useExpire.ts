import { useEffect, useRef } from 'react'

/**
 * Call `onExpire(key)` `ms` after `key` appears — a notice that only INFORMS goes away by itself
 * (V2, staging 25.09.2026: «Einsatz wurde auf einem anderen Gerät wieder geöffnet» stood 110 px
 * tall on a 360 phone until somebody found its ✕). `hold` keeps it (a row carrying an action the
 * operator still owes, like «Einträge sichern»); a new `key` starts a new clock. `onExpire` is read
 * through a ref, so an inline callback does not restart the clock on every render.
 */
export function useExpire(key: number | null, ms: number, hold: boolean, onExpire: (key: number) => void): void {
  const cb = useRef(onExpire)
  useEffect(() => { cb.current = onExpire }, [onExpire])
  useEffect(() => {
    if (key == null || hold) return
    const t = setTimeout(() => cb.current(key), ms)
    return () => clearTimeout(t)
  }, [key, ms, hold])
}
