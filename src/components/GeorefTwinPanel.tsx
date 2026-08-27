/** The details of a «Zwilling» — the SAME panel every symbol opens, with every edit taken out.
 *
 *  A twin is a projection of something that lives on the other surface (lib/georefTwins). Until
 *  26.08. tapping one jumped straight there, which answered a question nobody had asked: the
 *  reason to tap a mirrored TLF on the plan is «who is on it / what does it say», not «take me
 *  away from the sheet I am working on». So the tap now opens the object's own details, mirrored
 *  and read-only. Its actions either show that source or move ownership here; neither edits a
 *  second copy.
 *
 *  ⚠️ NOTHING here is editable, and that is not a simplification — it is the design.
 *  A twin has no identity of its own: it is `entities` / `board` seen through a fit. An edit
 *  made here would have to be written back to the source document from a surface that does not
 *  own it, and the moment two surfaces can write the same object the app owes an answer for
 *  every conflict — two devices, one offline, both editing the mirrored copy of a symbol that a
 *  third device has meanwhile deleted. The workspace merge is per-object last-write-wins
 *  (memory · sync limitations); dual-edit through a projection is exactly the case it cannot
 *  resolve honestly. One object, one place to change it.
 */
import { ContextPanel, type SymbolView } from './ContextPanel'
import { symbolControls, symbolPresetFieldKeys, symbolTitleOptions } from '../lib/symbols'

/** A twin is never written to, never deleted and never renamed. The panel's edit contract still
 *  wants the callbacks; `readOnly` makes every one of them unreachable, so they are the honest
 *  no-op rather than a code path nobody tested. */
const NEVER = () => {}

/**
 * One twin's details, mirrored from its source.
 *
 * The caller supplies the source object as it is (an `Entity` from the Lage, or a `BoardAnno`
 * from a plan with its `storey` already remapped onto `floor` — see Whiteboard · ContextPanel),
 * plus the glyph the mark itself drew, so the header shows the same picture that was tapped.
 */
export function GeorefTwinPanel({ entity, svg, subtitle, onClose, onOriginal, originalLabel, onTransferHere }: {
  entity: SymbolView
  svg?: string
  /** «Gespiegelt von der Karte – nur zum Lesen»: why this panel has no controls */
  subtitle: string
  onClose: () => void
  /** «Zum Original» — the jump the twin's tap used to do */
  onOriginal: () => void
  originalLabel?: string
  onTransferHere?: () => void
}) {
  const category = entity.subtitle
  return (
    <ContextPanel
      key={entity.id}
      entity={{ ...entity, subtitle }}
      svg={svg}
      readOnly
      onClose={onClose}
      onOriginal={onOriginal}
      originalLabel={originalLabel}
      onTransferHere={onTransferHere}
      onTitle={NEVER}
      onFields={NEVER}
      onNotes={NEVER}
      onFloor={NEVER}
      onFloorFrom={NEVER}
      onFloorTo={NEVER}
      onSpread={NEVER}
      onCount={NEVER}
      onRotate={NEVER}
      onRotate2={NEVER}
      onCaption={NEVER}
      onAirflow={NEVER}
      controls={symbolControls(entity.symbol, category)}
      titleOptions={symbolTitleOptions(entity.symbol, category)}
      protectedKeys={new Set(symbolPresetFieldKeys(entity.symbol, category))}
      onDelete={NEVER}
    />
  )
}
