import { type CSSProperties, useEffect, useRef, useState } from 'react'

/**
 * Inline style for a modal frame while the keyboard is up — `undefined` at 0, so a surface
 * without a keyboard renders byte-identical DOM. `marginBottom` lifts a bottom-anchored (phone)
 * sheet; a centred sheet ignores the margin and reads `--kb-inset` instead, riding up and
 * capping its height in CSS (`.is-kb`, 13-incident.css). The shared Sheet/Overlay apply it.
 */
export function keyboardLift(inset: number): CSSProperties | undefined {
  return inset > 0 ? ({ marginBottom: inset, '--kb-inset': `${inset}px` } as CSSProperties) : undefined
}

/**
 * Height (px) the on-screen keyboard currently occupies, via the VisualViewport API.
 * 0 when no keyboard is shown. Lets a bottom sheet lift its content above the iOS/Android
 * keyboard instead of hiding behind it.
 *
 * ⚠️ It measures the KEYBOARD only — `innerHeight - visualViewport.height` — and deliberately
 * NOT `visualViewport.offsetTop`. offsetTop is how far the visual viewport has been scrolled
 * inside the layout viewport, and iOS moves it continuously while it scrolls a focused field
 * into view. Subtracting it fed that motion straight back into the sheet's margin: the sheet
 * moved, iOS re-scrolled to keep the caret visible, which moved the sheet again. On a phone
 * with a photo attached — where the composer is already at its max height — that loop is the
 * «typing in the Verlauf glitches out» report from the 09.08. Einsatz.
 *
 * Two more guards against the same class of jitter:
 *   · updates are coalesced into one animation frame, so a burst of scroll events costs one
 *     re-render rather than a dozen;
 *   · a change under `MIN_STEP` px is ignored, so the address bar sliding or a one-line field
 *     growing never moves the sheet. A keyboard opening or closing is always far larger.
 *
 * ⚠️ ANDROID measures through the VirtualKeyboard API instead. index.html opts into
 * `interactive-widget=overlays-content`, and on Android that stops the keyboard from resizing
 * EITHER viewport — `innerHeight - visualViewport.height` reads 0 with the keyboard fully up,
 * which is how the Journaleintrag composer sat behind it (Feldtest 09.09.). Chromium's
 * `navigator.virtualKeyboard.boundingRect` is the one place that geometry still exists; iOS
 * ignores the meta AND lacks the API, so it keeps the visual-viewport arithmetic.
 */
/** px below which a viewport change is not a keyboard appearing or disappearing */
const MIN_STEP = 40

interface VirtualKeyboardLike extends EventTarget {
  overlaysContent: boolean
  boundingRect: DOMRectReadOnly
}

function virtualKeyboard(): VirtualKeyboardLike | undefined {
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard
}

/** The keyboard height RIGHT NOW — one reading, no subscription. VirtualKeyboard API first
 *  (the only truthful source under `overlays-content`), visual viewport otherwise. */
export function keyboardInsetNow(): number {
  const vk = virtualKeyboard()
  if (vk) return Math.max(0, Math.round(vk.boundingRect?.height ?? 0))
  const vv = window.visualViewport
  return vv ? Math.max(0, Math.round(window.innerHeight - vv.height)) : 0
}

/** Where the USABLE screen ends right now, in fixed-position coordinates — the number placement
 *  code (ComboMenu) measures «room below» against. With the VirtualKeyboard API it is the layout
 *  viewport minus the overlaid keyboard; otherwise the visual viewport's bottom edge, offsetTop
 *  included (iOS scrolls the visual viewport while aiming a caret, and fixed elements stay in
 *  LAYOUT coordinates — dropping offsetTop under-measures the room). */
export function visibleViewportBottom(): number {
  const vk = virtualKeyboard()
  if (vk) return window.innerHeight - Math.max(0, Math.round(vk.boundingRect?.height ?? 0))
  const vv = window.visualViewport
  return vv ? vv.offsetTop + vv.height : window.innerHeight
}

/** `enabled` lets a surface that stays MOUNTED while closed (the shared Sheet/Overlay, whose
 *  `open` is parent state) listen only while it is actually on screen; while disabled it reads 0. */
export function useKeyboardInset(enabled = true): number {
  const [inset, setInset] = useState(0)
  // the last value we COMMITTED, read inside the listener without re-subscribing it
  const committed = useRef(0)
  useEffect(() => {
    const vv = window.visualViewport
    const vk = virtualKeyboard()
    if (!enabled || (!vv && !vk)) return
    // idempotent, and only states what index.html's `interactive-widget=overlays-content`
    // already asked for — but the API only reports geometry once this flag is set from script
    if (vk) vk.overlaysContent = true
    let frame = 0
    const measure = () => {
      frame = 0
      const kb = keyboardInsetNow()
      // treat anything below the step as «no change» — EXCEPT the way back to 0: iOS can close
      // the keyboard in stages (or land a hair off), and a swallowed final step left a dialog
      // permanently squeezed to the top half of the screen (Feldtest 08.09., «Tastatur fehlt»)
      if (kb !== 0 && Math.abs(kb - committed.current) < MIN_STEP) return
      if (kb === committed.current) return
      committed.current = kb
      setInset(kb)
    }
    const update = () => { if (!frame) frame = requestAnimationFrame(measure) }
    // iOS does not always fire a visualViewport event for a dismissal (scroll-to-dismiss, the
    // accessory hide key inside a focus trap) — re-measure a beat after focus leaves any field,
    // once mid-animation and once after it has settled
    let late: ReturnType<typeof setTimeout>[] = []
    const onFocusOut = () => {
      late.forEach(clearTimeout)
      late = [setTimeout(update, 250), setTimeout(update, 700)]
    }
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    vk?.addEventListener('geometrychange', update)
    window.addEventListener('focusout', onFocusOut)
    update()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      late.forEach(clearTimeout)
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      vk?.removeEventListener('geometrychange', update)
      window.removeEventListener('focusout', onFocusOut)
      // a sheet that closes with the keyboard up must not reopen lifted by a stale value
      committed.current = 0
      setInset(0)
    }
  }, [enabled])
  return inset
}
