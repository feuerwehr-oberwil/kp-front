// App feel on touch devices: zoom should affect ONLY the map and the plan stage, never
// the surrounding UI chrome. `touch-action` (in app.css) handles most of it, but iOS
// Safari still fires pinch `gesture*` events at the page level — this backstop cancels
// those unless the gesture started on the map/plan, so the chrome can't zoom like a web page.

const ZOOMABLE = '#map, .maplibregl-map, .wb-stage'

export function lockChromeZoom(): void {
  const inZoomable = (t: EventTarget | null) => t instanceof Element && !!t.closest(ZOOMABLE)

  // iOS pinch gesture events — block on the chrome. NOT on a device without touch (macOS Safari
  // emits the same `gesture*` for a trackpad pinch, and there the chrome IS a web page) and not
  // on /admin (long config forms someone may legitimately want to zoom); Cmd+/− kept working
  // either way, the trackpad did not.
  const touch = navigator.maxTouchPoints > 0
  const admin = location.pathname.startsWith('/admin')
  if (touch && !admin) {
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(
        type,
        (e) => { if (!inZoomable(e.target)) e.preventDefault() },
        { passive: false },
      )
    }
  }
  // Multi-finger move on the chrome (pinch) — block; single-finger pan/scroll is untouched.
  document.addEventListener(
    'touchmove',
    (e) => { if (e.touches.length > 1 && !inZoomable(e.target)) e.preventDefault() },
    { passive: false },
  )
}
