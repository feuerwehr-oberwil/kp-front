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
      eingang: 'Entrata',
    },
    modules: {
      karteWasser: 'Carta & acqua',
      atemschutzGebaeude: 'Protezione respiratoria & edificio',
      protokollAbschluss: 'Diario & chiusura',
    },
    introGo: 'Via',
    drills: {
      fahrzeugLeitung: {
        title: 'Veicolo con condotta',
        intro: 'Sulla carta una condotta con freccia mostra da dove arriva l’acqua e dove scorre. Metti un TLF accanto a un idrante e stendi la condotta dal TLF fino all’entrata.',
        task: 'Metti il TLF accanto all’idrante H1 e stendi una condotta con freccia dal TLF fino all’entrata.',
        goals: {
          tlf: 'TLF accanto all’idrante H1',
          leitung: 'Condotta con freccia dal TLF all’entrata',
        },
        tlfFar: 'Il TLF è a {m} m da H1 – troppo lontano per la manichetta all’idrante',
        tlfOnTop: 'Il TLF è sopra l’idrante – mettilo accanto',
        vehicleFar: 'Il veicolo è a {m} m da H1 – e non si chiama ancora «TLF»',
        startFar: 'La condotta inizia a {m} m dal TLF',
        endFar: 'La condotta finisce a {m} m dall’entrata',
        noArrow: 'Manca la freccia – mostra dove scorre l’acqua',
        arrowBack: 'La freccia punta al TLF – l’acqua scorre verso l’entrata',
        hint: {
          karte: 'Alla carta',
          addPhone: 'Aggiungi › Veicolo, poi tocca accanto a H1',
          addTablet: 'Simbolo › Veicolo, poi tocca accanto a H1',
          pick: 'Scegli Veicolo',
          tapBeside: 'Tocca accanto a H1',
          tapVehicle: 'Tocca il veicolo',
          name: 'Designazione: TLF',
          drag: 'Trascina il TLF accanto a H1',
          linePhone: 'Aggiungi › Linea, poi trascina dal TLF all’entrata',
          lineTablet: 'Linea, poi trascina dal TLF all’entrata',
          linePick: 'Scegli Linea',
          lineDraw: 'Parti dal TLF, trascina fino all’entrata',
          lineFix: 'Traccia una nuova linea dal TLF all’entrata',
          lineTap: 'Tocca la condotta',
          arrow: 'Fine linea: freccia',
          reverse: 'Inverti direzione',
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
