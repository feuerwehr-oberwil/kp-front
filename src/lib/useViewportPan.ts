import { useEffect } from 'react'

/**
 * Pins the app's chrome to the SCREEN while iOS pans the page under a keyboard.
 *
 * The document itself can no longer scroll (02-base.css · `body { position: fixed }`), which is
 * what stopped the whole app being draggable and stopped `position: fixed` chrome riding up with
 * a focus scroll. What is left is the VISUAL viewport: to keep a focused field above the
 * keyboard iOS pans it, and everything laid out in the layout viewport — which is all of the
 * chrome — appears to slide up with it. A native app's top bar and tab bar do not travel; they
 * stay put and let the keyboard cover what it covers.
 *
 * `visualViewport.offsetTop` is exactly how far that pan has gone, so writing it to `--vv-pan`
 * lets the two bars translate straight back down to where they belong (see 15-mobile.css).
 *
 * ⚠️ CHROME ONLY, never the content. Counter-translating the box that CONTAINS the caret is the
 * feedback loop this app has already been bitten by (see useKeyboardInset): the field moves back
 * under the keyboard, iOS pans further to reveal it, which moves it again. The top bar and the
 * nav rail hold no text field, so moving them cannot make iOS re-aim.
 *
 * ⚠️ Written to the documentElement rather than returned as state. The pan updates continuously
 * while iOS animates, and a per-frame React re-render of the whole workspace is the shape of the
 * battery bug this app has had once already (the media-queue commit storm). A CSS custom property
 * moves the bars on the compositor and costs no render at all.
 */
export function useViewportPan(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let frame = 0
    let last = -1
    const measure = () => {
      frame = 0
      // rounded: sub-pixel churn during the pan animation would rewrite the property on every
      // frame for a difference nobody can see
      const pan = Math.max(0, Math.round(vv.offsetTop))
      if (pan === last) return
      last = pan
      root.style.setProperty('--vv-pan', `${pan}px`)
    }
    const update = () => { if (!frame) frame = requestAnimationFrame(measure) }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      root.style.removeProperty('--vv-pan')
    }
  }, [])
}
