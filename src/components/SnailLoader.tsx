/*
 * **The loading mascot has one source.** `public/firefighter-snail-loader.svg` owns its paths,
 * motion, station-accent shell/hose, sizing and reduced-motion rule. `SnailLoader` imports it
 * as trusted raw markup with unique ids per instance; Vite's `inlineSnailLoader` inserts it at
 * `index.html`'s `kp:snail-loader` marker so the static boot screen paints without fetching an
 * asset. Keep both stages at the same size; never replace the boot markup with an external image.
 * The boot cover paints immediately and stays through the SVG's 630 ms skid arrival, even on
 * a cached launch (`lib/snailLaunch`). React launch loading stages continue that animation clock.
 * Those 630 ms count from the cover's first frame, which WebKit can send long after the boot
 * work is done; until then the SVG has no animation to read (09.10.2026).
 * That clock is `performance.now() - animation.startTime`, never `now - currentTime`:
 * `currentTime` stands still until the next frame, and on a loaded device that made React rewind
 * the entrance by up to 20 ms (08.10.2026). The e2e reads it the same way at the moment React
 * empties `#root`, not from `animationend` (dispatched only with a frame, so a starved runner never
 * sent it for the removed cover).
 * Do not replay the arrival at each loading stage or add a fade that hides it.
 * Reduced motion skips both motion and the minimum hold.
 *
 * **KP Rück shows the same snail** (02.10.2026): kp-rueck carries a byte-identical copy at
 * `frontend/public/firefighter-snail-loader.svg` and the `fs-shell-trail` path in its own
 * `ShellLoader`. The SVG is in `shared/MANIFEST.json`, and both CIs' «Shared files» job fails
 * when the copies differ, so it is edited HERE and copied over to kp-rueck in the same breath
 * (`shared/README.md`).
 * `SnailLoader` keeps ONE `{ __html }` object per instance: React 19 rewrites `innerHTML` for a
 * new object even with the same string, which re-inserts the SVG and restarts its animations, so
 * every re-render of a loading stage replayed the arrival.
 */

import { useId, useLayoutEffect, useMemo, useRef } from 'react'
import snailSvg from '../../public/firefighter-snail-loader.svg?raw'
import { continueSnailAnimation } from '../lib/snailLaunch'

/**
 * Shared loading mascot. Vite inlines this same SVG into index.html's boot splash,
 * so the first paint needs no external resources and React takes over at the same size.
 * The SVG owns motion, station accent and reduced-motion styles. Instance-specific ids
 * keep gradients independent when two loading surfaces are mounted at the same time.
 * Only this trusted, bundled artwork is inserted; the card's text announces the status.
 */
export function SnailLoader({ idleOnly = false }: { idleOnly?: boolean }) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const svg = ref.current?.querySelector('svg')
    if (svg) continueSnailAnimation(svg, idleOnly)
  }, [idleOnly])
  // ⚠️ One `{ __html }` object per instance. React 19 writes `innerHTML` again whenever the
  // object is a NEW one, even with the same string, and a re-inserted SVG restarts its CSS
  // animations at 0 — so every re-render of a loading stage replayed the skid arrival, inside the
  // workspace too, where it should stand idle. The layout effect only runs on mount and cannot
  // catch that (01.10.2026).
  const html = useMemo(() => ({ __html: snailSvg.replaceAll('fs-', `fs${id.replace(/[^a-zA-Z0-9_-]/g, '')}-`) }), [id])
  return <div ref={ref} className="snail-loader" aria-hidden="true" dangerouslySetInnerHTML={html} />
}
