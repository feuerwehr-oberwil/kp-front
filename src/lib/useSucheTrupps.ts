import { useEffect, useRef, type MutableRefObject } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { addBereich, bereichStatusOf, findBereichByName, parseZiel, setBereichStatus, type TruppHere } from './suche'
import type { SucheActions } from './useSucheActions'
import { confirmDialog } from './ui'
import type { SucheDoc, Trupp } from '../types'

/** A short, stable fingerprint of a Ziel for a derived id («1. OG Trakt 3» → «1og-trakt-3»). */
const slug = (s: string) => s.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x'

/**
 * The Trupps' half of the Suche (24.09.2026), kept in ONE place so the Atemschutz board itself
 * carries nothing but two optional props (AtemschutzView · sucheItems / zielChoices):
 *
 * 1. The first Trupp sent to «Absuchen» makes every storey its «ganzes Geschoss» (E6 «von selbst»).
 * 2. A Trupp on «Absuchen» with a Ziel makes that area «in Arbeit · Trupp 4»; a NEW name creates
 *    the area first — on the storey the Ziel names («1. OG Aula»), else the one the Trupp's
 *    marker stands on. Observed on every editor device → written under DERIVED ids
 *    (useSucheActions · observe), so they converge on one record and one Verlauf row.
 * 3. At «Raus», THIS device asks once per area the Trupp was searching: «Trupp 4: 1. OG Trakt 3
 *    abgesucht?» Ja / Teilweise / Nein. Only the device that saw the change happen locally asks —
 *    a Raus that arrived through a merge (`remoteRef`) is somebody else's question.
 */
export function useSucheTrupps({ trupps, suche, canEdit, actions, floors, floorName, placed, truppsHere, remoteRef }: {
  trupps: readonly Trupp[]
  suche: SucheDoc
  canEdit: boolean
  actions: SucheActions
  floors: readonly number[]
  floorName: (f: number) => string
  placed: readonly { truppId: string; floor: number }[]
  truppsHere: readonly TruppHere[]
  /** set by the workspace when a remote hydrate replaced the slices (IncidentWorkspace) */
  remoteRef: MutableRefObject<boolean>
}) {
  const prev = useRef<Map<string, { ziel?: string; auftrag?: string; status: string }> | null>(null)
  const live = useRef({ suche, actions, floors, floorName, placed, truppsHere, canEdit })
  useEffect(() => { live.current = { suche, actions, floors, floorName, placed, truppsHere, canEdit } })

  const askAtRaus = async (truppId: string, label: string) => {
    const L = live.current
    const C = appConfig.copy.suche
    const areas = L.suche.bereiche.filter((b) => {
      const st = bereichStatusOf(b)
      return st.status === 'inArbeit' && st.truppId === truppId
    })
    for (const b of areas) {
      const name = b.name ? (b.floor != null ? fillTemplate(C.rowPart, { floor: L.floorName(b.floor), name: b.name }) : b.name) : b.floor != null ? L.floorName(b.floor) : ''
      const answer = await confirmDialog({
        title: fillTemplate(C.rausAsk, { trupp: label, bereich: name }),
        message: C.rausAskHint,
        confirmLabel: C.rausJa,
        altLabel: C.rausTeilweise,
        cancelLabel: C.rausNein,
      })
      const A = live.current.actions
      if (answer === true) A.setStatus(b.id, 'abgesucht', { label, id: truppId })
      else if (answer === 'alt') A.setStatus(b.id, 'offen', undefined, C.teilweiseAbgesucht)
      else A.setStatus(b.id, 'offen')
    }
  }
  useEffect(() => {
    const before = prev.current
    prev.current = new Map(trupps.map((t) => [t.id, { ziel: t.ziel, auftrag: t.auftrag, status: t.status }]))
    const remote = remoteRef.current
    remoteRef.current = false
    const L = live.current
    if (!L.canEdit) return
    // 1 · the storeys, once somebody searches (idempotent: nothing is written twice)
    if (trupps.some((t) => t.auftrag === 'absuchen' && t.status !== 'raus')) L.actions.seed(L.floors)
    if (!before) return // the first look is the baseline, never an event
    for (const t of trupps) {
      const was = before.get(t.id)
      const label = L.truppsHere.find((x) => x.id === t.id)?.label ?? t.name
      // 2 · Ziel → area «in Arbeit»
      const ziel = t.ziel?.trim()
      if (t.auftrag === 'absuchen' && ziel && t.status !== 'raus' && (was?.ziel !== t.ziel || was?.auftrag !== t.auftrag)) {
        const markerFloor = L.placed.find((p) => p.truppId === t.id)?.floor
        const key = `t${t.id}-${slug(ziel)}`
        let id = findBereichByName(L.suche, ziel, markerFloor, L.floorName)
        if (!id) {
          const z = parseZiel(ziel, L.floors, L.floorName, markerFloor)
          if (z.name) {
            L.actions.observe(`${key}-a`, (doc, cx) => {
              const r = addBereich(doc, { name: z.name!, floor: z.floor }, cx)
              id = r.id
              return r
            })
          }
        }
        if (id) {
          const target = id
          L.actions.observe(`${key}-b`, (doc, cx) => setBereichStatus(doc, target, 'inArbeit', { label, id: t.id }, cx))
        }
      }
      // 3 · Raus → «abgesucht?», asked on the device that saw it happen
      if (!remote && was && was.status !== 'raus' && t.status === 'raus') void askAtRaus(t.id, label)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trupps])


}
