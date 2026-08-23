import { appConfig } from '../config/appConfig'
import { useMeldung } from '../lib/useMeldung'

// A drawn Leitung is attached to a vehicle that has started moving away: keep following it (the
// line traces the route) or cut it loose where it stands. One of these per paused attachment.
//
// It belongs in the Meldeleiste rather than on the map even though it is ABOUT a map object:
// what it reports is that the vehicle has driven off, so its anchor is precisely the thing that
// is no longer on screen. A label pinned to it would be off-canvas by the time it mattered.
export function GpsFollowMeldung({ id, label, onContinue, onDetach }: {
  /** stable per drawing+endpoint, so several paused attachments queue side by side */
  id: string
  /** the vehicle (or the drawing) the attachment hangs off */
  label: string
  onContinue: () => void
  onDetach: () => void
}) {
  const C = appConfig.copy.drawingEditor
  useMeldung({
    id: `gps:${id}`,
    kind: 'gps',
    tone: 'warn',
    icon: 'warn',
    title: C.gpsMovingAway,
    sub: label,
    actions: [
      { label: C.gpsContinue, primary: true, onClick: onContinue },
      { label: C.gpsDetachHere, onClick: onDetach },
    ],
  })
  return null
}
