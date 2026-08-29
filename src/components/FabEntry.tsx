import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fmtMMSS } from '../lib/geo'
import { useHoldEntry } from '../lib/useHoldEntry'
import { HoldChargeRing, HoldTargets } from './HoldTargets'
import { useGeorefMode } from '../lib/georefMode'

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
  const { pressing, pressedSince, latched, hover, anchor, handlers } = useHoldEntry({ recording, onTap, onHoldStart, onHoldStop, onHoldPhoto })
  // ⚠️ Gone while «Karte verknüpfen» is armed. On a phone the mode's bar takes the foot of the
  // screen and this circle floats ON its right end, over «Deckung prüfen» / «Fertig» — a button
  // that opens the journal, parked on top of the two that finish what you are doing. The
  // subscription lives HERE rather than in the shell, so one small component re-renders per
  // tap instead of the whole workspace.
  const georefArmed = !!useGeorefMode().planId

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

  if (georefArmed) return null

  return (
    <button
      className={`fab-entry ${recording ? 'rec' : ''} ${quiet ? 'quiet' : ''} ${latched ? 'cancelling' : ''}`}
      style={latched && anchor ? { width: anchor.width } : undefined}
      aria-label={recording ? appConfig.copy.journal.recordStop : appConfig.copy.journal.add}
      title={recording ? appConfig.copy.journal.recordStop : appConfig.copy.journal.addHint}
      data-hold-target="cancel"
      {...handlers}
    >
      {latched && <HoldTargets hover={hover} placement="above" anchor={anchor} />}
      {recording
        ? <><span className="tb-stop" /><span className="tb-act-label">{fmtMMSS(recSec)}</span></>
        : <>
          {/* ring around the + icon, same as the TopBar Eintrag — never over the label */}
          <span className="tb-act-ic">
            {/* ⚠️ The + is an INLINE path, not a sprite <use> (29.08.). This button was seen in
                the field as a bare dark circle — glyph missing. A `<use href="#plus">` depends
                on the IconSprite's symbol being resolvable in the live document, and WebKit is
                flaky about re-resolving <use> targets across remounts (the FAB itself mounts and
                unmounts with every composer/panel open, and several sprites coexist). The one
                control that logs from the field must not be able to render empty, so it carries
                its own path — same `.i` class, so sizing/stroke are unchanged. */}
            <svg className="i" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            {pressing && pressedSince != null && <HoldChargeRing since={pressedSince} />}
          </span>
          <span className="tb-act-label">{appConfig.copy.journal.add}</span>
        </>}
    </button>
  )
}
