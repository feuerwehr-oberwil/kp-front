import { appConfig } from '../config/appConfig'
import { safetyMissing, truppHeadName } from '../lib/atemschutz'
import { fillTemplate } from '../lib/format'
import { useMeldung } from '../lib/useMeldung'
import type { Trupp } from '../types'

// «Kein Sicherungstrupp bereit» as a STANDING Meldeleiste row (FEEDBACK.1, 17.11.2026, lead's
// call): while an Atemschutz-Trupp is inside and nobody stands ready to go in after it
// (lib/atemschutz · safetyMissing). It replaces the one-shot toast at the Eintritt, which vanished
// after a few seconds and on the Atemschutz-Link never showed at all. On EVERY surface, the board
// and the Link included (`meldungen · MELDUNG_RANK.safety`, in `linkShowsMeldung`): the board
// names no missing Sicherungstrupp anywhere else. No ✕ – it clears itself the moment one is ready
// or the crew is out. Calm (`warn`): it is a fact about the cover, not a clock running out.
export function SafetyMissingMeldung({ trupps, onGoToBoard }: {
  trupps: readonly Trupp[]
  /** «Zu den Trupps» – absent where the board is already in front (it, or the Link, IS the board):
   *  the row stays, it just needs no way there */
  onGoToBoard?: () => void
}) {
  const az = appConfig.copy.atemschutz
  const inside = safetyMissing(trupps)
  // ⚠️ Named as the clock rows name them (atemschutz · truppHeadName), never «Trupp 2» (hunt
  // 24.11.2026, ux-3am F1, owner pick «Namen in der Meldung»): the row under this warning says
  // «Bachmann Reto», and with three crews inside nobody should have to recall which number is whose.
  const names = inside.map(truppHeadName).join(', ')
  useMeldung(inside.length ? {
    id: 'safety:missing',
    kind: 'safety',
    tone: 'warn',
    icon: 'warn',
    title: az.notfall.noSafetyHint,
    sub: fillTemplate(az.notfall.noSafetySub, { names }),
    subLines: 2,
    actions: onGoToBoard ? [{ label: az.notfall.noSafetyGo, onClick: onGoToBoard }] : undefined,
  } : null)
  return null
}
