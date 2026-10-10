import { useCallback, useEffect, useRef, useState } from 'react'
import { latestFrameIndex, pickedFrameIndex, type WeatherRadar } from './weatherLayer'

const STEP_MS = 650
/** Extra ticks the loop rests on the newest frame before starting over. */
const HOLD_TICKS = 3

/**
 * Which radar frame the Karte shows, and the loop over the last hour (components/WeatherLayer ·
 * WeatherRadarControls drives it, the map's radar source reads it). Ported from kp-rueck (R5).
 *
 * Calm by default: it follows the NEWEST frame, paused. The loop runs only when somebody asks
 * for it; stopping lands back on «now». A scrubbed-back frame stays ON THAT FRAME as new ones
 * arrive – the pick is a key, not a position (weatherLayer · pickedFrameIndex) – and falls back
 * to «now» once it has aged out of the hour.
 *
 * In lib, not in the lazy layer module: the source lives inside the map and the controls outside
 * it, so the state has to sit above both.
 */
export function useRadarPlayback(radar: WeatherRadar | null | undefined) {
  const frames = radar?.frames
  const latest = latestFrameIndex(radar)
  const [pickedKey, setPickedKey] = useState<string | null>(null) // null = follow the newest
  const [playing, setPlaying] = useState(false)
  const hold = useRef(0)
  const frameIndex = pickedFrameIndex(radar, pickedKey)

  // The interval reads index and frames through refs, so the step itself is a plain setState –
  // no side effects inside an updater (StrictMode runs those twice).
  const indexRef = useRef(frameIndex)
  const framesRef = useRef(frames)
  useEffect(() => {
    indexRef.current = frameIndex
    framesRef.current = frames
  }, [frameIndex, frames])

  useEffect(() => {
    if (!playing || latest < 1) return
    const timer = setInterval(() => {
      const list = framesRef.current ?? []
      const index = indexRef.current
      const last = list.length - 1
      if (index < last) {
        setPickedKey(list[index + 1].key)
      } else if (hold.current < HOLD_TICKS) {
        hold.current += 1
      } else {
        hold.current = 0
        setPickedKey(list[0]?.key ?? null)
      }
    }, STEP_MS)
    return () => clearInterval(timer)
  }, [playing, latest])

  const pick = useCallback((index: number) => {
    setPlaying(false)
    setPickedKey(index >= latest ? null : frames?.[index]?.key ?? null)
  }, [latest, frames])

  const togglePlaying = useCallback(() => {
    hold.current = 0
    if (playing) {
      setPlaying(false)
      setPickedKey(null)
    } else {
      setPlaying(true)
    }
  }, [playing])

  /** back to the calm state: paused on the newest frame (the layer was switched off) */
  const reset = useCallback(() => { setPlaying(false); setPickedKey(null); hold.current = 0 }, [])

  return { frameIndex, playing, pick, togglePlaying, reset }
}
