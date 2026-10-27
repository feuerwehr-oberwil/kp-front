import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Sheet } from '../lib/overlays'
import { Button } from './Button'
import { Chip } from './Chip'

/**
 * «Kopieren nach …» from a Gebäude storey's label menu (Whiteboard): one chip per other storey
 * (several at once), and «Kopieren». What it copies is said in one line above the chips – the
 * storey's Grundriss (lib/grundriss · grundrissOf), `count` objects – so nobody has to guess
 * whether the Leitungen come along. The caller copies and commits; the sheet only asks.
 */
export function StoreyCopySheet({ name, count, storeys, onCopy, onClose }: {
  /** the storey copied FROM, as its label reads («EG») */
  name: string
  /** how many objects its Grundriss holds */
  count: number
  /** the storeys it can go to, top to bottom */
  storeys: { floor: number; name: string }[]
  onCopy: (targets: number[]) => void
  onClose: () => void
}) {
  const C = appConfig.copy.whiteboard.storeyCopy
  const [picked, setPicked] = useState<number[]>([])
  const toggle = (f: number) => setPicked((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]))
  return (
    <Sheet open onClose={onClose} fit title={fillTemplate(C.title, { name })}
      footer={<>
        <Button onClick={onClose}>{appConfig.copy.cancel}</Button>
        <Button variant="primary" disabled={!picked.length || !count} onClick={() => { onCopy(picked); onClose() }}>{C.confirm}</Button>
      </>}
    >
      <p className="wb-copy-what">{count ? fillTemplate(count === 1 ? C.whatOne : C.what, { n: count }) : fillTemplate(C.nothing, { name })}</p>
      {count > 0 && (
        <div className="wb-copy-chips" role="group" aria-label={C.targets}>
          {storeys.map((s) => <Chip key={s.floor} selected={picked.includes(s.floor)} onClick={() => toggle(s.floor)}>{s.name}</Chip>)}
        </div>
      )}
    </Sheet>
  )
}
