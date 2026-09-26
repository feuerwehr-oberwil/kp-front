import { useEffect, useRef, type MutableRefObject } from 'react'
import { bereichStatusOf, setBereichStatus, zielBereich, type TruppHere } from './suche'
import type { SucheActions } from './useSucheActions'
import type { Trupp } from '../types'

/** A short, stable fingerprint of a Ziel for a derived id («1. OG Trakt 3» → «1-og-trakt-3»). */
const slug = (s: string) => s.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x'

/** In the field — the same test the Atemschutz merge uses (mergeWorkspace · mergeTrupp). */
const inField = (s: string | undefined) => !!s && s !== 'angemeldet' && s !== 'raus'

interface Seen { ziel?: string; auftrag?: string; status: string; entryTime?: string; removed: boolean }

/**
 * The Trupps' half of the Suche (24.09.2026), kept in ONE place so the Atemschutz board itself
 * carries nothing but two optional props (AtemschutzView · sucheItems / zielChoices). Every write
 * here is an OBSERVATION of a Trupp save — made the same way on every editor device, under ids
 * derived from the Trupp, its sortie (`entryTime`) and its Ziel (useSucheActions · observe), so
 * the devices converge on one record and one Verlauf row:
 *
 * 1. A Trupp IN THE FIELD on «Absuchen» with a Ziel makes that place «in Arbeit · Trupp 4» — on
 *    the move into the field (a re-entry with the same Ziel is a new sortie, and marks again), or
 *    when its Ziel changes; a NEW name creates the place first (somebody typed it: that is an
 *    entry, not a preset). A Trupp that never went in marks nothing.
 * 2. A changed Ziel, or a removed Trupp, RELEASES the place it was searching («offen»).
 *
 * ⚠️ Nothing else is created here any more (26.09.2026): step 1 made every storey of the Gebäude
 * an area on the first «Absuchen» — the owner's «nothing preset» took that out.
 *
 * «Raus» asks nothing here: the question «Trupp 4 raus – abgesucht?» stands on the area's own row
 * (lib/suche · pendingAsks), for every editor device, until somebody answers it.
 */
export function useSucheTrupps({ trupps, canEdit, actions, floorName, truppsHere, remoteRef }: {
  /** EVERY Trupp, the removed ones included (their areas are released) */
  trupps: readonly Trupp[]
  canEdit: boolean
  actions: SucheActions
  /** how a step-1 storey is named — a Ziel may still name an old record by it */
  floorName: (floor: number) => string
  truppsHere: readonly TruppHere[]
  /** set by the workspace when a remote hydrate replaced the slices (IncidentWorkspace): the
   *  changes it brought were observed where they were made */
  remoteRef: MutableRefObject<boolean>
}) {
  const prev = useRef<Map<string, Seen> | null>(null)
  const live = useRef({ actions, floorName, truppsHere, canEdit })
  useEffect(() => { live.current = { actions, floorName, truppsHere, canEdit } })

  useEffect(() => {
    const before = prev.current
    prev.current = new Map(trupps.map((t) => [t.id, { ziel: t.ziel?.trim(), auftrag: t.auftrag, status: t.status, entryTime: t.entryTime, removed: !!t.removedAt }]))
    const remote = remoteRef.current
    remoteRef.current = false
    const L = live.current
    if (!L.canEdit || remote || !before) return // the first look is the baseline, never an event
    const A = L.actions
    // what a Ziel resolves to without writing anything (the place it names, or null for a new one)
    const peek = (ziel: string) => zielBereich(A.latest(), ziel, { at: '', newId: () => '', floorName: L.floorName }).id
    for (const t of trupps) {
      const was = before.get(t.id)
      const label = L.truppsHere.find((x) => x.id === t.id)?.label ?? t.name
      const ziel = t.ziel?.trim()
      const searching = !t.removedAt && t.auftrag === 'absuchen' && !!ziel && inField(t.status)
      const wentIn = inField(t.status) && !inField(was?.status)
      const changed = !!was && (was.ziel !== ziel || was.auftrag !== t.auftrag)
      const sortie = `t${t.id}-${slug(t.entryTime ?? 'x')}`
      // 2 · release what it no longer searches: a new Ziel, another Auftrag, or the Trupp removed
      if ((changed || (t.removedAt && !was?.removed)) && was) {
        const keepId = searching ? peek(ziel!) : null
        const mine = A.latest().bereiche.filter((b) => { const st = bereichStatusOf(b); return st.status === 'inArbeit' && st.truppId === t.id && b.id !== keepId })
        for (const b of mine) A.observe(`${sortie}-r-${slug(b.id)}-${slug(ziel ?? 'weg')}`, (doc, cx) => setBereichStatus(doc, b.id, 'offen', undefined, cx))
      }
      // 1 · the Ziel's place «in Arbeit» — on the way in, or when the Ziel changes in the field
      if (searching && (wentIn || changed)) {
        const key = `${sortie}-${slug(ziel!)}`
        A.observe(`${key}-a`, (doc, cx) => zielBereich(doc, ziel!, cx))
        const id = peek(ziel!)
        if (id) A.observe(`${key}-b`, (doc, cx) => setBereichStatus(doc, id, 'inArbeit', { label, id: t.id }, cx))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trupps])
}
