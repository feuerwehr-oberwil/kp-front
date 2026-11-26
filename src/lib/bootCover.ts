/*
 * **An Einsatz opens behind the snail** (01.10.2026, `lib/bootCover`): a genuine open (App ·
 * `coverId`, never a background remount or a re-select of the Einsatz on screen) keeps the
 * pre-app Splash portalled over the whole workspace until the symbol pack, the framed Karte's
 * first `idle`, the rail's plan tiles and the weather are in, capped at 8 s (below Splash's
 * STUCK_MS), then fades it out. The launcher waits for the boot's pick (`bootDecided`): the list
 * watch can fill the list first.
 */

import { useEffect, useRef, useState } from 'react'
import { markBoot } from './bootTiming'

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
 * The opening cover's life: `on` from mount while `active`, `leaving` the moment every one of
 * `waits` holds (or the cap comes), `off` one fade later — and `onDone` then, ONCE. A cover that
 * was not active at mount never shows: a background remount (live-follow, a 409 merge) must not
 * black out a working screen. Reduced motion lifts without the fade.
 *
 * While it shows, it records on the launch's boot line (lib/bootTiming · markBoot) when each wait
 * first held, `cap` when the cap lifted it, and `cover` when it is off — the device's answer to
 * «which wait held the snail». Marks are first-wins per page load: only the first opening counts.
 */
export function useBootCover(active: boolean, waits: Readonly<Record<string, boolean>>, onDone?: () => void): BootCoverPhase {
  const [off, setOff] = useState(!active)
  const [capped, setCapped] = useState(false)
  const ready = Object.values(waits).every(Boolean)
  const leaving = !off && (ready || capped)
  const done = useRef(onDone)
  useEffect(() => { done.current = onDone })

  // the marks: each wait once, while the cover is still waiting (the last one lands in the same
  // commit as `leaving`, so this effect runs before the fade's below closes the list)
  const held = Object.keys(waits).filter((k) => waits[k]).join(' ')
  const marked = useRef(new Set<string>())
  const closed = useRef(false)
  useEffect(() => {
    if (off || closed.current) return
    for (const k of held.split(' ')) {
      if (k && !marked.current.has(k)) { marked.current.add(k); markBoot(k) }
    }
  }, [held, off])

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
    closed.current = true
    if (!ready) markBoot('cap')
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    // `cover` before the commit that removes the Splash: reportBoot sends once no splash is left
    fade.current = setTimeout(() => { markBoot('cover'); setOff(true); done.current?.() }, still ? 0 : BOOT_COVER_FADE_MS)
  }, [leaving, ready])
  useEffect(() => () => { if (fade.current) clearTimeout(fade.current) }, [])

  return off ? 'off' : leaving ? 'leaving' : 'on'
}
