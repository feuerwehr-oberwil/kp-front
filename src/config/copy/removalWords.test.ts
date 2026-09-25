import { describe, expect, it } from 'vitest'
import { de } from './de'

/* ONE verb per act (decided 25.09.2026, audited again after the second staging walk-through):
 * whatever takes something OFF THE PICTURE — a symbol, a drawing, a group, a Trupp, a marker's
 * Spur, a Gebäude storey — says «entfernt» / «Entfernen». «gelöscht» is left to an extinguished
 * Feuer (objectDone). Records that are not on the picture (an Ansicht, a Schicht, a Verlauf
 * Eintrag, a Mittel line) may still be «gelöscht». This pins the picture's templates. */
const pictureRows = {
  'log.objectDeleted': de.log.objectDeleted,
  'log.drawingDeleted': de.log.drawingDeleted,
  'log.selectionDeleted': de.log.selectionDeleted,
  'whiteboard.groupDeleted': de.whiteboard.groupDeleted,
  'whiteboard.groupDeletedN': de.whiteboard.groupDeletedN,
  'whiteboard.trailCleared': de.whiteboard.trailCleared,
  'whiteboard.floorRemoved': de.whiteboard.floorRemoved,
  'whiteboard.floorRemovedLog': de.whiteboard.floorRemovedLog,
  'whiteboard.floorRemovedLogMarks': de.whiteboard.floorRemovedLogMarks,
  'atemschutz.logRemoved': de.atemschutz.logRemoved,
}
const pictureActions = {
  remove: de.remove,
  'whiteboard.removeMarker': de.whiteboard.removeMarker,
  'whiteboard.removeMarkerTrail': de.whiteboard.removeMarkerTrail,
  'whiteboard.clearTrail': de.whiteboard.clearTrail,
  'whiteboard.clearTrailConfirm': de.whiteboard.clearTrailConfirm,
  'whiteboard.ghostTrailAsk': de.whiteboard.ghostTrailAsk,
  'whiteboard.removeFloor': de.whiteboard.removeFloor,
  'whiteboard.removeFloorConfirm': de.whiteboard.removeFloorConfirm,
  'whiteboard.removeFloorConfirmOne': de.whiteboard.removeFloorConfirmOne,
  'whiteboard.groupDeleteTitle': de.whiteboard.groupDeleteTitle,
  'drawingEditor.removeConnectedTitle': de.drawingEditor.removeConnectedTitle,
  'notes.deleteTitle': de.notes.deleteTitle,
  'notes.deleteMsg': de.notes.deleteMsg,
}

describe('removing from the picture is «entfernt», never «gelöscht»', () => {
  it.each(Object.entries(pictureRows))('%s says «entfernt»', (_key, text) => {
    expect(text).toMatch(/entfernt/)
    expect(text).not.toMatch(/lösch/i)
  })
  it.each(Object.entries(pictureActions))('%s says «entfernen»', (_key, text) => {
    expect(text).toMatch(/[Ee]ntfern/)
    expect(text).not.toMatch(/lösch/i)
  })
  it('«gelöscht» still means the extinguished Feuer', () => {
    expect(de.objectDone.word.fire.inline).toBe('gelöscht')
  })
})
