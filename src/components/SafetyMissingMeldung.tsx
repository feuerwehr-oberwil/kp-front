import { appConfig } from '../config/appConfig'
import { safetyMissing } from '../lib/atemschutz'
import { fillTemplate } from '../lib/format'
import { requestSafetyPick, safetyPickItems } from '../lib/safetyPick'
import { useMeldung } from '../lib/useMeldung'
import type { Trupp } from '../types'

// «Kein Sicherungstrupp bereit» as a STANDING Meldeleiste row (FEEDBACK.1, 17.11.2026, lead's
// call): while an Atemschutz-Trupp is inside and nobody stands ready to go in after it
// (lib/atemschutz · safetyMissing). It replaces the one-shot toast at the Eintritt, which vanished
// after a few seconds and on the Atemschutz-Link never showed at all. On EVERY surface, the board
// and the Link included (`meldungen · MELDUNG_RANK.safety`, in `linkShowsMeldung`): the board
// names no missing Sicherungstrupp anywhere else. No ✕ – it clears itself the moment one is ready
// or the crew is out. Calm (`warn`): it is a fact about the cover, not a clock running out.
//
// ⚠️ The row says the state and carries the act (owner pick UX journeys M·16, 25.11.2026,
// «Knopf «Bestimmen»»; it named the crews inside, by number until 24.11.2026 and then by name, and
// told the reader to register a «Sichern» Trupp themselves): «3 Trupps drin», and «Bestimmen»
// opens the board's own choice «Sicherungstrupp bestimmen» (lib/safetyPick – the Notfall banner's
// candidates, Bereit · Drin · Draussen, then a new Trupp). A pick brings the board forward and the
// board answers it. Only where this session may write the Trupps (`canPick`, the Link included);
// a viewer keeps «Zu den Trupps».
export function SafetyMissingMeldung({ trupps, onGoToBoard, canPick = false }: {
  trupps: readonly Trupp[]
  /** brings the board forward – absent where it is already in front (it, or the Link, IS the
   *  board): «Zu den Trupps» then goes, and a pick needs no way there */
  onGoToBoard?: () => void
  /** this session may write the Trupps – «Bestimmen» instead of «Zu den Trupps» */
  canPick?: boolean
}) {
  const nf = appConfig.copy.atemschutz.notfall
  const inside = safetyMissing(trupps)
  const sub = inside.length === 1 ? nf.noSafetySubOne : fillTemplate(nf.noSafetySub, { n: inside.length })
  const pickMenu = safetyPickItems(trupps, (p) => { onGoToBoard?.(); requestSafetyPick(p) })
  useMeldung(inside.length ? {
    id: 'safety:missing',
    kind: 'safety',
    tone: 'warn',
    icon: 'warn',
    title: nf.noSafetyHint,
    sub,
    actions: canPick ? [{ label: appConfig.copy.atemschutz.safetyPick, menu: pickMenu }]
      : onGoToBoard ? [{ label: nf.noSafetyGo, onClick: onGoToBoard }] : undefined,
  } : null)
  return null
}
