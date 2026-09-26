import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import type { BereichView } from '../../lib/suche'
import type { SucheActions } from '../../lib/useSucheActions'
import { useMeldung } from '../../lib/useMeldung'

/**
 * «Trupp 2 raus – EG abgesucht?» in the Meldeleiste, one row per open question (walk-through
 * 25.09.2026, N13). The question used to stand only on the area's row in Suche › Bereiche, and
 * nobody who was not looking at that tab ever saw it. It is DERIVED like the row (lib/suche ·
 * pendingAsks), so it goes by itself the moment anybody answers — here, on the row, or on another
 * device — and it has no ✕: the answer is the only way to dismiss it.
 *
 * Two buttons at most in a Meldeleiste row: «Ja» and «Teilweise» answer in place; «Nein» (and
 * everything else) is one tap away on the title, which opens the Suche on that area.
 */
export function SucheAskMeldungen({ asks, actions, onOpen }: {
  asks: readonly BereichView[]
  actions: SucheActions
  onOpen: (bereichId: string) => void
}) {
  return <>{asks.map((u) => <SucheAskMeldung key={u.id} u={u} actions={actions} onOpen={onOpen} />)}</>
}

function SucheAskMeldung({ u, actions, onOpen }: { u: BereichView; actions: SucheActions; onOpen: (bereichId: string) => void }) {
  const C = appConfig.copy.suche
  const trupp = { label: u.trupp, id: u.truppId }
  useMeldung({
    id: `suche-ask:${u.id}`,
    kind: 'suche',
    tone: 'warn',
    icon: 'search',
    title: fillTemplate(C.askMeldung, { trupp: u.trupp ?? '', bereich: u.full }),
    onOpen: { label: C.askMeldungOpen, onClick: () => onOpen(u.id) },
    actions: [
      { label: C.rausJa, onClick: () => { actions.setStatus(u.id, 'abgesucht', trupp) } },
      { label: C.rausTeilweise, onClick: () => { actions.setStatus(u.id, 'teilweise', trupp) } },
    ],
  })
  return null
}
