// English copy · the Karte: tools, nav, views, hints.
// One slice of the `en` overlay, assembled in ../en.ts; the German base is ../de/map.ts.

import type { Copy, Localizable } from '../index'

type Keys =
  | 'mapTools' | 'planTools' | 'nav' | 'mapViews' | 'toast' | 'dockHints' | 'map'

export const mapCopy: Localizable<Pick<Copy, Keys>> = {
  mapTools: [
    { id: 'select', icon: 'select', label: 'Select', kind: 'tool', alt: { id: 'lasso', icon: 'marquee', label: 'Multi' } },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    { id: 'line', icon: 'pen', label: 'Line', kind: 'tool' },
    { id: 'area', icon: 'area', label: 'Area', kind: 'tool' },
    { id: 'circle', icon: 'circle', label: 'Cordon', kind: 'tool' },
    { id: 'note', icon: 'type', label: 'Note', kind: 'tool' },
    { id: 'team', icon: 'flag', label: 'Team', kind: 'tool' },
    { id: 'measure', icon: 'measure', label: 'Measure', kind: 'tool' },
  ],
  planTools: [
    { id: 'pan', icon: 'select', label: 'Select', alt: { id: 'lasso', icon: 'marquee', label: 'Multi' } },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    { id: 'line', icon: 'pen', label: 'Line' },
    { id: 'area', icon: 'area', label: 'Area' },
    { id: 'circle', icon: 'circle', label: 'Cordon' },
    { id: 'text', icon: 'type', label: 'Note' },
    { id: 'resource', icon: 'flag', label: 'Team' },
    { id: 'measure', icon: 'measure', label: 'Measure' },
  ],
  nav: {
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fit: 'Fit',
    resetNorth: 'Align north',
    centerIncident: 'Center on incident',
    coords: 'Pick coordinates',
    coordsHint: 'Tap the map to capture',
    coordsLocked: 'Captured – ✕ to finish',
    coordsExit: 'Exit coordinates',
    autoMode: 'Automatic',
    deviceMode: 'Device',
    dayMode: 'Day',
    nightMode: 'Night',
  },
  toast: {
    audioSaved: 'Voice note saved ({secs} s)',
    micDenied: 'No microphone access – noted as placeholder',
    micFailed: 'Recording not started – try again',
    merged: 'Changes merged',
  },
  dockHints: {
    lasso: 'Drag a frame around several objects.',
    line: 'Drag or tap points.',
    lineFreehand: 'Drag to draw the line. Single points: «Points».',
    lineNodes: 'Tap points, ✓ – done.',
    area: 'Drag the outline freely – or tap corners, ✓ – done.',
    circle: 'Drag from the centre outward.',
    note: 'Tap where the note should go – then write.',
    team: 'Tap and pick the crew. Drag to move it.',
    shape: 'Tap to place the shape. For several: «Place several».',
    rotationStart: 'Tap the first point – where the water is drawn from. Hold on a symbol to snap to it.',
    rotationEnd: 'Tap the second point – the fire. The same point again: default length.',
    measure: 'Tap points. Hold a point to remove it.',
  },
  map: {
    incidentHere: 'Incident',
    youHere: 'My location',
    glLost: 'Map display interrupted',
    glLostHint: 'The device released the map’s graphics context. Your entries are saved.',
    glLostAction: 'Rebuild map',
    noTilesTitle: 'No base map saved for this area',
    noTilesSub: 'Offline – objects and lines are shown without a map',
    noTilesAction: 'Offline readiness',
    noTilesDismiss: 'Hide',
  },
  mapViews: {
    title: 'Views',
    north: 'Face north',
    fit: 'Fit',
    locate: 'My location',
    save: 'Save view',
    hint: 'A view stores the map exactly as it is — position, zoom and rotation. Tap a saved view to jump there (e.g. between a north overview and the map turned the way you are standing). Long-press the compass to fit straight away.',
    rename: 'Rename',
    delete: 'Delete',
    saved: 'View saved',
    deleted: 'View «{name}» deleted',
  },
}
