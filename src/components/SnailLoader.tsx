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
