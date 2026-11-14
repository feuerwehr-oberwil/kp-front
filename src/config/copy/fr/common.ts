// French copy · shared words: dialogs, delete/remove, undo/redo, search.
// One slice of the `fr` overlay, assembled in ../fr.ts; the German base is ../de/common.ts.

import type { Copy, Localizable } from '../index'

type Keys =
  | 'baseMap' | 'floor' | 'hoseHint' | 'symbolSearchPlaceholder' | 'closeDialog'
  | 'sheetGrip' | 'edit' | 'primarySymbol' | 'done' | 'cancel' | 'exerciseBadge'
  | 'exerciseInitial' | 'keepPlacing' | 'delete' | 'remove' | 'undo' | 'redo' | 'undoNamed'
  | 'redoNamed' | 'undoLost' | 'removedToast' | 'undoDomains' | 'undoSurfaces' | 'undoTopDropped'
  | 'undoDroppedWhat' | 'play' | 'clear' | 'clearSearch' | 'noHits'

export const commonCopy: Localizable<Pick<Copy, Keys>> = {
  baseMap: 'Carte de base',
  floor: { eg: 'RDC', og: '+{n}', ug: '-{n}' },
  hoseHint: '~{n} tuyaux',
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
  removedToast: { note: 'Note retirée', freed: '{what}, {n} lignes détachées', freedOne: '{what}, 1 ligne détachée', joinedTitle: '{what} a {n} lignes', joinedTitleOne: '{what} a 1 ligne', joinedOnly: 'Symbole seul', joinedOnlyGroup: 'Sélection seule', joinedWith: 'Avec les lignes', withLines: '{what} et {n} lignes retirés', withLine: '{what} et 1 ligne retirés', group: 'Sélection', groupN: '{n} objets', noteWhat: 'Note' },
  undoDomains: {
    reference: 'Lien ajusté',
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
  noHits: 'Aucun résultat pour «{q}».',
  sheetGrip: 'Ajuster la hauteur du détail',
  exerciseBadge: 'Exercice',
  exerciseInitial: 'E',
}
