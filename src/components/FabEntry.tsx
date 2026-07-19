import { useEffect, useState } from 'react'
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

  return (
    <button
      className={`fab-entry ${recording ? 'rec' : ''}`}
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
