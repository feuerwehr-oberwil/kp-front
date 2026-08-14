import { useEffect, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fmtMMSS } from '../lib/geo'
import { useHoldEntry } from '../lib/useHoldEntry'
import { HoldTargets } from './HoldTargets'

// Mobile field-capture FAB. Same tap / long-hold gesture as the TopBar "Eintrag": tap opens
// the composer, hold offers Sprachnotiz · Foto, tap-while-recording stops it. The hold acts on
// RELEASE — two targets rise above the circle and the finger slides onto one; release without
// moving and you get the voice memo (see lib/useHoldEntry).
export function FabEntry({ recording, recStartedAt, onTap, onHoldStart, onHoldStop, onHoldPhoto }: {
  recording: boolean
  recStartedAt: number | null
  onTap: () => void
  onHoldStart: () => void
  onHoldStop: () => void
  onHoldPhoto?: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [recording])
  const recSec = recording && recStartedAt ? Math.max(0, Math.round((now - recStartedAt) / 1000)) : 0
  const { pressing, latched, hover, handlers } = useHoldEntry({ recording, onTap, onHoldStart, onHoldStop, onHoldPhoto })

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
      // `latched` only lifts the button's `overflow: hidden` (there for the charging cue) so
      // the slide targets can sit outside its bounds
      className={`fab-entry ${recording ? 'rec' : ''} ${quiet ? 'quiet' : ''} ${latched ? 'latched' : ''}`}
      aria-label={recording ? appConfig.copy.journal.recordStop : appConfig.copy.journal.add}
      title={recording ? appConfig.copy.journal.recordStop : appConfig.copy.journal.addHint}
      {...handlers}
    >
      {pressing && !recording && <span className="tb-hold" />}
      {latched && <HoldTargets hover={hover} placement="above" />}
      {recording
        ? <><span className="tb-stop" /><span>{fmtMMSS(recSec)}</span></>
        : <><Icon id="plus" /><span>{appConfig.copy.journal.add}</span></>}
    </button>
  )
}
