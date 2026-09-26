import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from '../lib/format'
import { fmtAway, gpsLineNames, type GpsNotice } from '../lib/gpsReturn'
import { useMeldung } from '../lib/useMeldung'
import type { Meldung } from '../lib/meldungen'

// A vehicle that drawn Leitungen are coupled to has driven off — or come back. ONE row per vehicle
// and question (lib/gpsReturn · gpsNotices): two hoses on one TLF are one row naming both lines,
// and a tap acts on every end of that vehicle.
//
// It belongs in the Meldeleiste rather than on the map even though it is ABOUT a map object:
// what it reports is that the vehicle has driven off, so its anchor is precisely the thing that
// is no longer on screen. A label pinned to it would be off-canvas by the time it mattered.
//
// ⚠️ The SAFE move is the primary one, and it is green (D3-a, 24.09.2026). Until then «Weiter
// folgen» led, as «the recoverable half» — and in the Übung on 23.09.2026 it was tapped for a TLF
// that already stood back at its depot, which drew the drive into the hose line and printed it on
// the Rapport. The row now says how far away the vehicle is, and the move that keeps the line on
// site comes first. «Weiter folgen» stays, quiet, and is itself recoverable: it keeps the on-site
// line (`gps.before`).
//
// Three shapes, one per `GpsNotice.kind`:
//   away    «TLF fährt weg · 340 m vom Einsatzort» — Am Einsatzort lassen · Weiter folgen
//   stopped «TLF · 1.1 km vom Einsatzort» — Zurück auf Stand am Einsatzort (or, without a kept
//           on-site line, Hier lösen) · Weiter folgen · ✕ (a traced hose may be meant to stay)
//   back    «TLF wieder am Einsatzort» — Zurück auf Stand am Einsatzort · Weiter folgen (= «not
//           now»: asked once per return, see gpsReturn · useGpsNotices)
function gpsMeldung(n: GpsNotice, label: string, on: { keep: () => void; revert: () => void; follow: () => void; dismiss: () => void }): Meldung {
  const C = appConfig.copy.drawingEditor
  const distance = n.distanceM != null ? fmtAway(n.distanceM) : null
  const time = n.before ? formatTime(new Date(n.before.at)) : ''
  const lines = gpsLineNames(n.ends.map((e) => e.drawing))
  const many = new Set(n.ends.map((e) => e.drawing.id)).size > 1
  const follow = { label: C.gpsContinue, onClick: on.follow }
  const base = { id: `gps:${n.key}`, kind: 'gps' as const }
  if (n.kind === 'away') return {
    ...base, tone: 'warn', icon: 'warn',
    title: distance ? fillTemplate(C.gpsAwayTitle, { vehicle: label, distance }) : fillTemplate(C.gpsAwayTitleBare, { vehicle: label }),
    sub: fillTemplate(many ? C.gpsAwaySubMany : C.gpsAwaySub, { lines }),
    actions: [{ label: C.gpsKeepOnSite, primary: true, go: true, onClick: on.keep }, follow],
  }
  if (n.kind === 'stopped') return {
    ...base, tone: 'warn', icon: 'truck',
    title: distance ? fillTemplate(C.gpsStoppedTitle, { vehicle: label, distance }) : fillTemplate(C.gpsStoppedTitleBare, { vehicle: label }),
    sub: fillTemplate(many ? C.gpsStoppedSubMany : C.gpsStoppedSub, { lines }),
    // without a kept on-site line there is no «Einsatzort» to go back to: the honest move is to let
    // go where the ends stand — not green, it keeps the drive
    actions: n.canRevert
      ? [{ label: C.gpsRevert, primary: true, go: true, onClick: on.revert }, follow]
      : [{ label: C.gpsDetachHere, primary: true, onClick: on.keep }, follow],
    // a traced hose may be meant to stay: waving the row away is legitimate
    dismiss: { label: C.gpsDismiss, onClick: on.dismiss },
  }
  return {
    ...base, tone: 'info', icon: 'pin',
    title: fillTemplate(C.gpsBackTitle, { vehicle: label }),
    sub: fillTemplate(many ? C.gpsBackSubMany : C.gpsBackSub, { lines, time }),
    actions: [{ label: C.gpsRevert, primary: true, go: true, onClick: on.revert }, follow],
  }
}

export function GpsFollowMeldung({ notice, label, onKeep, onRevert, onFollow, onDismiss }: {
  notice: GpsNotice
  /** the vehicle the ends hang off */
  label: string
  /** «Am Einsatzort lassen» (away) / «Hier lösen» (stopped, nothing kept): let go of every end */
  onKeep: () => void
  /** «Zurück auf Stand am Einsatzort»: the snapshotted lines, detached there */
  onRevert: () => void
  /** «Weiter folgen» — on a «back» row: keep following and do not ask again for this return */
  onFollow: () => void
  /** ✕ on a «stopped» row */
  onDismiss: () => void
}) {
  useMeldung(gpsMeldung(notice, label, { keep: onKeep, revert: onRevert, follow: onFollow, dismiss: onDismiss }))
  return null
}
