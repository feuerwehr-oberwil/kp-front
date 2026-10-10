// French copy · shared words: dialogs, delete/remove, undo/redo, search.
// One slice of the `fr` overlay, assembled in ../fr.ts; the German base is ../de/common.ts.

import type { Copy, Localizable } from '../index'

type Keys =
  | 'baseMap' | 'floor' | 'hoseHint' | 'noHistoryRows' | 'symbolSearchPlaceholder' | 'closeDialog'
  | 'sheetGrip' | 'edit' | 'primarySymbol' | 'done' | 'cancel' | 'exerciseBadge'
  | 'exerciseInitial' | 'keepPlacing' | 'delete' | 'remove' | 'undo' | 'redo' | 'undoNamed'
  | 'redoNamed' | 'undoLost' | 'undoDomains' | 'undoSurfaces' | 'undoTopDropped'
  | 'undoDroppedWhat' | 'play' | 'clear' | 'clearSearch' | 'clearField' | 'noHits' | 'savedLive'

export const commonCopy: Localizable<Pick<Copy, Keys>> = {
  baseMap: 'Carte de base',
  floor: { eg: 'RDC', og: '+{n}', ug: '-{n}' },
  hoseHint: '~{n} tuyaux',
  noHistoryRows: 'Aucun événement enregistré',
  symbolSearchPlaceholder: 'Rechercher un symbole tactique …',
  closeDialog: 'Fermer',
  edit: 'Modifier',
  primarySymbol: { label: 'Symbole' },
  done: 'Terminé',
  cancel: 'Annuler',
  keepPlacing: 'Placer plusieurs',
  delete: 'Supprimer',
  remove: 'Retirer',
  undo: 'Annuler',
  redo: 'Rétablir',
  undoNamed: 'Annuler : {action}',
  redoNamed: 'Rétablir : {action}',
  undoLost: 'Plus annulable',
  undoDomains: {
    reference: 'Référence ajustée',
    blattform: 'Forme de la feuille mesurée',
    karte: 'Modification sur la carte',
    plan: 'Modification sur «{plan}»',
    anwesenheit: 'Présence',
    mittel: 'Matériel',
    checkliste: 'Checklist',
    gebaeude: 'Bâtiment',
    rapport: 'Rapport',
    zeitplan: 'Planning',
    ansicht: 'Vue',
  },
  undoSurfaces: {
    karte: 'Carte', plan: 'Plan', trupps: 'Équipes', anwesenheit: 'Présences', mittel: 'Matériel', checkliste: 'Checklists',
    gebaeude: 'Bâtiment', rapport: 'Rapport', zeitplan: 'Planning', ansicht: 'Carte', pendenz: 'Journal',
  },
  undoTopDropped: 'La dernière étape ne peut plus être annulée – un autre appareil a modifié {what}',
  undoDroppedWhat: {
    karte: 'la carte', plan: 'le plan', trupps: 'l’équipe', anwesenheit: 'les présences', mittel: 'le matériel', checkliste: 'la checklist',
    gebaeude: 'le bâtiment', rapport: 'le rapport', zeitplan: 'le planning', ansicht: 'les vues', pendenz: 'la tâche',
  },
  play: 'Lire',
  clear: 'Effacer',
  clearSearch: 'Effacer la recherche',
  clearField: 'Effacer : {field}',
  noHits: 'Aucun résultat pour «{q}».',
  savedLive: 'Tout est enregistré au fur et à mesure.',
  sheetGrip: 'Ajuster la hauteur du détail',
  exerciseBadge: 'Exercice',
  exerciseInitial: 'E',
}
