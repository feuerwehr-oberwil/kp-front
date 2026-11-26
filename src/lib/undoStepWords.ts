import { appConfig } from '../config/appConfig'
import { fillTemplate, formatSymbolName } from './format'
import { drawingLogName } from './drawingEdit'
import type { TacticalObject } from './tacticalObjects'

/**
 * The words ↶ names a Karte store step by, when its writer set none (owner pick UX journeys M·11,
 * 25.11.2026: «Rückgängig: Änderung auf der Karte» named nothing, and a walker could not tell
 * what had come back). Read off the step itself – the store's state before and after it – so no
 * writer has to thread a word through: a step that changed exactly ONE object says which one and
 * what happened to it («TLF verschoben»); anything wider keeps the domain word, which is honest.
 *
 * `id` is that object, for the ring the ↶ puts on it (IncidentWorkspace · onCheckpoint) – a
 * marker's ring, or a `drawing`'s outline.
 * IncidentWorkspace calls this from the store's `onCheckpoint`; a writer's own `stepLabelRef`
 * words («TLF entfernt, 2 Leitungen gelöst») still win over these.
 */
export function storeStepWords(before: readonly TacticalObject[], after: readonly TacticalObject[]): { id: string; text: string; drawing: boolean } | null {
  const was = new Map(before.map((o) => [o.id, o]))
  const now = new Map(after.map((o) => [o.id, o]))
  let subject: { id: string; was?: TacticalObject; now?: TacticalObject } | null = null
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(id)
    const b = now.get(id)
    if (a && b && sameBody(a, b)) continue
    if (subject) return null // a second object changed: not ONE object's step
    subject = { id, was: a, now: b }
  }
  if (!subject) return null
  const W = appConfig.copy.undoStep
  const shown = subject.now ?? subject.was
  const name = shown && objectName(shown)
  if (!name) return null
  const text = !subject.was ? W.placed : !subject.now ? W.removed : moved(subject.was, subject.now) ? W.moved : W.changed
  return { id: subject.id, text: fillTemplate(text, { name }), drawing: !!shown.drawing }
}

/** ⚠️ By the bodies, not the wrapper: the store may rebuild an object around bodies it kept. */
function sameBody(a: TacticalObject, b: TacticalObject): boolean {
  return a === b || (a.entity === b.entity && a.drawing === b.drawing && a.sheet?.anno === b.sheet?.anno && a.sheet?.planId === b.sheet?.planId)
}

function moved(a: TacticalObject, b: TacticalObject): boolean {
  if (a.sheet && b.sheet) return a.sheet.anno.x !== b.sheet.anno.x || a.sheet.anno.y !== b.sheet.anno.y
  if (a.entity && b.entity) return a.entity.coord[0] !== b.entity.coord[0] || a.entity.coord[1] !== b.entity.coord[1]
  if (a.drawing && b.drawing) return JSON.stringify(a.drawing.coords) !== JSON.stringify(b.drawing.coords)
  return false
}

/** The name the Verlauf would give it; a Notiz is «Notiz» (its text would be the sentence). */
function objectName(o: TacticalObject): string | null {
  if (o.drawing) return drawingLogName(o.drawing)
  const body = o.entity ?? o.sheet?.anno
  if (!body) return null
  if (body.kind === 'note' || body.kind === 'text') return appConfig.copy.whiteboard.text
  return (body.label ?? '').trim() || (body.symbol ? formatSymbolName(body.symbol) : '') || null
}
