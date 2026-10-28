import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate, formatSymbolName } from '../lib/format'
import { grundrissKinds } from '../lib/grundriss'
import { Sheet } from '../lib/overlays'
import type { BoardAnno } from '../types'
import { Button } from './Button'
import { TickRow } from './TickRow'

/** «3 Wände · 4× Durchgang · 1× Treppe» – a Grundriss by kind (lib/grundriss · grundrissKinds) */
function kindLine(items: readonly BoardAnno[]): string {
  const C = appConfig.copy.whiteboard.storeyCopy
  const { walls, symbols } = grundrissKinds(items)
  return [
    ...(walls ? [walls === 1 ? C.wallsOne : fillTemplate(C.walls, { n: walls })] : []),
    ...symbols.map((s) => fillTemplate(C.symbolCount, { n: s.n, name: formatSymbolName(s.symbol) })),
  ].join(' · ')
}

/**
 * «Kopieren nach …» from a Gebäude storey's label menu (Whiteboard) – variant A «Stapel» (owner
 * pick, round 3): the building as rows, top to bottom. The storey copied FROM is shown as the
 * «Vorlage» and cannot be picked; every other row is a checkbox that says what that storey already
 * holds (the copy lands on top of it). One line under the title says what goes, by kind; the one
 * full-width button names the result. The caller copies and commits; the sheet only asks.
 */
export function StoreyCopySheet({ from, storeys, onCopy, onClose }: {
  /** the storey copied FROM */
  from: number
  /** every storey of the stack, top to bottom, with its Grundriss (lib/grundriss · grundrissOf) */
  storeys: { floor: number; name: string; items: readonly BoardAnno[] }[]
  onCopy: (targets: number[]) => void
  onClose: () => void
}) {
  const C = appConfig.copy.whiteboard.storeyCopy
  const [picked, setPicked] = useState<number[]>([])
  const source = storeys.find((s) => s.floor === from)
  const name = source?.name ?? ''
  const has = !!source?.items.length
  const targets = storeys.filter((s) => s.floor !== from).map((s) => s.floor)
  const allPicked = targets.every((f) => picked.includes(f))
  const toggle = (f: number) => setPicked((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]))
  const label = !picked.length ? C.pick
    : picked.length === 1 ? fillTemplate(C.toOne, { name: storeys.find((s) => s.floor === picked[0])?.name ?? '' })
    : fillTemplate(C.toMany, { n: picked.length })
  return (
    <Sheet open onClose={onClose} fit sheetClassName="wb-copy" title={fillTemplate(C.title, { name })}
      footer={has ? (
        <Button variant="primary" block disabled={!picked.length} onClick={() => { onCopy(picked); onClose() }}>{label}</Button>
      ) : undefined}
    >
      {!has ? <p className="wb-copy-what">{fillTemplate(C.nothing, { name })}</p> : (<>
        <p className="wb-copy-what">{kindLine(source.items)}</p>
        <div className="wb-copy-rows" role="group" aria-label={C.targets}>
          {storeys.map((s) => s.floor === from ? (
            <div key={s.floor} className="wb-copy-row wb-copy-src">
              <span className="wb-copy-gap" aria-hidden />
              <b className="wb-copy-name">{s.name}</b>
              <span className="wb-copy-pill">{C.source}</span>
            </div>
          ) : (
            <TickRow key={s.floor} checked={picked.includes(s.floor)} onToggle={() => toggle(s.floor)} className="wb-copy-row">
              <b className="wb-copy-name">{s.name}</b>
              <span className="wb-copy-meta">{s.items.length ? fillTemplate(C.adds, { what: kindLine(s.items) }) : C.empty}</span>
            </TickRow>
          ))}
        </div>
        <div className="wb-copy-foot">
          <span>{C.stays}</span>
          <button type="button" className="wb-copy-all" onClick={() => setPicked(allPicked ? [] : targets)}>{allPicked ? C.none : C.all}</button>
        </div>
      </>)}
    </Sheet>
  )
}
