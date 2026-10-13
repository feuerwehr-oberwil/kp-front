// Italian copy · shared words: dialogs, delete/remove, undo/redo, search.
// One slice of the `it` overlay, assembled in ../it.ts; the German base is ../de/common.ts.

import type { Copy, Localizable } from '../index'

type Keys =
  | 'baseMap' | 'floor' | 'hoseHint' | 'noHistoryRows' | 'symbolSearchPlaceholder' | 'closeDialog'
  | 'sheetGrip' | 'edit' | 'primarySymbol' | 'done' | 'cancel' | 'exerciseBadge'
  | 'exerciseInitial' | 'keepPlacing' | 'delete' | 'remove' | 'undo' | 'redo' | 'undoNamed'
  | 'redoNamed' | 'undoLost' | 'undoDomains' | 'undoSurfaces' | 'undoTopDropped'
  | 'undoDroppedWhat' | 'play' | 'clear' | 'clearSearch' | 'clearField' | 'noHits' | 'savedLive'

export const commonCopy: Localizable<Pick<Copy, Keys>> = {
  baseMap: 'Mappa di base',
  floor: { eg: 'PT', og: '{n}° PS', ug: '{n}° PI' },
  hoseHint: '~{n} tubi',
  noHistoryRows: 'Nessun evento registrato',
  symbolSearchPlaceholder: 'Cerca simbolo tattico …',
  closeDialog: 'Chiudi',
  edit: 'Modifica',
  primarySymbol: { label: 'Simbolo' },
  done: 'Fatto',
  cancel: 'Annulla',
  keepPlacing: 'Posiziona più',
  delete: 'Elimina',
  remove: 'Rimuovi',
  undo: 'Annulla',
  redo: 'Ripristina',
  undoNamed: 'Annulla: {action}',
  redoNamed: 'Ripristina: {action}',
  undoLost: 'Non più annullabile',
  undoDomains: {
    reference: 'Riferimento adattato',
    blattform: 'Forma del foglio misurata',
    karte: 'Modifica sulla mappa',
    plan: 'Modifica su «{plan}»',
    anwesenheit: 'Presenza',
    mittel: 'Materiale',
    checkliste: 'Checklist',
    gebaeude: 'Edificio',
    rapport: 'Rapporto',
    zeitplan: 'Pianificazione',
    ansicht: 'Vista',
  },
  undoSurfaces: {
    karte: 'Mappa', plan: 'Piano', trupps: 'Squadre', anwesenheit: 'Presenze', mittel: 'Materiale', checkliste: 'Checklist',
    gebaeude: 'Edificio', rapport: 'Rapporto', zeitplan: 'Pianificazione', ansicht: 'Mappa', pendenz: 'Diario',
  },
  undoTopDropped: 'L’ultimo passo non si può più annullare – un altro dispositivo ha modificato {what}',
  undoDroppedWhat: {
    karte: 'la mappa', plan: 'il piano', trupps: 'la squadra', anwesenheit: 'le presenze', mittel: 'il materiale', checkliste: 'la checklist',
    gebaeude: 'l’edificio', rapport: 'il rapporto', zeitplan: 'la pianificazione', ansicht: 'le viste', pendenz: 'il compito',
  },
  play: 'Riproduci',
  clear: 'Svuota',
  clearSearch: 'Svuota la ricerca',
  clearField: 'Svuota: {field}',
  noHits: 'Nessun risultato per «{q}».',
  savedLive: 'Tutto viene salvato man mano.',
  sheetGrip: 'Regola l\'altezza del dettaglio',
  exerciseBadge: 'Esercitazione',
  exerciseInitial: 'E',
}
