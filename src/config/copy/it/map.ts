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
    { id: 'circle', icon: 'circle', label: 'Perimetro di sicurezza', kind: 'tool', short: 'Perimetro' },
    { id: 'note', icon: 'type', label: 'Nota', kind: 'tool' },
    { id: 'team', icon: 'flag', label: 'Squadra', kind: 'tool' },
    { id: 'measure', icon: 'measure', label: 'Misura', kind: 'tool' },
  ],
  planTools: [
    { id: 'pan', icon: 'select', label: 'Selezione', alt: { id: 'lasso', icon: 'marquee', label: 'Multiplo' } },
    { id: 'symbol-slot', slot: true, icon: '', label: '' },
    { id: 'line', icon: 'pen', label: 'Linea' },
    { id: 'area', icon: 'area', label: 'Superficie' },
    { id: 'circle', icon: 'circle', label: 'Perimetro di sicurezza', short: 'Perimetro' },
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
    micDenied: 'Nessun accesso al microfono – annotato come segnaposto',
    micFailed: 'Registrazione non avviata – riprovare',
    micBlocked: 'Microfono bloccato – consentirlo tramite {path}',
    locateBlocked: 'Posizione bloccata – consentirla tramite {path}',
    locateNone: 'Nessuna posizione trovata – riprovare',
    permissionPath: {
      location: {
        iosApp: 'Impostazioni iPhone › Privacy e sicurezza › Localizzazione › Siti web Safari',
        iosSafari: 'Impostazioni iPhone › App › Safari › Posizione',
        android: 'Chrome ⋮ › Impostazioni › Impostazioni sito › Posizione',
        desktop: 'l’icona a sinistra dell’indirizzo › Posizione',
      },
      microphone: {
        iosApp: 'Impostazioni iPhone › App › Safari › Microfono',
        iosSafari: 'Impostazioni iPhone › App › Safari › Microfono',
        android: 'Chrome ⋮ › Impostazioni › Impostazioni sito › Microfono',
        desktop: 'l’icona a sinistra dell’indirizzo › Microfono',
      },
      notifications: {
        iosApp: 'Impostazioni iPhone › Notifiche › {app}',
        iosSafari: 'Impostazioni iPhone › Notifiche › {app}',
        android: 'Impostazioni Android › App › {app} › Notifiche',
        desktop: 'l’icona a sinistra dell’indirizzo › Notifiche',
      },
    },
  },
  dockHints: {
    lasso: 'Trascina un riquadro attorno a più oggetti – poi spostali o rimuovili insieme.',
    lineFreehand: 'Trascina con il dito – la linea segue. Tratti diritti: «Punti».',
    lineNodes: 'Tocca punto per punto, poi ✓ Fatto.',
    circle: 'Trascina dal centro verso il bordo.',
    note: 'Tocca dove va la nota – poi scrivi.',
    shape: 'Tocca per posizionare la forma. Per più forme: «Posiziona più».',
    rotationStart: 'Toccare il primo punto – dove si preleva l’acqua. Tenere premuto su un simbolo lo posa esattamente lì.',
    rotationEnd: 'Toccare il secondo punto – l’incendio. Di nuovo il primo punto: lunghezza abituale.',
    measure: 'Tocca i punti. Tieni premuto un punto per rimuoverlo.',

    team: 'Tocca, poi scegli la squadra – trascina una squadra posata per spostarla.',
    areaFreehand: 'Trascina tutt’intorno – la superficie si chiude al rilascio.',
    areaNodes: 'Tocca vertice per vertice, poi ✓ Fatto.',
  },
  map: {
    incidentHere: 'Luogo d’intervento',
    youHere: 'La mia posizione',
    glLost: 'Visualizzazione della mappa interrotta',
    glLostHint: 'Il dispositivo ha rilasciato il contesto grafico della mappa. Le tue voci sono salvate.',
    glLostAction: 'Ricostruisci mappa',
    noTilesTitle: 'Nessuna mappa di base salvata per questa zona',
    noTilesSub: 'Offline – oggetti e linee sono mostrati senza mappa',
    noTilesAction: 'Disponibile offline',
    noTilesDismiss: 'Nascondi',
  },
  mapViews: {
    title: 'Viste',
    north: 'Verso nord',
    fit: 'Adatta',
    locate: 'La mia posizione',
    save: 'Salva la vista',
    hint: 'Una vista ricorda inquadratura, zoom e rotazione – toccarla ci riporta.',
    rename: 'Rinomina',
    delete: 'Elimina',
    deleted: 'Vista «{name}» eliminata',
  },
}
