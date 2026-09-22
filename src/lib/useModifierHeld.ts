import { useEffect, useState } from 'react'

/**
 * True while ⌘ / Ctrl / Alt is held down — the moment a keyboard shortcut is about to be used.
 * The rail's key badges (NavRail · .nav-key) show only then (22.09.2026): standing on every icon
 * they read as status marks, and the letters are wanted exactly when the modifier is down.
 * Released on keyup, on the window losing focus (a ⌘-Tab away never sends the keyup), and on
 * any keydown without a modifier (a stuck state after a system shortcut).
 */
export function useModifierHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const read = (e: KeyboardEvent) => setHeld(e.metaKey || e.ctrlKey || e.altKey)
    const off = () => setHeld(false)
    window.addEventListener('keydown', read)
    window.addEventListener('keyup', read)
    window.addEventListener('blur', off)
    document.addEventListener('visibilitychange', off)
    return () => {
      window.removeEventListener('keydown', read)
      window.removeEventListener('keyup', read)
      window.removeEventListener('blur', off)
      document.removeEventListener('visibilitychange', off)
    }
  }, [])
  return held
}
