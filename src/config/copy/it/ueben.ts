// Italian copy · «Üben», the topics and their steps on the private practice Einsatz.
// One slice of the `it` overlay, assembled in ../it.ts; the German base is ../de/ueben.ts.

import type { Copy, Localizable } from '../index'

export const uebenCopy: Localizable<Pick<Copy, 'ueben'>> = {
  ueben: {
    menu: 'Esercitarsi',
    sheetLead: 'Su un campo d’esercizio solo su questo dispositivo. Niente va all’intervento.',
    next: 'Prossimo',
    nextGo: 'Inizia',
    allDrills: 'Tutti gli esercizi',
    stepCount: '{n} / {total}',
    steps: '{total} passi brevi',
    nextStep: 'Continua con «{step}»',
    doneMark: 'Riuscito',
    free: 'Esercizio libero',
    freeSub: 'Campo d’esercizio senza compito – prova tutto',
    tryOut: 'Prova sul campo d’esercizio',
    kicker: '{topic} · {i} / {n}',
    show: 'Mostra',
    showMore: 'Mostra di più',
    solve: 'Soluzione',
    hideHint: 'Nascondi',
    closeFirst: 'Prima chiudere',
    more: 'Altro',
    restart: 'Ricomincia',
    leave: 'Esci dall’esercizio',
    doneSolved: 'Fatto con la soluzione – per esercitarsi, rifallo semplicemente.',
    doneNext: 'Continua',
    doneAgain: 'Ancora',
    doneList: 'Tutti gli esercizi',
    endTitle: '{topic}: riuscito',
    moreTitle: 'Che cosa c’è ancora',
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
    introGo: 'Via',
    topics: {
      karte: {
        title: 'Carta e disegno',
        intro: 'Un veicolo, le sue condotte e i loro collegamenti: disegnare sulla carta in sei passi brevi. Ogni passo si basa su quello precedente.',
        more: [
          'Fine linea: freccia con stop (limite di propagazione) e tratto (la condotta si divide)',
          'Tipo di linea: tratteggiata, linea d’arresto, zona di sgancio – con colore, spessore e testo',
          'Sulla condotta: persona, squadra, piano e contenuto',
          'Sul simbolo: nome, rotazione, numero e piano',
          'Altri strumenti: superficie, perimetro di sicurezza, nota, misura e selezione multipla',
          'Blocca: più niente si sposta per sbaglio',
        ],
        hint: {
          karte: 'Alla carta',
          linePhone: 'Aggiungi › Linea',
          lineTablet: 'Linea',
          linePick: 'Scegli Linea',
          lineTap: 'Tocca la condotta',
        },
        steps: {
          fahrzeug: {
            title: 'Mettere un veicolo',
            task: 'Metti un veicolo presso l’idrante H1.',
            goals: {
              fahrzeug: 'Veicolo presso l’idrante H1',
            },
            learned: 'Ogni simbolo si mette così: scegli il simbolo, tocca la carta. Trascinare lo sposta.',
            far: 'Il veicolo è a {m} m da H1 – trascinalo più vicino all’idrante',
            hint: {
              addPhone: 'Aggiungi › Veicolo, poi tocca accanto a H1',
              addTablet: 'Simbolo › Veicolo, poi tocca accanto a H1',
              pick: 'Scegli Veicolo',
              tapBeside: 'Tocca accanto a H1',
              drag: 'Trascina il veicolo verso H1',
            },
          },
          leitung: {
            title: 'Condotta con freccia',
            task: 'Stendi una condotta dal veicolo fino all’entrata e dalle una freccia.',
            goals: {
              leitung: 'Condotta con freccia dal veicolo all’entrata',
            },
            learned: 'La freccia mostra dove scorre l’acqua. «Inverti direzione» la gira senza ridisegnare.',
            startFar: 'La condotta inizia a {m} m dal veicolo',
            endFar: 'La condotta finisce a {m} m dall’entrata',
            noArrow: 'Manca la freccia – mostra dove scorre l’acqua',
            arrowBack: 'La freccia punta al veicolo – l’acqua scorre verso l’entrata',
            hint: {
              draw: 'Parti dal veicolo, trascina fino all’entrata',
              fix: 'Traccia una nuova linea dal veicolo all’entrata',
              arrow: 'Fine linea: freccia',
              reverse: 'Inverti direzione',
            },
          },
          verbinden: {
            title: 'Collegare',
            task: 'Stendi una seconda condotta dall’idrante H1 al veicolo e resta fermo sul veicolo finché l’anello blu è pieno. Poi sposta il veicolo.',
            goals: {
              zubringer: 'Condotta collegata a H1 e al veicolo',
              mitziehen: 'Veicolo spostato – le condotte lo seguono',
            },
            learned: 'Una condotta collegata segue il suo veicolo. Partire dal simbolo collega subito; alla fine serve l’anello pieno.',
            looseVehicle: 'La condotta non è collegata al veicolo – ridisegnala e resta sul veicolo finché l’anello è pieno',
            looseH1: 'La condotta non è collegata all’idrante – ridisegnala e parti direttamente da H1',
            hint: {
              draw: 'Parti da H1, trascina fino al veicolo e resta lì finché l’anello è pieno',
              close: 'Chiudi la condotta',
              move: 'Tocca il veicolo, poi trascina',
            },
          },
          beschriften: {
            title: 'Annotare la condotta',
            task: 'Dai alla condotta verso l’entrata un numero e un tubo.',
            goals: {
              nummer: 'La condotta ha un numero',
              schlauch: 'Tubo scelto',
            },
            learned: 'Numero e tubo stanno sulla carta alla fine della condotta. Nella stessa scheda: persona, squadra, piano e testo.',
            hint: {
              nummer: 'Linea n.: +',
              schlauch: 'Scegli il tubo',
            },
          },
          punkte: {
            title: 'Punti',
            task: 'Inserisci un punto nella condotta verso l’entrata. Poi rimuovi un punto.',
            goals: {
              einfuegen: 'Punto inserito',
              entfernen: 'Punto rimosso',
            },
            learned: 'Con i punti porti una condotta attorno a un ostacolo: «+» ne inserisce uno, trascinare lo sposta, tenere premuto lo rimuove.',
            hint: {
              plus: 'Tocca +: un nuovo punto',
              hold: 'Tieni premuto il punto finché l’anello è pieno',
            },
          },
          loesen: {
            title: 'Liberare e rimuovere',
            task: 'Libera una condotta dal veicolo. Poi rimuovila e riportala con «Annulla».',
            goals: {
              geloest: 'Collegamento liberato',
              geloescht: 'Condotta rimossa',
              zurueck: 'Riportata con «Annulla»',
            },
            learned: '«Annulla» riprende ogni passo – sulla carta, per le squadre e nella presenza.',
            hint: {
              detach: 'Libera il collegamento',
              remove: 'Rimuovi',
              undo: 'Annulla',
            },
          },
        },
      },
    },
  },
}
