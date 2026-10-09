// English copy · shared words: dialogs, delete/remove, undo/redo, search.
// One slice of the `en` overlay, assembled in ../en.ts; the German base is ../de/common.ts.

import type { Copy, Localizable } from '../index'

type Keys =
  | 'baseMap' | 'floor' | 'hoseHint' | 'noHistoryRows' | 'symbolSearchPlaceholder' | 'closeDialog'
  | 'sheetGrip' | 'edit' | 'primarySymbol' | 'done' | 'cancel' | 'exerciseBadge'
  | 'exerciseInitial' | 'keepPlacing' | 'delete' | 'remove' | 'undo' | 'redo' | 'undoNamed'
  | 'redoNamed' | 'undoLost' | 'undoDomains' | 'undoSurfaces' | 'undoTopDropped'
  | 'undoDroppedWhat' | 'play' | 'clear' | 'clearSearch' | 'clearField' | 'noHits' | 'savedLive'

export const commonCopy: Localizable<Pick<Copy, Keys>> = {
  baseMap: 'Base map',
  floor: { eg: 'GF', og: '{n}F', ug: 'B{n}' },
  hoseHint: '~{n} hose lengths',
  noHistoryRows: 'No events recorded yet',
  symbolSearchPlaceholder: 'Search tactical symbol …',
  closeDialog: 'Close',
  sheetGrip: 'Adjust detail height',
  edit: 'Edit',
  primarySymbol: { label: 'Symbol' },
  done: 'Done',
  cancel: 'Cancel',
  exerciseBadge: 'Exercise',
  exerciseInitial: 'E',
  keepPlacing: 'Place several',
  delete: 'Delete',
  remove: 'Remove',
  undo: 'Undo',
  redo: 'Redo',
  undoNamed: 'Undo: {action}',
  redoNamed: 'Redo: {action}',
  undoLost: 'No longer undoable',
  undoDomains: {
    reference: 'Reference adjusted',
    blattform: 'Sheet shape measured',
    karte: 'Change on the map',
    plan: 'Change on «{plan}»',
    anwesenheit: 'Attendance',
    mittel: 'Material',
    checkliste: 'Checklist',
    gebaeude: 'Building',
    rapport: 'Report',
    zeitplan: 'Schedule',
    ansicht: 'View',
  },
  undoSurfaces: {
    karte: 'Map', plan: 'Plan', trupps: 'Crews', anwesenheit: 'Attendance', mittel: 'Resources', checkliste: 'Checklists',
    gebaeude: 'Building', rapport: 'Report', zeitplan: 'Schedule', ansicht: 'Map', pendenz: 'Log',
  },
  undoTopDropped: 'Last step can no longer be undone – another device changed {what}',
  undoDroppedWhat: {
    karte: 'the map', plan: 'the plan', trupps: 'the crew', anwesenheit: 'the attendance', mittel: 'the resources', checkliste: 'the checklist',
    gebaeude: 'the building', rapport: 'the report', zeitplan: 'the schedule', ansicht: 'the views', pendenz: 'the task',
  },
  play: 'Play',
  clear: 'Clear',
  clearSearch: 'Clear search',
  clearField: 'Clear {field}',
  noHits: 'No matches for «{q}».',
  savedLive: 'Everything is saved as you go.',
}
