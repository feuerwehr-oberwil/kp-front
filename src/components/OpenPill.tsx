import { useLayoutEffect, useRef, type CSSProperties } from 'react'

/** do two screen boxes overlap */
const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/**
 * «Linie offen» – the open drawing's pill at its last point, Lage (`.map-open-pill`, MapView) and
 * Plan (`.wb-open-pill`, Whiteboard) alike. It stands to the RIGHT of the point; where that would
 * put it under the tool dock (`.wb-dock`, the right-edge column the drawing tools open) it stands
 * to the point's LEFT instead (`data-flip`, round 2b: the dock covered it – the chip moves, never
 * the dock). Measured after each render that moves it (`at`); a pan alone re-measures with the next
 * point.
 */
export function OpenPill({ className, text, at, style }: { className: string; text: string; at: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.removeAttribute('data-flip')
    const dock = document.querySelector('.wb-dock')?.getBoundingClientRect()
    if (dock && overlaps(el.getBoundingClientRect(), dock)) el.setAttribute('data-flip', '')
  }, [at])
  return <span ref={ref} className={className} style={style}>{text}</span>
}
