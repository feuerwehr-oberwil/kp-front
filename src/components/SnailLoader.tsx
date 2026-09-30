import { useId } from 'react'
import snailSvg from '../../public/firefighter-snail-loader.svg?raw'

/**
 * Shared loading mascot. Vite inlines this same SVG into index.html's boot splash,
 * so the first paint needs no external resources and React takes over at the same size.
 * The SVG owns motion, station accent and reduced-motion styles. Instance-specific ids
 * keep gradients independent when two loading surfaces are mounted at the same time.
 * Only this trusted, bundled artwork is inserted; the card's text announces the status.
 */
export function SnailLoader() {
  const id = useId()
  const artwork = snailSvg.replaceAll('fs-', `fs${id.replace(/[^a-zA-Z0-9_-]/g, '')}-`)
  return <div className="snail-loader" aria-hidden="true" dangerouslySetInnerHTML={{ __html: artwork }} />
}
