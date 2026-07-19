import { useEffect, useState } from 'react'

// Reactive night-mode flag. The theme toggle (MapUtility) flips `<html data-theme>`
// imperatively via applyTheme() rather than through React state, so anything that must
// react to it — e.g. MapLibre raster paint, which lives outside the prop tree — reads it
// here and re-renders when the attribute changes.
export function useNightTheme(): boolean {
  const [night, setNight] = useState(() => document.documentElement.dataset.theme === 'night')
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setNight(el.dataset.theme === 'night'))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return night
}
