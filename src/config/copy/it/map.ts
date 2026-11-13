// Italian copy · the Karte: tools, nav, views, hints.
// One slice of the `it` overlay, assembled in ../it.ts; the German base is ../de/map.ts.

import type { Copy, Localizable } from '../index'

type Keys =
  | 'mapTools' | 'planTools' | 'nav' | 'mapViews' | 'toast' | 'dockHints' | 'map'

export const mapCopy: Localizable<Pick<Copy, Keys>> = {
  mapTools: [
    { id: 'select', icon: 'select', label: 'Selezione', kind: 'tool', alt: { id: 'lasso', icon: 'marquee', label: 'Multiplo' } },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    { id: 'line', icon: 'pen', label: 'Linea', kind: 'tool' },
    { id: 'area', icon: 'area', label: 'Superficie', kind: 'tool' },
    { id: 'circle', icon: 'circle', label: 'Perimetro di sicurezza', kind: 'tool' },
    { id: 'note', icon: 'type', label: 'Nota', kind: 'tool' },
    { id: 'team', icon: 'flag', label: 'Squadra', kind: 'tool' },
    { id: 'measure', icon: 'measure', label: 'Misura', kind: 'tool' },
  ],
  planTools: [
    { id: 'pan', icon: 'select', label: 'Selezione', alt: { id: 'lasso', icon: 'marquee', label: 'Multiplo' } },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    { id: 'line', icon: 'pen', label: 'Linea' },
    { id: 'area', icon: 'area', label: 'Superficie' },
    { id: 'circle', icon: 'circle', label: 'Perimetro di sicurezza' },
    { id: 'text', icon: 'type', label: 'Nota' },
    { id: 'resource', icon: 'flag', label: 'Squadra' },
    { id: 'measure', icon: 'measure', label: 'Misura' },
  ],
  nav: {
    zoomIn: 'Ingrandisci',
    zoomOut: 'Riduci',
    fit: 'Adatta',
    resetNorth: 'Orienta a nord',
    centerIncident: 'Centra sull’intervento',
    coords: 'Rileva coordinate',
    coordsHint: 'Tocca la carta per fissare',
    coordsLocked: 'Fissato – ✕ per terminare',
    coordsExit: 'Chiudi coordinate',
    autoMode: 'Automatico',
    deviceMode: 'Dispositivo',
    dayMode: 'Giorno',
    nightMode: 'Notte',
  },
  toast: {
    audioSaved: 'Nota vocale salvata ({secs} s)',
    micDenied: 'Nessun accesso al microfono – annotato come segnaposto',
    micFailed: 'Registrazione non avviata – riprovare',
    merged: 'Modifiche unite',
  },
  dockHints: {
    lasso: 'Trascina un riquadro attorno a più oggetti.',
    line: 'Trascina o tocca i punti.',
    lineFreehand: 'Trascinando si disegna la linea. Punti singoli: «Punti».',
    lineNodes: 'Tocca i punti, ✓ – fatto.',
    area: 'Trascina il contorno a mano libera – oppure tocca i vertici, ✓ – fatto.',
    circle: 'Trascina dal centro verso il bordo.',
    note: 'Tocca dove va la nota – poi scrivi.',
    shape: 'Tocca per posizionare la forma. Per più forme: «Posiziona più».',
    rotationStart: 'Toccare il primo punto – dove si preleva l’acqua. Tenere premuto su un simbolo per agganciarlo.',
    rotationEnd: 'Toccare il secondo punto – l’incendio. Lo stesso punto di nuovo: lunghezza standard.',
    measure: 'Tocca i punti. Tieni premuto un punto per rimuoverlo.',

    team: 'Tocca e scegli la squadra. Trascinando la sposti.',
  },
  map: {
    incidentHere: 'Luogo d’intervento',
    youHere: 'La mia posizione',
    glLost: 'Visualizzazione della mappa interrotta',
    glLostHint: 'Il dispositivo ha rilasciato il contesto grafico della mappa. Le tue voci sono salvate.',
    glLostAction: 'Ricostruisci mappa',
    noTilesTitle: 'Nessuna mappa di base salvata per questa zona',
    noTilesSub: 'Offline – oggetti e linee sono mostrati senza mappa',
    noTilesAction: 'Questo dispositivo',
    noTilesDismiss: 'Nascondi',
  },
  mapViews: {
    title: 'Viste',
    north: 'Verso nord',
    fit: 'Adatta',
    locate: 'La mia posizione',
    save: 'Salva la vista',
    hint: 'Una vista salva la carta com\'è – posizione, zoom e rotazione. Tocca una vista salvata per saltarci (p. es. tra una panoramica a nord e la carta girata come sei posizionato). Pressione lunga sulla bussola: adatta subito.',
    rename: 'Rinomina',
    delete: 'Elimina',
    saved: 'Vista salvata',
    deleted: 'Vista «{name}» eliminata',
  },
}
