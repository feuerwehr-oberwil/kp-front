import { useEffect, useState } from 'react'

/**
 * Height (px) the on-screen keyboard currently occupies, via the VisualViewport API.
 * 0 when no keyboard is shown. Lets a bottom sheet lift its content above the iOS/Android
 * keyboard instead of hiding behind it.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      setInset(kb)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return inset
}
