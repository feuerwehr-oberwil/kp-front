import { useEffect, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fmtMMSS } from '../lib/geo'
import { useHoldEntry } from '../lib/useHoldEntry'

// Mobile field-capture FAB. Same tap / long-hold gesture as the TopBar "Eintrag":
// tap opens the composer, hold starts a (latched) voice memo, tap-while-recording stops it.
export function FabEntry({ recording, recStartedAt, onTap, onHoldStart, onHoldStop }: {
  recording: boolean
  recStartedAt: number | null
  onTap: () => void
  onHoldStart: () => void
  onHoldStop: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [recording])
  const recSec = recording && recStartedAt ? Math.max(0, Math.round((now - recStartedAt) / 1000)) : 0
  const { pressing, handlers } = useHoldEntry({ recording, onTap, onHoldStart, onHoldStop })

  // The circle steps back while something under it is being scrolled, so the row / curve it
  // covers can be read during the gesture. Scroll does not bubble, hence the capture listener:
  // one for every scroller in the app. State flips exactly TWICE per gesture (in, and out on the
  // idle timer) — a setState per scroll event is the shape of the battery bug this app already
  // had once (see the media-queue commit storm), and it is not needed for two class changes.
  const [quiet, setQuiet] = useState(false)
  const quietRef = useRef(false)
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      if (!quietRef.current) { quietRef.current = true; setQuiet(true) }
      clearTimeout(idle)
      idle = setTimeout(() => { quietRef.current = false; setQuiet(false) }, 400)
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      clearTimeout(idle)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [])

  return (
    <button
      className={`fab-entry ${recording ? 'rec' : ''} ${quiet ? 'quiet' : ''}`}
      aria-label={recording ? appConfig.copy.journal.recordStop : appConfig.copy.journal.add}
      title={recording ? appConfig.copy.journal.recordStop : appConfig.copy.journal.addHint}
      {...handlers}
    >
      {pressing && !recording && <span className="tb-hold" />}
      {recording
        ? <><span className="tb-stop" /><span>{fmtMMSS(recSec)}</span></>
        : <><Icon id="plus" /><span>{appConfig.copy.journal.add}</span></>}
    </button>
  )
}
