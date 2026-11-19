// Italian copy · «Üben», the drills on the private practice Einsatz.
// One slice of the `it` overlay, assembled in ../it.ts; the German base is ../de/ueben.ts.

import type { Copy, Localizable } from '../index'

export const uebenCopy: Localizable<Pick<Copy, 'ueben'>> = {
  ueben: {
    menu: 'Esercitarsi',
    sheetLead: 'Su un campo d’esercizio solo su questo dispositivo. Niente va all’intervento.',
    next: 'Prossimo',
    nextGo: 'Inizia',
    allDrills: 'Tutti gli esercizi',
    doneCount: '{n} di {total} riusciti',
    soon: 'presto',
    doneMark: 'Riuscito',
    kicker: '{module} · {i} / {n}',
    show: 'Mostra',
    showMore: 'Mostra di più',
    solve: 'Soluzione',
    hideHint: 'Nascondi',
    more: 'Altro',
    restart: 'Ricomincia',
    leave: 'Esci dall’esercizio',
    doneTitle: 'Riuscito',
    doneSolved: 'Fatto con la soluzione – per esercitarsi, rifallo semplicemente.',
    doneNext: 'Esercizio successivo',
    doneAgain: 'Ancora',
    doneList: 'Tutti gli esercizi',
    idleTitle: 'Campo d’esercizio',
    idleText: 'Solo su questo dispositivo – nessun altro dispositivo e nessun elenco interventi lo vede.',
    idlePick: 'Scegli un esercizio',
    restartTitle: 'Ricominciare il campo d’esercizio?',
    restartMessage: 'Carta, diario, squadre e rapporto del campo d’esercizio vengono eliminati. Gli interventi veri non sono toccati.',
    restartConfirm: 'Ricomincia',
    localOnly: 'Solo su questo dispositivo',
    siteMissing: '{name} manca sulla carta – «Ricomincia» ripristina il campo d’esercizio',
    site: {
      hydrant: 'H1',
      weiher: 'W',
      eingang: 'Entrata',
    },
    modules: {
      karteWasser: 'Carta & acqua',
      atemschutzGebaeude: 'Protezione respiratoria & edificio',
      protokollAbschluss: 'Diario & chiusura',
    },
    drills: {
      fahrzeugLeitung: {
        title: 'Veicolo con condotta',
        task: 'L’autobotte sta all’idrante H1. Mettila lì e stendi una condotta fino all’entrata.',
        goals: {
          tlf: 'Autobotte all’idrante H1',
          leitung: 'Condotta dall’autobotte all’entrata',
        },
        tlfFar: 'L’autobotte è a {m} m da H1',
        vehicleFar: 'Il veicolo è a {m} m da H1 – e non si chiama ancora «TLF»',
        nameIt: 'Posato. Scegli ancora la designazione «TLF»',
        tlfFirst: 'Prima l’autobotte',
        startFar: 'La condotta inizia a {m} m dall’autobotte',
        endFar: 'La condotta finisce a {m} m dall’entrata',
        hint: {
          karte: 'Alla carta',
          addPhone: 'Aggiungi › Veicolo, poi tocca H1',
          addTablet: 'Simbolo › Veicolo, poi tocca H1',
          pick: 'Scegli Veicolo',
          tapH1: 'Tocca H1',
          tapVehicle: 'Tocca il veicolo',
          name: 'Designazione: TLF',
          drag: 'Trascina l’autobotte su H1',
          linePhone: 'Aggiungi › Linea, poi trascina dall’autobotte all’entrata',
          lineTablet: 'Linea, poi trascina dall’autobotte all’entrata',
          linePick: 'Scegli Linea',
          lineDraw: 'Parti dall’autobotte, trascina fino all’entrata',
          lineFix: 'Traccia una nuova linea dall’autobotte all’entrata',
        },
      },
      absperrkreis: {
        title: 'Cerchio di sbarramento',
      },
      messen: {
        title: 'Misurare',
      },
      leitungRechnen: {
        title: 'Calcolare una condotta',
      },
      pumpenVerschieben: {
        title: 'Spostare le pompe',
      },
      truppAnmelden: {
        title: 'Annunciare una squadra',
      },
      funkkontakt: {
        title: 'Contatto radio & pressione',
      },
      rueckzug: {
        title: 'Ritiro',
      },
      notfall: {
        title: 'Emergenza protezione respiratoria',
      },
      truppGeschoss: {
        title: 'Squadra in un piano',
      },
      gefahrUg: {
        title: 'Pericolo nel seminterrato',
      },
      eintrag: {
        title: 'Voce nel diario',
      },
      pendenz: {
        title: 'Pendenza',
      },
      checkliste: {
        title: 'Lista di controllo',
      },
      anwesenheit: {
        title: 'Presenze',
      },
      material: {
        title: 'Materiale',
      },
      fehlalarm: {
        title: 'Chiudere un falso allarme',
      },
    },
  },
}
