import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from '../lib/format'
import { fmtAway, type GpsNotice } from '../lib/gpsReturn'
import { useMeldung } from '../lib/useMeldung'
import type { Meldung } from '../lib/meldungen'

// A drawn Leitung is coupled to a vehicle that has driven off — or come back. One row per GPS end
// the strip has something to say about (lib/gpsReturn · gpsNotices).
//
// It belongs in the Meldeleiste rather than on the map even though it is ABOUT a map object:
// what it reports is that the vehicle has driven off, so its anchor is precisely the thing that
// is no longer on screen. A label pinned to it would be off-canvas by the time it mattered.
//
// ⚠️ The SAFE move is the primary one, and it is green (D3-a, 24.09.2026). Until then «Weiter
// folgen» led, as «the recoverable half» — and on 23.09.2026 it was tapped at 22:31 for a TLF
// that had stood at the Magazin since 22:14, which drew the drive into the hose line and printed
// it on the Rapport. A Leitung almost never follows a vehicle off the site; the row now says how
// far away the vehicle is, and «Am Einsatzort lassen» is the move it offers first. «Weiter
// folgen» stays, quiet, and is itself recoverable now: it keeps the on-site line (`gps.before`).
//
// Three shapes, one per `GpsNotice.kind`:
//   away    «TLF fährt weg · 340 m vom Einsatzort» — Am Einsatzort lassen · Weiter folgen
//   stopped «TLF · 1.1 km vom Einsatzort» — Zurück auf Stand am Einsatzort · Weiter folgen
//   back    «TLF wieder am Einsatzort» — Zurück auf Stand am Einsatzort · Weiter folgen (= «not
//           now»: asked once per return, see gpsReturn · useBackOffers)
function gpsMeldung(n: GpsNotice, label: string, on: { keep: () => void; revert: () => void; follow: () => void }): Meldung {
  const C = appConfig.copy.drawingEditor
  const distance = n.distanceM != null ? fmtAway(n.distanceM) : null
  const time = n.before ? formatTime(new Date(n.before.at)) : ''
  const follow = { label: C.gpsContinue, onClick: on.follow }
  const base = { id: `gps:${n.key}`, kind: 'gps' as const }
  if (n.kind === 'away') return {
    ...base, tone: 'warn', icon: 'warn',
    title: distance ? fillTemplate(C.gpsAwayTitle, { vehicle: label, distance }) : fillTemplate(C.gpsAwayTitleBare, { vehicle: label }),
    sub: C.gpsAwaySub,
    actions: [{ label: C.gpsKeepOnSite, primary: true, go: true, onClick: on.keep }, follow],
  }
  if (n.kind === 'stopped') return {
    ...base, tone: 'warn', icon: 'truck',
    title: distance ? fillTemplate(C.gpsStoppedTitle, { vehicle: label, distance }) : fillTemplate(C.gpsStoppedTitleBare, { vehicle: label }),
    sub: C.gpsStoppedSub,
    actions: [{ label: C.gpsRevert, primary: true, go: true, onClick: on.revert }, follow],
  }
  return {
    ...base, tone: 'info', icon: 'pin',
    title: fillTemplate(C.gpsBackTitle, { vehicle: label }),
    sub: fillTemplate(C.gpsBackSub, { time }),
    actions: [{ label: C.gpsRevert, primary: true, go: true, onClick: on.revert }, follow],
  }
}

export function GpsFollowMeldung({ notice, label, onKeep, onRevert, onFollow }: {
  notice: GpsNotice
  /** the vehicle (or the drawing) the attachment hangs off */
  label: string
  /** «Am Einsatzort lassen»: let go, the end where it stands on site */
  onKeep: () => void
  /** «Zurück auf Stand am Einsatzort»: the snapshotted line, detached there */
  onRevert: () => void
  /** «Weiter folgen» — on a «back» row: keep following and do not ask again for this return */
  onFollow: () => void
}) {
  useMeldung(gpsMeldung(notice, label, { keep: onKeep, revert: onRevert, follow: onFollow }))
  return null
}
