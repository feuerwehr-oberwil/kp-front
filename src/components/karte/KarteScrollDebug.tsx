// DIAGNOSTIC, opt-in (review round 5, 18.10.2026 — remove once the owner's iPhone capture is in):
// `/karte?debug=scroll` shows, live, what decides whether the phone's search sheet or the page moves
// under a finger — what WebKit on Linux cannot show (no native touch scroll, no software keyboard;
// e2e/karte-search-scroll.mjs models both). Sticky for the browser tab (sessionStorage) because the
// Karte rewrites its address; `?debug=off` ends it.
//
// Lines: the visual viewport (height · offsetTop = iOS's pan · scale) against innerHeight and
// window.scrollY; `data-kb` on the root and on the sheet with its --ks-bottom/--ks-max; the field's
// and the sheet's top ON THE SCREEN (layout px less the pan) and the list's scrollTop/max; and the
// last touch: where it started, and per touchmove «.» passed, «X» cancelled by a guard, «-» not
// cancelable (iOS is already scrolling). Written to the DOM per frame, never a React render; it
// takes no touches (pointer-events: none) and lies over the top bar, riding with it (--vv-pan).

import { useEffect, useRef, useState } from 'react'

const KEY = 'kp.debug.scroll'

function wanted(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('debug')
    if (q === 'scroll') sessionStorage.setItem(KEY, '1')
    else if (q === 'off') sessionStorage.removeItem(KEY)
    return sessionStorage.getItem(KEY) === '1'
  } catch { return false }
}

const r = (n: number | undefined) => (n == null ? '–' : String(Math.round(n)))
const named = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0].slice(0, 18)}` : ''}` : '–')

export function KarteScrollDebug() {
  const [on] = useState(wanted)
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (!on) return
    let frame = 0
    let touch = { from: '–', moves: '' }
    const start = (e: TouchEvent) => { touch = { from: named(e.target instanceof Element ? e.target : null), moves: '' } }
    // on window, bubbling: after the document-level guards (useTypingLock, useMobileScrollLock) decided
    const move = (e: TouchEvent) => { if (touch.moves.length < 40) touch.moves += !e.cancelable ? '-' : e.defaultPrevented ? 'X' : '.' }
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const el = ref.current
      if (!el) return
      const vv = window.visualViewport
      const pan = vv?.offsetTop ?? 0
      const sheet = document.querySelector<HTMLElement>('[data-karte-keysheet]')
      const field = sheet?.querySelector('input')
      const list = sheet?.querySelector<HTMLElement>('.lc-body')
      const top = (n: Element | null | undefined) => (n ? r(n.getBoundingClientRect().top - pan) : '–')
      el.textContent = [
        `vv h ${r(vv?.height)} pan ${r(pan)} ×${vv?.scale?.toFixed(2) ?? '–'} · inner ${window.innerHeight} · scrollY ${r(window.scrollY)}`,
        `kb root ${document.documentElement.hasAttribute('data-kb') ? 'on' : 'off'} · sheet ${sheet?.hasAttribute('data-kb') ? `on ${sheet.style.getPropertyValue('--ks-bottom')}/${sheet.style.getPropertyValue('--ks-max')}` : 'off'}`,
        `screen top: sheet ${top(sheet)} field ${top(field)} · list ${list ? `${r(list.scrollTop)}/${r(list.scrollHeight - list.clientHeight)}` : '–'}`,
        `focus ${named(document.activeElement)}`,
        `touch ${touch.from} ${touch.moves}`,
      ].join('\n')
    }
    document.addEventListener('touchstart', start, { passive: true, capture: true })
    window.addEventListener('touchmove', move, { passive: true })
    draw()
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('touchstart', start, { capture: true })
      window.removeEventListener('touchmove', move)
    }
  }, [on])
  if (!on) return null
  return (
    <pre ref={ref} aria-hidden="true" data-debug-scroll=""
      style={{ position: 'fixed', left: 4, right: 4, top: 'calc(env(safe-area-inset-top) + 2px)', transform: 'translateY(var(--vv-pan, 0px))', zIndex: 2147483647, margin: 0, padding: '4px 6px',
        font: '10px/1.35 ui-monospace, Menlo, monospace', color: '#0f0', background: 'rgba(0,0,0,.78)', borderRadius: 6, pointerEvents: 'none', whiteSpace: 'pre-wrap' }} />
  )
}
