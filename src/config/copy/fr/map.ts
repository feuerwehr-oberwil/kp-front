// French copy · the Karte: tools, nav, views, hints.
// One slice of the `fr` overlay, assembled in ../fr.ts; the German base is ../de/map.ts.

import type { Copy, Localizable } from '../index'

type Keys =
  | 'mapTools' | 'planTools' | 'nav' | 'mapViews' | 'toast' | 'dockHints' | 'map'

export const mapCopy: Localizable<Pick<Copy, Keys>> = {
  mapTools: [
    { id: 'select', icon: 'select', label: 'Sélection', kind: 'tool', alt: { id: 'lasso', icon: 'marquee', label: 'Multiple' } },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    { id: 'line', icon: 'pen', label: 'Ligne', kind: 'tool' },
    { id: 'area', icon: 'area', label: 'Surface', kind: 'tool' },
    { id: 'circle', icon: 'circle', label: 'Périmètre de sécurité', kind: 'tool' },
    { id: 'note', icon: 'type', label: 'Note', kind: 'tool' },
    { id: 'team', icon: 'flag', label: 'Équipe', kind: 'tool' },
    { id: 'measure', icon: 'measure', label: 'Mesurer', kind: 'tool' },
  ],
  planTools: [
    { id: 'pan', icon: 'select', label: 'Sélection', alt: { id: 'lasso', icon: 'marquee', label: 'Multiple' } },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    { id: 'line', icon: 'pen', label: 'Ligne' },
    { id: 'area', icon: 'area', label: 'Surface' },
    { id: 'circle', icon: 'circle', label: 'Périmètre de sécurité' },
    { id: 'text', icon: 'type', label: 'Note' },
    { id: 'resource', icon: 'flag', label: 'Équipe' },
    { id: 'measure', icon: 'measure', label: 'Mesurer' },
  ],
  nav: {
    zoomIn: 'Agrandir',
    zoomOut: 'Réduire',
    fit: 'Ajuster',
    resetNorth: 'Orienter au nord',
    centerIncident: 'Centrer sur l’intervention',
    coords: 'Relever les coordonnées',
    coordsHint: 'Toucher la carte pour fixer',
    coordsLocked: 'Fixé – ✕ pour terminer',
    coordsExit: 'Quitter les coordonnées',
    autoMode: 'Automatique',
    deviceMode: 'Appareil',
    dayMode: 'Jour',
    nightMode: 'Nuit',
  },
  toast: {
    audioSaved: 'Note vocale enregistrée ({secs} s)',
    micDenied: 'Pas d’accès au micro – noté comme marqueur',
    micFailed: 'Enregistrement non démarré – réessayer',
    merged: 'Modifications fusionnées',
  },
  dockHints: {
    lasso: 'Tirez un cadre autour de plusieurs objets.',
    line: 'Glissez ou touchez des points.',
    lineFreehand: 'Glisser trace la ligne. Points isolés : « Points ».',
    lineNodes: 'Touchez des points, ✓ – terminé.',
    area: 'Glissez le contour à main levée – ou touchez des sommets, ✓ – terminé.',
    circle: 'Glissez du centre vers l’extérieur.',
    note: 'Touchez là où la note doit aller – puis écrivez.',
    shape: 'Touchez pour placer la forme. Pour plusieurs : « Placer plusieurs ».',
    rotationStart: 'Toucher le premier point – là où l’eau est puisée. Maintenir sur un symbole pour s’y accrocher.',
    rotationEnd: 'Toucher le second point – le sinistre. Le même point encore : longueur standard.',
    measure: 'Touchez des points. Maintenir un point le retire.',

    team: 'Touche et choisis le binôme. Glisser le déplace.',
  },
  map: {
    incidentHere: 'Lieu d’intervention',
    youHere: 'Ma position',
    glLost: 'Affichage de la carte interrompu',
    glLostHint: 'L’appareil a libéré le contexte graphique de la carte. Vos saisies sont enregistrées.',
    glLostAction: 'Reconstruire la carte',
    noTilesTitle: 'Aucun fond de carte enregistré pour cette zone',
    noTilesSub: 'Hors ligne – objets et lignes affichés sans carte',
    noTilesAction: 'Préparation hors ligne',
    noTilesDismiss: 'Masquer',
  },
  mapViews: {
    title: 'Vues',
    north: 'Vers le nord',
    fit: 'Ajuster',
    locate: 'Ma position',
    save: 'Enregistrer la vue',
    hint: 'Une vue enregistre la carte telle qu\'elle est – position, zoom et rotation. Touche une vue enregistrée pour y sauter (p. ex. entre une vue générale au nord et la carte tournée comme tu es placé). Appui long sur la boussole : ajuster directement.',
    rename: 'Renommer',
    delete: 'Supprimer',
    saved: 'Vue enregistrée',
    deleted: 'Vue «{name}» supprimée',
  },
}
