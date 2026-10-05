import { useEffect, useRef, useState } from 'react'

/** The longest an Einsatz's OPENING stays behind the snail. The cover exists so the operator
 *  never watches the workspace assemble itself (chrome without a map, symbols on a blank ground,
 *  the camera jumping to the content, plan tiles and the weather popping into the bars, the
 *  basemap arriving in patches). It must never become the thing that keeps them OUT: past this,
 *  whatever has not arrived arrives in view, as it did before the cover (01.10.2026). Below
 *  Splash's STUCK_MS on purpose: a workspace that merely loads slowly is not a wedged launch, and
 *  the cover must not offer «Neu laden» over it. */
export const BOOT_COVER_MAX_MS = 8_000
/** …and it lifts with a short fade, so the finished picture appears rather than cuts in. */
export const BOOT_COVER_FADE_MS = 240

export type BootCoverPhase = 'on' | 'leaving' | 'off'

/**
 * The opening cover's life: `on` from mount while `active`, `leaving` the moment `ready` (or
 * the cap) comes, `off` one fade later — and `onDone` then, ONCE. A cover that was not active at
 * mount never shows: a background remount (live-follow, a 409 merge) must not black out a working
 * screen. Reduced motion lifts without the fade.
 */
export function useBootCover(active: boolean, ready: boolean, onDone?: () => void): BootCoverPhase {
  const [off, setOff] = useState(!active)
  const [capped, setCapped] = useState(false)
  const leaving = !off && (ready || capped)
  const done = useRef(onDone)
  useEffect(() => { done.current = onDone })

  useEffect(() => {
    if (off) return
    const t = setTimeout(() => setCapped(true), BOOT_COVER_MAX_MS)
    return () => clearTimeout(t)
  }, [off])

  // One way only: once the fade has begun it ends, even if a condition drops back meanwhile (a
  // remote object pick re-opening the plan lookup) — so the timer is cleared on unmount alone.
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!leaving || fade.current) return
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    fade.current = setTimeout(() => { setOff(true); done.current?.() }, still ? 0 : BOOT_COVER_FADE_MS)
  }, [leaving])
  useEffect(() => () => { if (fade.current) clearTimeout(fade.current) }, [])

  return off ? 'off' : leaving ? 'leaving' : 'on'
}
