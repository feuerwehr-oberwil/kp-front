// Italian copy · the «Funktionen & Hilfe» overlay.
// One slice of the `it` overlay, assembled in ../it.ts; the German base is ../de/help.ts.

import type { Copy, Localizable } from '../index'

export const helpCopy: Localizable<Pick<Copy, 'help'>> = {
  help: {
    menu: 'Funzioni e aiuto',
    title: 'Cosa può fare KP Front?',
    contents: 'Indice',
    close: 'Chiudi',
    introFallback: 'KP Front è la conduzione digitale della situazione e dell’intervento dei tuoi pompieri: carta della situazione tattica, piani degli oggetti, sorveglianza dell’autoprotezione e un diario condiviso – tutto in tempo reale su più dispositivi contemporaneamente.',
    sections: [
      {
        id: 'ueberblick', title: 'Panoramica', icon: 'info',
        blocks: [
          { kind: 'intro' },
          { kind: 'sub', text: 'Le aree di lavoro (barra sinistra)', only: 'wide' },
          { kind: 'sub', text: 'Le aree di lavoro (barra in basso)', only: 'phone' },
          { kind: 'list', items: [
            '**Mappa** – la carta tattica con simboli, linee, superfici e i livelli delle condotte.',
            '**Piani** – moduli e viste degli edifici di questo corpo come superfici di lavoro tattiche, piano per piano.',
            '**Checklist** – checklist d’intervento eseguibili.',
            '**Squadre** – sorveglianza delle squadre impiegate con tempo e pressione, con e senza autoprotezione.',
            '**Presenza** – chi è in intervento, con orari e osservazione; anche ospiti che non sono nell’elenco del personale.',
            '**Materiale** – ciò che è stato impiegato, dal catalogo o registrato liberamente.',
            '**Rapporto** – il rapporto d’intervento: un modulo precompilato, completato lungo tutto l’intervento e stampato alla fine.',
          ] },
          { kind: 'note', text: 'Principio guida: utilizzabile alle 3 di notte, dopo sei mesi senza pratica. Riconoscere invece di ricordare, usabile con i guanti e offline.' },
        ],
      },
      {
        id: 'anmelden', title: 'Accesso e ruoli', icon: 'lock',
        blocks: [
          { kind: 'lead', text: 'Si accede una volta per dispositivo: **Chi sei?** mostra gli account del corpo – toccare il proprio, inserire il **PIN**, **Accedi**.' },
          { kind: 'list', items: [
            'L’accesso resta sul dispositivo; ogni apertura dell’app lo prolunga. **Disconnetti** (nel menu) chiede prima conferma.',
            'Senza rete non si può accedere – un dispositivo già connesso apre però gli interventi salvati anche offline.',
            'PIN dimenticato, serve un nuovo account? Lo configura **l’amministrazione** – nell’app stessa il PIN non si può cambiare.',
            'Dove il corpo l’ha predisposto, funziona anche **Accedi con Microsoft**.',
          ] },
          { kind: 'sub', text: 'Ruoli' },
          { kind: 'list', items: [
            '**Editore** – tutto: mappa, piani, squadre, diario, rapporto; aprire e condividere interventi.',
            '**Capo intervento** – vede tutto e scrive presenza, materiale, checklist, rapporto, dati dell’intervento e diario; chiude e riapre. Mappa, piani e squadre restano in sola lettura.',
            '**Osservatore** – solo lettura.',
            'Ciò che un ruolo non può fare semplicemente non c’è – nessun pulsante grigio. In alto compare allora **Solo visualizzazione**, e il menu dice perché. Quale account ha quale ruolo lo decide l’amministrazione.',
          ] },
        ],
      },
      {
        id: 'karte-objekte', title: 'Mappa & oggetti – senza intervento', icon: 'pin',
        blocks: [
          { kind: 'lead', text: 'Senza un intervento aperto, KP Front arriva qui: la carta del corpo con tutti i suoi oggetti, per consultare e prepararsi. Non è un intervento – misurare, segnare e consultare avviene solo su questo dispositivo, e nulla viene salvato.' },
          { kind: 'sub', text: 'Ricerca e oggetti' },
          { kind: 'list', items: [
            'Il campo in alto cerca **indirizzi e oggetti**. Un risultato apre le sue informazioni: pericoli, idranti vicini e i **piani d’oggetto**.',
            'Ogni oggetto è contornato sulla carta con i suoi edifici e porta il suo nome; toccarlo lo apre. Toccare un altro edificio mostra ciò che il registro ne sa.',
            'I piani dell’oggetto scelto stanno nella barra sinistra e si aprono nello stesso lettore di piani dell’intervento – solo in lettura. Il pulsante in basso a sinistra riporta all’oggetto.',
          ], only: 'wide' },
          { kind: 'list', items: [
            'La ricerca in alto a destra trova **indirizzi e oggetti**. Un risultato apre le sue informazioni: pericoli, idranti vicini e i **piani d’oggetto**.',
            'Ogni oggetto è contornato sulla carta con i suoi edifici e porta il suo nome; toccarlo lo apre. Toccare un altro edificio mostra ciò che il registro ne sa.',
            'I piani sono righe nelle informazioni dell’oggetto e si aprono nello stesso lettore di piani dell’intervento – solo in lettura. «Indietro» in basso riporta alla carta.',
          ], only: 'phone' },
          { kind: 'list', items: [
            '**Visita oggetto** e **Segnala** nelle informazioni avviano il rilevamento, dove il corpo lo ha predisposto.',
          ] },
          { kind: 'sub', text: 'Strumenti' },
          { kind: 'list', items: [
            '**Posa punto** – un punto con indirizzo e coordinate (LV95 + WGS84) da copiare. Anche una pressione lunga sulla carta libera ne posa uno – sul telefono è l’unico modo.',
            '**Misura** – distanza o superficie.',
            '**Merci pericolose** – inserire il numero ONU: le indicazioni ADR/ERG e le distanze come cerchi attorno al punto scelto.',
            '**Livelli** – condotte, idranti, radar meteo e i dati della stazione; un’impostazione propria, indipendente da ogni intervento.',
            '**Checklist** – le checklist e le guide degli apparecchi del corpo da leggere, con una ricerca propria.',
          ] },
          { kind: 'list', only: 'keyboard', items: [
            'Con la tastiera: tutte le scorciatoie di questa vista in **Scorciatoie da tastiera** › «Mappa & oggetti».',
          ] },
          { kind: 'note', text: 'Quando un intervento è in corso, compare nella barra in alto – rosso, oppure tratteggiato con la parola «Esercitazione» per un esercizio – e un tocco lo apre. Un allarme viene mostrato, ma mai aperto da sé.' },
        ],
      },
      {
        id: 'einsatz', title: 'Gestire gli interventi', icon: 'swap',
        blocks: [
          { kind: 'lead', text: 'Tutto nel **Menu** in alto a sinistra – nell’intervento porta il nome dell’intervento, su «Mappa & oggetti» il segno del corpo.' },
          { kind: 'list', items: [
            'In cima l’intervento aperto: **Modifica** (i dati dell’intervento), **Chiudi** con il numero di ciò che è ancora aperto, e **Condividi**.',
            'Sotto, gli altri interventi in corso – toccarne uno per passarci. Se ne sono in corso diversi, l’intervento in alto mostra un **+N**.',
            '**Nuovo allarme** – un allarme arrivato che non è ancora un intervento: **Apri** lo apre. La **✕** nasconde solo il messaggio su questo dispositivo; sotto **Interventi** resta elencato con la campana finché qualcuno non lo apre. Un **Allarme aggiornato** nascosto torna con **Mostra** nel menu dell’intervento.',
            '**Apri intervento** – un intervento a mano, senza allarme. La prima domanda è **Reale | Esercitazione**, poi luogo (oggetto, indirizzo o sulla carta) e parola chiave. Ciò che è stato digitato a metà resta, anche se l’app si ricarica.',
            '**Tutti gli interventi** – anche quelli chiusi: toccarne uno lo apre in lettura, **Riapri** per completarlo.',
            '**Lascia l’intervento** – torna alla mappa; l’intervento continua.',
            '**Chiudi intervento** chiude l’intervento in corso – lo stesso dialogo del rapporto, con lo stesso elenco di ciò che resta aperto. Senza PDF né stampa conclusa, in cima sta **Rapporto non ancora creato** – di nuovo anche se poi il rapporto viene modificato; **Chiudere comunque** resta possibile.',
          ] },
          { kind: 'sub', text: 'Esercitazione' },
          { kind: 'list', items: [
            'Un’esercitazione è un intervento come ogni altro – tutto funziona allo stesso modo. Non conta nella statistica degli interventi e compare tratteggiata e con la parola «Esercitazione» nella barra.',
            'Aprire: **Apri intervento** › **Esercitazione** – il pulsante diventa **Apri esercitazione**. Un intervento in corso diventa un’esercitazione, o torna indietro, tramite **Modifica**.',
            'In **Tutti gli interventi** si può eliminare solo un’esercitazione chiusa che lo era fin dall’inizio. Le altre le elimina l’amministrazione.',
          ] },
        ],
      },
      {
        id: 'alarme', title: 'Allarmi su questo dispositivo', icon: 'bell',
        blocks: [
          { kind: 'lead', text: 'Un nuovo allarme sveglia ogni dispositivo connesso con un account **Editore** che consente gli allarmi – come «Neuer Einsatz», anche ad app chiusa.' },
          { kind: 'list', items: [
            'Se questo dispositivo è pronto lo dice **Impostazioni › Questo dispositivo** con **Allarme pronto**: installata come app, notifiche consentite, abbonamento allarme, accesso. Ciò che manca è indicato apertamente, con il relativo pulsante; **Allarme di prova** verifica l’intero percorso.',
            'Gli account **Capo intervento** e **Osservatore** non vengono svegliati da «Neuer Einsatz» – sotto «Allarme pronto» lo dice la riga **Account**.',
            'Gli allarmi di **autoprotezione** (in ritardo, pressione d’allarme, emergenza) suonano su ogni dispositivo che ha l’intervento aperto, con qualsiasi account.',
            '**Nessun allarme su questo dispositivo** li disattiva qui; **Attiva** li riaccende.',
          ] },
        ],
      },
      {
        id: 'navigation', title: 'Navigazione e interfaccia', icon: 'cursor',
        blocks: [
          { kind: 'lead', text: 'Tre zone fisse: la barra delle aree a sinistra, la barra dell’intervento in alto, la barra degli strumenti a destra.', only: 'wide' },
          { kind: 'lead', text: 'Due barre in basso, una in alto: in fondo la barra delle aree, sopra la barra degli strumenti, in alto la barra dell’intervento.', only: 'phone' },
          { kind: 'sub', text: 'Barre in basso', only: 'phone' },
          { kind: 'list', only: 'phone', items: [
            'La **barra delle aree** in fondo ha cinque caselle: Mappa, Piani, Checklist, Squadre e Rapporto. **Piani** e **Rapporto** raggruppano più pagine (Rapporto, Presenza, Materiale): toccare di nuovo la casella o tenerla premuta apre la scelta.',
            'Sopra, la **barra degli strumenti** della carta o del piano. **+** è l’unica porta verso tutto ciò che vi si posiziona.',
            'Un pulsante che porta solo un simbolo dice la sua parola quando lo si **tiene premuto**. Nelle **Impostazioni**, «Etichette delle barre» scrive le parole sotto in modo permanente.',
          ] },
          { kind: 'sub', text: 'Barra sinistra', only: 'wide' },
          { kind: 'list', items: [
            'Con tastiera e mouse, le caselle della barra sinistra e di quella destra che hanno una scorciatoia mostrano la loro lettera – così anche «Diario» e «Voce» in alto. Tutte le scorciatoie sono in **Scorciatoie da tastiera**.',
            'Trascinando il bordo destro della barra la si espande con le etichette o la si richiude.',
          ], only: 'wide' },
          { kind: 'sub', text: 'Barra dell’intervento in alto' },
          { kind: 'list', items: [
            'A sinistra il nome dell’intervento con il **Menu** (chiudi intervento, gli altri interventi in corso, impostazioni, questo aiuto …) e l’**orologio dell’intervento**.',
            'A destra il **Meteo**, **Annulla/Ripristina**, **Diario** e **Voce**.',
          ], only: 'wide' },
          { kind: 'list', only: 'phone', items: [
            'A sinistra il nome dell’intervento con il **Menu** (chiudi intervento, gli altri interventi in corso, impostazioni, questo aiuto …), a destra **Annulla** e il **Diario**.',
            'Il pulsante rotondo in basso a destra è **Voce**.',
          ] },
          { kind: 'sub', text: 'Barra dei messaggi' },
          { kind: 'list', items: [
            'Subito sotto la barra dell’intervento c’è **una** striscia per tutto ciò che è in sospeso e resta finché qualcuno non agisce: una squadra di autoprotezione in ritardo, un nuovo allarme, un promemoria scaduto, dati d’allarme non verificati, un aggiornamento pronto. Ogni messaggio è una riga sotto l’altra – niente più schede che si coprono a vicenda.',
            'L’ordine è fisso, non cronologico: prima l’**autoprotezione**, poi l’**allarme**, poi il **promemoria**. Ciò che aspetta qualcuno sta sempre sopra ciò che sparisce da sé.',
            'Agiscono solo i pulsanti con etichetta, la **✕** e – se il messaggio porta a un luogo – il suo **titolo**. Toccare la riga altrove non fa nulla: leggere non deve essere la stessa cosa che agire. Se non c’è nulla in sospeso, la striscia non esiste.',
          ] },
          { kind: 'sub', text: 'Barra degli strumenti a destra', only: 'wide' },
          { kind: 'list', items: [
            'Gli strumenti di disegno e posizionamento.',
            'Sotto, nell’angolo in basso a destra, la **barra di visualizzazione** – sempre visibile, anche quando gli strumenti scorrono: sulla carta **Livelli** e **Viste** (la bussola), sul piano **Adatta** e la freccia del nord; con il mouse anche **−** e **+**.',
          ], only: 'wide' },
        ],
      },
      {
        id: 'tastatur', title: 'Scorciatoie da tastiera', icon: 'type', only: 'keyboard',
        blocks: [
          { kind: 'lead', text: 'Con la tastiera tutto è raggiungibile senza mouse. Le scorciatoie non fanno nulla mentre si scrive in un campo, né dietro una finestra aperta. Dove una casella ha un tasto, la sua lettera vi è scritta – in entrambe le barre, nella barra di visualizzazione in basso a destra e su «Diario» e «Voce» in alto.' },
          { kind: 'sub', text: 'Cambiare area' },
          { kind: 'list', items: [
            'I numeri aprono il modulo di piano con quel numero – quali esistono dipende dai moduli di questo corpo: [[1]] modulo 1, [[2]] o [[3]] il modulo «2/3», [[4]] modulo 4 …',
            '[[K]] Mappa · [[C]] Checklist · [[A]] Squadre (A come Atemschutz) · [[P]] Presenza · [[M]] Materiale · [[R]] Rapporto – ogni volta la prima lettera del nome tedesco dell’area (Presenza: P come Personal).',
            '[[⌘]] [[[]] / [[⌘]] [[]]] scorre tutte le aree una alla volta (anche Dintorni ed Edificio, che non hanno numero).',
          ] },
          { kind: 'sub', text: 'Strumenti (uguali su mappa e piano)' },
          { kind: 'list', items: [
            '[[V]] Selezione · [[W]] Multiplo · [[S]] Simbolo · [[L]] Linea · [[F]] Superficie · [[U]] Perimetro di sicurezza · [[N]] Nota · [[T]] Squadra · [[D]] Misura.',
          ] },
          { kind: 'sub', text: 'Modifica' },
          { kind: 'list', items: [
            '[[⌘]] [[Z]] Annulla · [[⌘]] [[⇧]] [[Z]] Ripristina · [[⌘]] [[D]] Duplica · [[⌫]] elimina la selezione.',
            '[[Esc]] torna indietro di un livello a ogni pressione finché la carta è libera: Livelli / Viste → un simbolo in posa, o Rileva coordinate → lo strumento → il pannello della nota → la selezione – nello stesso ordine sui piani. Un menu, una scheda o una finestra sopra, [[Esc]] lo chiude per primo e da solo. In un campo [[Esc]] lascia solo il campo e tiene il testo digitato; chiude la **Voce** e ne tiene il testo per la prossima apertura.',
          ] },
          { kind: 'sub', text: 'Vista e pannelli' },
          { kind: 'list', items: [
            '[[+]] / [[−]] Zoom · [[0]] Adatta · [[G]] La mia posizione · [[X]] Rileva coordinate sì/no. «Verso nord» non ha tasto – a questo serve la bussola, sempre visibile e che ruota con la carta.',
            '[[J]] Diario · [[E]] Voce · [[B]] Livelli · [[⌘]] [[,]] Impostazioni · [[?]] questo aiuto.',
            'Sulla **lavagna**, [[Pag↑]] / [[Pag↓]] sfogliano le sue pagine.',
          ] },
          { kind: 'sub', text: 'Mappa & oggetti (senza intervento)' },
          { kind: 'list', items: [
            'Gli stessi tasti dove esiste la stessa cosa: [[K]] Mappa · [[C]] Checklist · i numeri i moduli dell’oggetto scelto · [[D]] Misura · [[B]] Livelli · [[G]] La mia posizione · [[0]] Adatta · [[+]] / [[−]] Zoom · [[⌘]] [[,]] Impostazioni · [[?]] questo aiuto.',
            'In più, ciò che esiste solo qui: [[P]] Posa punto · [[U]] Merci pericolose (U come numero ONU) · [[/]] o [[⌘]] [[K]] la ricerca.',
            '[[Esc]] torna passo per passo alla carta: ricerca → Viste → strumento → piano aperto → selezione.',
          ] },
        ],
      },
      {
        id: 'lage', title: 'Mappa – la carta tattica', icon: 'map',
        blocks: [
          { kind: 'lead', text: 'La carta tattica sopra lo sfondo cartografico reale (area d’intervento e dintorni).' },
          { kind: 'list', items: [
            '**Mappa di base** (in cima al pannello Livelli) cambia lo sfondo: Carto, OpenStreetMap o satellite.',
            '**Viste** – la bussola (in basso a destra, sul telefono nella barra degli strumenti accanto a Livelli) – offre **Verso nord**, **Adatta**, **La mia posizione**, **Rileva coordinate** e le viste salvate; con il mouse ci sono accanto **−** e **+**. Durante il rilevamento, toccare la carta per fissare un punto (LV95 + WGS84).',
            '**Meteo** sta in continuo nella barra dell’intervento: temperatura, una freccia nella direzione verso cui tira il vento, e la sua forza – la direzione di propagazione a colpo d’occhio. Un tocco mostra raffiche e direzione in gradi.',
            '**Veicoli** appaiono in tempo reale via GPS (nome + orientamento), la propria posizione come punto blu fisso.',
            '**Info edificio** in basso a sinistra indica i pericoli dell’edificio sul luogo d’intervento (⚠ gas · PV) – il numero accanto conta le misure immediate – e apre la sua scheda: pericoli, **Misure immediate** e osservazioni in alto, sotto i dati del registro. La prima volta che questo dispositivo apre l’intervento, la scheda si apre da sola perché venga letta – la carta resta utilizzabile. ✕ la chiude; poi la riapre il chip. Un altro luogo d’intervento o oggetto con contenuto la mostra di nuovo.',
          ] },
        ],
      },
      {
        id: 'ebenen', title: 'Livelli e dati', icon: 'layers',
        blocks: [
          { kind: 'lead', text: 'Tramite **Livelli** mostri i dati delle condotte e dei pericoli – ordinati per tipo.' },
          { kind: 'list', items: [
            '**Inhalte** – Taktische Zeichen, Fahrzeuge, Fahrzeugspuren, Personen (live), Skizzen & Notizen: i contenuti dell’intervento. Se uno di essi è nascosto, il pulsante **Livelli** porta un punto.',
            '**Corpo** – costruzioni sotterranee (autorimesse, rifugi, gallerie) dalla misurazione ufficiale, tratteggiate dallo zoom strada; visibili per impostazione predefinita.',
            'Quali livelli esistono dipende dai geodati di questo corpo – nulla è incluso di serie. Di solito:',
            '**Acque reflue** – acque nere/miste, acque chiare/meteoriche, pozzetti / caditoie.',
            '**Gas** – condotte.',
            '**Elettricità** – linee, impianti FV.',
            '**Pericoli** – piene, profondità di allagamento.',
          ] },
          { kind: 'lead', text: 'Ogni livello può essere mostrato/nascosto e regolato nell’opacità.' },
          { kind: 'list', items: [
            'Il precaricamento per l’offline avviene da sé – che cosa è pronto lo dice **Impostazioni › Questo dispositivo** (vedi «Multi-dispositivo e offline»).',
          ] },
          { kind: 'note', text: 'I dati delle condotte coprono l’area d’intervento configurata e sono disponibili localmente – funzionano anche offline.' },
        ],
      },
      {
        id: 'zeichnen', title: 'Disegno e simboli', icon: 'pen',
        blocks: [
          { kind: 'lead', text: 'Gli strumenti della mappa – sul piano gli stessi.' },
          { kind: 'list', items: [
            '**Simbolo** – il segno tattico (FKS/VKF). Selezione rapida dei segni più comuni o ricerca in tutta la libreria. Tocca per posizionare; con «Posiziona più» ne metti più di seguito.',
            '**Forme** – nella stessa finestra, dopo i pericoli: **Freccia**, **Rettangolo** e **Rotazione** (con vettore Eli o TLF), per tutto ciò che non ha un segno tattico. La maniglia ruota; sul rettangolo maniglie proprie tirano larghezza e altezza, sulla freccia l’estremità fissa distanza e direzione. Sulla freccia, **Barra di arresto** aggiunge la barra di traverso alla punta – il limite di propagazione: fin qui, e lì fermato.',
            '**Selezione** – tocca gli oggetti, spostali, modificali nell’editor.',
            '**Multiplo** – tocca di nuovo **Selezione** mentre è attiva: il pulsante passa a Multiplo (simbolo e parola) e trascinando un riquadro selezioni più simboli/disegni in una volta. Un ulteriore tocco riporta a Selezione.',
            '**Linea** – **Mano libera** (trascinare) o **Punti** (toccare, ✓) si sceglie nella barra dello strumento. Nell’editor poi la **Linea** – Continua, Tratteggiata, Linea d’arresto o Zona di sgancio – e l’**Estremità** – **Nessuna**, **Freccia**, **Freccia con stop** (la stessa barra di traverso alla punta) o **Tratto**; **Inverti il senso** la porta all’altra estremità senza spostare la linea.',
            '**Superficie** – trascinare liberamente il contorno o toccare i vertici e ✓ (area indicata da 3 punti in poi). Trascinare i vertici li sposta, il **+** a metà di un lato ne inserisce uno, **tenere premuto** un punto lo rimuove.',
            '**Perimetro di sicurezza** – trascina dal centro al bordo per impostare il raggio in metri (riempimento regolabile).',
            '**Nota** – testo libero direttamente sulla carta.',
            '**Squadra** – posare il marcatore di una squadra: toccare e scegliere la squadra.',
            '**Misura** – distanza (distanza + profilo altimetrico) o superficie (area + perimetro). Trascinare i punti li sposta, il **+** a metà di un tratto aggiunge un punto intermedio, **tenere premuto** un punto lo rimuove (con il mouse: clic destro).',
            '**Punto di misura** – per misurazioni di gas (CO, Ex, O₂, H₂S) in un punto, sulla carta o su un piano dell’edificio: cercare «Punto di misura» nella finestra dei simboli, posarlo, inserire i valori. Giallo = A1 (preallarme), rosso = A2 (allarme principale); un valore vecchio porta la sua età («18′»). **Misurazioni** elenca tutti i punti di misura.',
            '**Trasporto d’acqua** – sotto il profilo altimetrico di una distanza o in una condotta: scegliere Ø del tubo, quantità d’acqua, fonte (idrante, stagno, pompa) e pressione in entrata; il diagramma mostra la pressione lungo la condotta e posiziona le pompe. **Mettere sulla carta come condotta** conserva il calcolo; su una condotta l’interruttore **Pompe sulla mappa** le disegna come simboli.',
          ] },
          { kind: 'sub', text: 'Preimpostazioni dei simboli' },
          { kind: 'lead', text: 'Ogni simbolo porta solo i comandi sensati: **Rotazione** per i segni orientati (frecce, scale, pareti), **Quantità** dove più elementi contano, **Piano** o un **Intervallo di piani** (es. scala/ascensore), **Propagazione** per le situazioni di danno – più i campi di immissione adatti (es. nome, sostanza, stato).' },
        ],
      },
      {
        id: 'wassertransport', title: 'Trasporto d’acqua', icon: 'drop',
        blocks: [
          { kind: 'lead', text: 'Calcola una condotta di trasporto: quanta pressione arriva dove, e dove devono stare le pompe. Un **aiuto alla pianificazione** – le fonti dei numeri sono dietro la **ⓘ** nell’intestazione (AGV, FKS).' },
          { kind: 'sub', text: 'Disegnare la condotta' },
          { kind: 'list', items: [
            'Disegnare una **Linea** lungo la strada, **dalla fonte al luogo d’intervento** – l’acqua scorre dal primo all’ultimo punto. Toccare la condotta, aprire **Dimensioni** e toccare **Calcolare il trasporto d’acqua**.',
            'Oppure provare prima: **Misura › Distanza**, poi **Calcolare il trasporto d’acqua** sotto il profilo altimetrico. **Mettere sulla carta come condotta** riprende la distanza con tutto il calcolo.',
            'Direzione sbagliata? **⇄** nell’intestazione la inverte, il disegno resta. La lettera all’inizio della condotta (**I**, **S**, **P**) mostra dov’è la fonte.',
          ] },
          { kind: 'sub', text: 'Fonte, acqua, pressione in entrata' },
          { kind: 'list', items: [
            '**Ø del tubo** – 55, 75, 2× 75 o 110 mm (in una condotta la riga **Tubo**, lì anche 40 mm); la perdita di carico viene dalla tabella AGV.',
            '**Acqua** – la quantità che deve arrivare in fondo (l/min). Scegliere una proposta o digitare un’altra quantità.',
            '**Fonte** – idrante, stagno o pompa. La **Pressione in entrata** è la pressione con cui la condotta vi inizia: all’idrante la pressione statica, alla pompa la sua pressione in uscita. Uno stagno non ha pressione – la prima pompa sta alla fonte.',
          ] },
          { kind: 'sub', text: 'Leggere il diagramma' },
          { kind: 'list', items: [
            'La linea nera è la **pressione** lungo la condotta, sotto il **terreno**. Le fasce: verde **buono** sopra 3 bar, giallo **scarso** 2–3 bar, rosso **troppo poco** sotto 2 bar.',
            'I punti **P1**, **P2** … sono le pompe – messe automaticamente dove la pressione scende a 2 bar (FKS: una pompa ha bisogno di almeno 2 bar in entrata). Sulla mappa portano gli stessi nomi.',
            'Passare sopra il diagramma o toccarlo con il dito mostra la pressione in quel punto – sulla mappa compare il punto corrispondente.',
            'Sotto, **salita/discesa** e **Pressione in fondo**. In **Tubi** la riserva sta a parte, p. es. «34 + 3 di riserva × 20 m».',
          ] },
          { kind: 'sub', text: 'Spostare le pompe' },
          { kind: 'list', items: [
            'Toccare una pompa mostra dove sta, la sua **Pressione in entrata** e la **Pressione in uscita** (regolabile con **−**/**+**).',
            '**Trascinare** una pompa – di lato nel diagramma o lungo la condotta sulla mappa – la fissa lì («a mano»); le pompe successive vengono ricalcolate. Poi compare **Tutte le pompe automatiche**, che ripristina tutto.',
            '**Pompe sulla mappa** disegna le pompe come motopompe sulla mappa e sullo schizzo stampato. Toccare una pompa sulla mappa apre la condotta con le **Dimensioni** aperte.',
          ] },
          { kind: 'sub', text: 'Avvisi' },
          { kind: 'list', items: [
            '**Pompa 1: pressione in entrata sotto 2 bar** – una pompa messa a mano sta troppo lontano; avvicinarla alla fonte o **Tutte le pompe automatiche**. **Nessuna pressione**: lì non arriva più acqua.',
            '**Più del solito** – moltissime pompe; accanto, quante ne servirebbero con un altro Ø del tubo.',
            '**Calcolato senza profilo altimetrico** (offline, fuori dalla Svizzera) e **fuori dalla tabella AGV** – i numeri sono stimati.',
            'Un avviso di pompa viene annotato una volta nel **Diario** quando compare, e così arriva nel rapporto.',
          ] },
        ],
      },
      {
        id: 'plan', title: 'Piano – moduli ed edifici', icon: 'doc',
        blocks: [
          { kind: 'lead', text: 'Per ogni oggetto una superficie di lavoro sopra i piani dei moduli e degli edifici – piano per piano, con strumenti propri.' },
          { kind: 'list', items: [
            'In basso a sinistra c’è il chip dell’**Oggetto** con una spia – toccarlo apre «Piano · …» con le righe **Oggetto** (scegliere un altro oggetto), **Mappa** e **Scala**. L’oggetto determina i piani tra cui scegliere.',
            'Gli stessi strumenti della mappa: **Selezione**, **Simbolo**, **Linea**, **Superficie**, **Perimetro di sicurezza**, **Nota**, **Squadra** e **Misura**.',
            '**Piani** dell’edificio come pila: con i pulsanti **PS/PI** sul piano aggiungi un piano sopra/sotto.',
            '**Adatta** e la freccia del nord nella barra di visualizzazione, come sulla mappa.',
            '**Squadre** come marcatori colorati; le **Tracce** di una squadra mostrano il suo percorso: **Segna** sul suo marcatore aggiunge il punto successivo, **Altro** le mostra o nasconde. I chip delle squadre «fuori» vengono attenuati/barrati.',
            '**Scala** – sotto **Misura** scegliere «Scala» (o calibrare dalla riga **Scala** dietro il chip dell’oggetto), i passi compaiono in basso da soli: toccare le due estremità della barra di scala stampata, poi inserire la lunghezza reale; **Annulla** la interrompe. Da lì linee, superfici e **Misura** indicano metri veri. Su un piano senza scala **Misura** comincia da lì – il campo resta vuoto finché non si digita una lunghezza, poi **Distanza** misura, e **Annulla** ritira una calibrazione sbagliata.',
            'Un foglio **collegato** alla mappa misura già da sé – così come la pila dei piani dell’edificio, che conosce la propria dimensione dalla pianta. Lì la riga **Scala** dietro il chip dell’oggetto dice da dove viene. A mano si calibra solo ciò che non è collegato.',
            '**Una nota veloce a mano?** Il piano è la superficie da schizzo: disegna liberamente, barra, scarabocchia. La mappa resta strutturata (simboli, linee, note), così rapporto e diario restano puliti.',
          ] },
          { kind: 'sub', text: 'Collega alla mappa (georeferenza)' },
          { kind: 'list', items: [
            '**Collega alla mappa** (dietro il chip dell’oggetto) posa questo foglio sulla mappa: il piano cede metà della superficie, accanto sta la mappa. Sul telefono non c’è spazio per entrambe – lì la barra in basso passa tra **Mappa** e il piano, si porta il punto sotto il mirino e si tocca **+**; la lente in basso a sinistra mostra su cosa sta, e lo stato **0/2** apre i passi. Posare lo stesso punto su entrambe le superfici – uno spigolo di casa, un idrante, un incrocio. **L’ordine non conta**: le metà posate trovano da sé la loro controparte, e si può passare da una superficie all’altra a piacere. Due punti bastano per posare il foglio.',
            'Il **semaforo** nella barra dice in ogni momento a che punto si è: due punti risolvono in modo esatto e sono quindi **non verificati** – solo il terzo misura lo scarto («4 punti · ⌀ 1.2 m»). **Verifica la sovrapposizione** posa il foglio sulla mappa per un controllo a vista.',
            '**Trascinare** una croce posata la sposta, **toccarla** apre **Sposta**, **Rimuovi punto** o **Mantieni**. Un tocco su **collegato** apre la **Precisione** con coppie e scarto; **Copia** copia i punti su un altro modulo dello stesso oggetto, **Rimuovi** li toglie (con richiesta di conferma). **Chiudi** non scarta nulla – ciò che è posato è già salvato.',
            'Da lì **entrambe le superfici mostrano gli stessi oggetti** – non una copia, lo stesso oggetto: toccarlo mostra i dati, trascinarlo lo sposta, vertici e maniglie sono gli stessi da entrambe le parti.',
            'Dove un oggetto **sta** lo decide l’ultima mano che lo ha posato: trascinato su un foglio, sta sul foglio – e si sposta con esso quando il collegamento viene corretto. Trascinato sulla mappa, sta a terra. Un collegamento corretto riposiziona tutto ciò che sta sul foglio – una riga nel diario, che un ↶ annulla. **Forma del foglio misurata** è lo stesso riposizionamento senza alcun gesto: l’app ha misurato il foglio aperto e risolto il collegamento nella forma giusta. **Rimuovere** il collegamento non perde nulla: foglio e mappa mantengono entrambi ciò che mostrano.',
            'Nei **Livelli** ogni foglio collegato riceve una riga propria («Piano (Modulo 2)»): il foglio stesso, come immagine sotto la mappa. Gli oggetti posati su di esso non hanno più bisogno di una riga propria – appartengono al livello su cui sono stati posati.',
          ] },
          { kind: 'note', text: '**Edificio** è UNA casella nella barra delle aree: finché non ne è scelto nessuno (simbolo del contorno), mostra i contorni degli edifici in tempo reale da OpenStreetMap – toccare un edificio, adottarlo, e la casella diventa la pila dei piani. Se l’intervento ha un luogo, l’edificio lì è già segnato – basta verificare e adottare. In basso a sinistra «Scegli un altro edificio» riporta alla scelta. Il **Modulo 6** (piani dei piani) è di norma un semplice visualizzatore da sfogliare/ingrandire – si annota sulla pila dei piani dell’edificio, non sul PDF del modulo 6. Se un modulo è un visualizzatore lo dice la configurazione dei moduli di questo corpo.' },
          { kind: 'note', text: '**Da che parte è girato l’edificio?** Un tocco sulla **Freccia nord** della pila dei piani (nella barra di visualizzazione) apre la finestrella «Ruota l’edificio»: un cursore **Rotazione** con anteprima, più **Nord in alto** e **Ruota sull’asse maggiore** con un tocco ciascuno. Il contorno gira con essa, le marcature restano dove stanno sull’edificio – e le pagine dei piani stampate mostrano l’angolo impostato.' },
        ],
      },
      {
        id: 'atemschutz', title: 'Squadre e sorveglianza autoprotezione', icon: 'stopwatch',
        blocks: [
          { kind: 'lead', text: 'Sorveglianza senza lacune di ogni squadra ARA secondo FKS – il segnale di sicurezza è il **tempo dall’ultimo contatto radio**, non un tempo residuo stimato.' },
          { kind: 'sub', text: 'Annunciare una squadra' },
          { kind: 'list', items: [
            '**Chi entra**: tre posti, quello in alto è il **CS** – toccare l’intera riga designa qualcuno capogruppo, la **✕** lo toglie. Una squadra più grande aggiunge semplicemente altre righe.',
            'La **ricerca persona** trova tutto il personale, non solo i presenti; accanto a ogni nome sta ciò che lo sconsiglia (non presente, rimessa, già in una squadra). **(+)** registra un ospite (pompieri vicini) – che finisce nello stesso momento nella presenza e lì vale come la stessa persona.',
            'La **Pressione d’ingresso** (bar) e il **Canale radio** stanno di fianco.',
            'Sotto il **Compito**: tipo (con autoprotettore Salvare, Spegnere, Perlustrare, Mettere in sicurezza, Ricognizione, Altro; senza autoprotettore Traffico, Sanitario, Approvvigionamento idrico, Mettere in sicurezza, Messa a disposizione, Altro), **Obiettivo / luogo** in chiaro, **Linea n.** (le linee già disegnate sono proposte di fianco) e il **Colore** su mappa e piano.',
            'Il compito non trattiene nessuno: **Annuncia squadra** funziona anche senza. La scheda riporta allora **«Incarico aperto»**, e toccandolo si apre il modulo.',
            'Quanto digitato resta se la finestra si chiude con **✕** o con un clic di fianco – solo **Annulla** lo scarta.',
          ] },
          { kind: 'sub', text: 'Sorveglianza per squadra' },
          { kind: 'list', items: [
            'L’orologio di ogni squadra conta **dall’ultimo contatto**: **Contatto ok** → dopo {contactMin} min giallo **Contatto in scadenza** → dopo altri {graceSec} s rosso **In ritardo** con allarme. Entrambi i valori li fissa il corpo nell’amministrazione.',
            '**Contatto** conferma il contatto radio e azzera l’orologio.',
            '**Pressione** apre i valori: **un tocco su un valore salva subito** – non c’è conferma. Vale come contatto e viene registrato. Tocco sbagliato? **↶ Annulla** lo ritira. Alla pressione d’allarme la pressione diventa rossa.',
            'Stato **Annunciata → In intervento → Ritiro → Fuori**. Il **Ritiro** si può revocare con **Continua**; **Fuori** chiede la pressione residua. Una squadra fuori torna in sorveglianza con **Rientrare** (nuova bombola) – il **registro delle pressioni del primo impiego resta** e compare poi per intero sul rapporto.',
            'Le squadre fuori stanno in grigio sotto **Fuori**. Nell’ordine «Come posate» mantengono invece il loro posto.',
            'Una **squadra rimossa** sparisce solo dalla sorveglianza: sul rapporto resta, con tutto ciò che è stato misurato, e come **«Rimosso»**. Con **Squadre rimosse** nell’intestazione torna indietro – l’avviso «Annulla» è la porta veloce, non l’unica.',
            '**Diario** per squadra (espandibile) mostra ogni contatto con ora e pressione.',
            'Il **⋯** in fondo alla scheda: **Modifica** adatta compito / obiettivo o squadra durante l’intervento, **Posiziona** mette la squadra sulla mappa o sul piano (poi **Mostra sul piano**), inoltre linea, ordinamento e **Rimuovi**.',
            'Chi è in una squadra non si può congedare nella **Presenza** – toccando la riga si salta invece alla scheda di quella squadra, evidenziata per un momento.',
            'Le squadre in ritardo salgono in alto e in cima appare un contatore. La **campanella** silenzia l’allarme per dispositivo – suono **e** notifica, e solo fino alla fine di questo intervento. Se è rossa, il browser non ha sbloccato l’audio: toccarla. La sorveglianza stessa non è mai muta. Tutto finisce nel diario.',
            '**Condividi squadre** (il QR accanto alla campanella) porta le squadre anche su un altro dispositivo – vedi «Condividere e presentare».',
          ] },
          { kind: 'sub', text: 'Emergenza autoprotezione' },
          { kind: 'list', items: [
            'Su una squadra che è dentro c’è la casella larga **Emergenza**. Va **tenuta premuta** finché non si è riempita del tutto – un tocco breve non attiva nulla.',
            'Allora la squadra è rossa ovunque, con un proprio orologio d’emergenza e allarme su ogni dispositivo. La sua pagina dice ciò che conta adesso: dov’era, ultimo contatto, ultima pressione, canale – e **Impiegare la squadra di sicurezza**.',
            'Si conclude allo stesso modo: tenere premuto **Emergenza conclusa** – oppure annunciare **Fuori**, che la conclude anch’essa. Entrambi stanno nel diario e sul rapporto; ↶ li ritira.',
          ] },
        ],
      },
      {
        id: 'anwesenheit', title: 'Presenza', icon: 'people',
        blocks: [
          { kind: 'lead', text: 'Chi è in intervento, e da quando a quando – la base del foglio del personale e delle ore. Il personale viene dall’amministrazione; qui si registra solo chi c’è oggi.' },
          { kind: 'sub', text: 'Registrare' },
          { kind: 'list', items: [
            '**Toccare** una riga la fa avanzare: **non presente → presente → andato via → non presente**. Il primo «presente» parte dall’**Ora dell’allarme** (di solito si tocca più tardi dell’arrivo), un rientro parte da adesso.',
            'Ogni riga ha un’**Osservazione** («autista TLF», «ferito, sostituito 21:40»). Descrive che cosa ha fatto questa persona qui e sta sul foglio del personale. Se una riga passa per errore su «non presente», l’osservazione torna al prossimo «presente».',
            'Chi è **sul posto** o in **rimessa** sta come coppia nella riga – la risposta a «chi potrei ancora richiamare». L’intestazione mostra la ripartizione appena qualcuno è in rimessa.',
            'Chi non è nell’elenco del personale (pompieri vicini, ospite): digitare il nome nella ricerca, l’ultima riga diventa allora **Aggiungi «…» come ospite**. La persona porta il segno **Ospite** – un’affermazione su questo intervento, non sull’appartenenza al corpo.',
            'Chi è **in una squadra** qui non si può congedare – un tocco salta invece alla scheda della squadra; lì annunciare prima **Fuori**.',
          ] },
          { kind: 'sub', text: 'Correggere' },
          { kind: 'list', items: [
            '**Annulla / Ripristina** nella barra dell’intervento ritira l’ultimo tocco. Il diario tiene entrambi: il tocco e la correzione.',
            'Orari sbagliati? L’**orologio** nella riga apre gli **Intervalli registrati** della persona: correggere da/a, anche per un orario precedente, se qualcuno è stato qui due volte. Chi ritorna riceve un nuovo orario con **Di ritorno**.',
            'Le tre viste in alto: **Presenza** (chi c’è), **Pianificazione** (chi è disponibile quando), **Turni** (i cambi come bande).',
          ] },
          { kind: 'note', text: 'La registrazione funziona anche **via QR** (cartello in rimessa): chi si iscrive lì compare qui – ed entrambe le parti possono toccare la stessa persona senza perdere nulla.' },
        ],
      },
      {
        id: 'mittel', title: 'Materiale', icon: 'box',
        blocks: [
          { kind: 'lead', text: 'Che cosa è stato impiegato – dal catalogo del corpo o registrato liberamente. Il rapporto ne stampa la lista del materiale.' },
          { kind: 'list', items: [
            'Il **catalogo** viene dall’amministrazione, con unità e scorta («sul TLF», «Pio»). **+** aumenta la quantità, la riga resta.',
            '**Altro materiale** registra ciò che il catalogo non conosce – bastano denominazione e quantità.',
            'Se sulla mappa o sul piano c’è un simbolo per un materiale (ventilatore, assorbente) non ancora registrato, lo dice una **barra sopra la lista**: «Posato, ma non registrato». **Registra** registra tutto ciò che manca con la provenienza dalla scorta – un tocco, invece di registrare due volte la stessa cosa. Se c’è più di una possibilità, il pulsante si chiama **Registra …** e chiede.',
            'Portare una quantità a **0** non toglie la riga dal verbale – il rapporto mostra che cosa è stato impiegato e che cosa è stato ritirato.',
          ] },
        ],
      },
      {
        id: 'zeitplan', title: 'Pianificazione e turni', icon: 'clock',
        blocks: [
          { kind: 'lead', text: 'La seconda e la terza vista della presenza: non «chi c’è» ma **chi è disponibile quando** – per un intervento che dura più di un turno.' },
          { kind: 'list', items: [
            'Nella **Pianificazione** ogni persona ha la sua riga; trascinando (o con la matita) si pianifica una finestra di disponibilità. È un **piano**, non un verbale: non scrive alcuna presenza – quella nasce solo quando qualcuno tocca davvero.',
            '**assegnato** (pieno) o **disponibile** (vuoto) – la differenza tra «viene» e «potrebbe venire»; in verde chi c’è davvero.',
            'Il **Periodo** in alto decide quante ore si vedono insieme.',
            'In **Turni** le stesse finestre sono raggruppate in bande con un nome («notte 22–06»): creare una banda non scrive alcun turno, e cancellarne una riga non cancella alcuna disponibilità.',
            'Entrambe le viste si stampano: **Su carta** (la stampante nell’intestazione) – **Disponibilità**, e appena ci sono bande **Piano dei turni**; come PDF o direttamente sulla stampante di caserma.',
          ] },
        ],
      },
      {
        id: 'checkliste', title: 'Checklist', icon: 'check',
        blocks: [
          { kind: 'lead', text: 'Un elenco con una ricerca: compiti eseguibili, consultazione di tattica e parole chiave, le istruzioni degli apparecchi del corpo.' },
          { kind: 'list', items: [
            '**Corrispondenze** sta in cima: le voci che riguardano la parola chiave dell’intervento.',
            '**Compiti** – checklist d’intervento (es. supporto alla conduzione, rapporto di situazione) con indicatore di avanzamento; spunta le voci, le diramazioni seguono procedure a più livelli.',
            'I gruppi di consultazione del corpo – cercare una parola chiave e aprire la voce (con codice colore dei pericoli e schizzi) – e le **Istruzioni** per gli apparecchi.',
          ] },
          { kind: 'lead', text: 'Lo stato viene conservato e sincronizzato su tutti i dispositivi.' },
        ],
      },
      {
        id: 'verlauf', title: 'Diario e voce', icon: 'verlauf',
        blocks: [
          { kind: 'lead', text: 'Un diario condiviso e continuo su mappa e piano – il decorso dell’intervento.' },
          { kind: 'list', items: [
            '**Voce**: un tocco breve apre l’immissione testo. **Tenere premuto** apre due campi – **Nota vocale** e **Foto** – che restano finché non se ne tocca uno; il pulsante stesso diventa una **✕** e annulla. Nella voce stessa registrazione, file e foto allegano qualcosa; quando lo spazio è poco (di solito con la tastiera aperta) stanno insieme sotto la **graffetta**.',
            'Da **due lettere** in poi vengono proposti nomi – personale, materiale, organizzazioni partner, veicoli e gruppi d’allarme, più i posti **CI** e **Sost. CI**. Toccandone uno si inserisce il nome intero; nel diario e sul rapporto stampato è evidenziato. Chi scrive il posto ottiene anche il nome («CI (Widmer Céline)»), chi scrive il nome ottiene il posto. Non c’è un campo «da» separato: la frase dice già chi ha segnalato.',
            'Appena la frase termina con un nome, accanto compaiono **→** e **←** come proposta: un tocco scrive la freccia, e «CI → sanità: paziente stabile» si legge come il protocollo radio che il diario è. Sulla carta diventa «->».',
            'Finché il campo è **vuoto**, sono pronti i chip iniziali: prima **CI →**, poi le formulazioni già scritte in questo intervento (altrimenti la lista del corpo). Restano finché non si digita davvero – un secondo chip si aggiunge al primo.',
            'Le azioni rilevanti (simbolo posato, disegno creato/rimosso …) finiscono automaticamente nel diario.',
            '**Annulla/Ripristina** vale per mappa, piano, squadre – e per la **Presenza**: lì ritira l’ultimo tocco.',
            'Una voce del diario con un luogo, se toccata, riporta al punto sulla mappa o sul piano; foto e note vocali si aprono/riproducono direttamente nel diario.',
            'Un **errore di battitura** si può correggere: la **matita** nella riga sta su tutto ciò che qualcuno ha digitato di persona – non su ciò che l’app ha scritto su un’azione («Squadra 2 entrata»). La riga porta poi **Corretto HH:MM**; il testo originale resta nel verbale e nella catena di verifica.',
            '**Riproduzione** (▶ nel diario) riproduce mappa e piano a un momento precedente (cursore temporale; la modifica è bloccata). Nell’intervento in corso si apre su «Adesso», e **Riproduci** riparte dall’inizio; in quello chiuso si apre all’inizio. Sul telefono ▶ sta sul righello del tempo.',
            'Il testo digitato a metà nella **Voce** resta, anche se l’app si ricarica – foto e note vocali no.',
          ] },
          { kind: 'sub', text: 'Pendenze' },
          { kind: 'list', items: [
            'L’**anello** accanto a «Info · Ordine · Misura immediata» fa di una voce una **Pendenza**: resta aperta finché non è spuntata. Un tocco sull’anello apre la scelta – **Nuova pendenza**, **Pendenza urgente**, oppure una già aperta, a cui questa voce viene appesa come **Segnalazione**.',
            'Le pendenze aperte stanno **in cima al diario**, le urgenti per prime, poi le più vecchie. L’ora dice **quando sono state impartite**; un tocco mostra invece l’età. L’anello a sinistra le spunta.',
            'Una pendenza raccoglie **Messaggi**: toccare la riga ne scrive uno – con tutto ciò che una voce sa fare, quindi anche come nota vocale o foto. Tutti i messaggi stanno sotto la loro pendenza, e nel diario ognuno porta l’inizio della pendenza come rimando; un tocco salta a essa.',
            'Una pendenza di per sé **non ha scadenza** – sul luogo del sinistro nessuno si rifà vivo all’ora esatta. Chi ne vuole una tocca l’**orologio** accanto all’anello: **tra 5/10/15/30/60 min** o **Ora …** con giorno e ora – nella stessa scelta dell’ora che ovunque (rulli, o digitare l’ora), oggi o in uno dei prossimi giorni; un momento già passato non si può applicare. Un promemoria non è quindi più un tipo di riga a sé, ma una voce che in più si fa sentire da sola – con tipo, foto e nota vocale come ogni altra. Nell’elenco la scadenza sta come ora accanto alla riga.',
            'Sul rapporto compaiono come **«Ordini / pendenze»** con Cosa, Chi, Impartito ed Evaso; quelle ancora aperte compaiono come **aperto**. La sezione si può deselezionare in **Altre opzioni di stampa** (il **▾** accanto al PDF). Sulla **lavagna** lo stesso elenco è la pagina «Ordini / pendenze» – spuntato da una parte è spuntato anche dall’altra.',
          ] },
          { kind: 'note', text: '**Chi** non viene chiesto: lo nomina la frase. «Werkhof Oberwil fornisce materiale di sbarramento» basta – il nome evidenziato finisce come Chi sul rapporto.' },
        ],
      },
      {
        id: 'rapport', title: 'Rapporto e chiusura', icon: 'doc',
        blocks: [
          { kind: 'lead', text: 'Il **Rapporto d’intervento** è un’area propria nella barra delle aree, dopo Materiale – un foglio di rilevamento precompilato, non un modulo da zero. Si completa lungo tutto l’intervento, non solo alla fine.' },
          { kind: 'list', items: [
            'Su schermi larghi due colonne: a sinistra il **modulo** da compilare (allarme, rapporto breve, orari, osservazioni, rapporto alla centrale), a destra il **confronto** da spuntare (presenze, materiale, organizzazioni partner, foto).',
            'Sotto il titolo sta ciò che è stato rilevato – e un chip **Controlli** che conta ciò che è **ancora aperto** («4 aperti · 1 avviso»): orari, presenze, materiale, capo intervento, rapporto breve, rapporto alla centrale. Un tocco apre l’elenco. Nulla di tutto ciò blocca mai la stampa.',
            'Il **Ritaglio dello schizzo** sta come campo accanto al modulo: spostare, ingrandire, **Verticale/Orizzontale** e lo stato del kroki (**Kroki al**) – quale momento mostra l’immagine, con tacche dove è successo qualcosa. Si stampa esattamente ciò che è a schermo; non c’è un passaggio di conferma.',
            '**Rapporto d’intervento (PDF)** genera il rapporto finito – reso lato server, un solo pulsante. Il **▾** accanto, **Altre opzioni di stampa**, sceglie le sezioni – cosa finisce sulla carta (schizzo, piani, edificio, autoprotezione, presenze, materiale, diario d’intervento, ordini / pendenze, foto …) – e scarica gli allegati come ZIP. Il menu resta aperto mentre si spunta.',
            'Dove un corpo gestisce una **stampante di caserma**: **Stampa** mette il rapporto in coda lì. In coda non è stampato – finché il lavoro è in sospeso compare **Stampa in sospeso** sotto la testata del rapporto, con **Verifica** e **Annulla**. Il rapporto vale come creato solo quando la stampante annuncia «stampato».',
            'Se il corpo ha depositato moduli propri (Amministrazione › Rapporto), alla fine, sotto il ritaglio dello schizzo, compare **Moduli e link** – un elenco da spuntare. **Apri** richiama il modulo con parola chiave, luogo, data e capo intervento già compilati, per quanto il link lo preveda. La spunta si mette a mano: l’app non vede se un modulo è stato inviato.',
            'Se qualcosa non torna nel record – una catena di verifica interrotta, una nota vocale senza trascrizione, una foto ancora in coda – i **Controlli** lo contano come **avviso**; se tutto è in ordine, il chip non compare affatto.',
            'Persona di contatto e rapporto alla centrale hanno a fine riga un **Non applicabile** – per il falso allarme o la perdita d’olio dove non esistono. È una risposta, non un salto: viene registrata e appare così nel rapporto.',
            '**Chiudi intervento** chiude l’intervento e fissa la fine dell’intervento – nella testata del rapporto, appena c’è un PDF o una stampa, altrimenti nel menu (il dialogo nomina allora il rapporto mancante come punto aperto). Dopo, il rapporto si può solo leggere e firmare. Le foto e le note vocali non ancora sincronizzate vengono sincronizzate prima; se non è possibile (offline) **restano salvate su questo dispositivo** e vengono sincronizzate alla prossima apertura – la conferma dice quante.',
            '**Firme** (facoltative): capo intervento e comandante firmano con il dito – nell’intervento in corso come in quello chiuso. Se dopo cambia qualcosa nella parte firmata, la firma compare come **non valida**; un tocco firma di nuovo.',
            '**Condividi** (in fondo al rapporto, e nel menu sotto **Condividi l’intervento**): un link a questo solo intervento, in sola lettura – di più in «Condividere e presentare».',
          ] },
          { kind: 'note', text: 'Un intervento chiuso si può **riaprire** – le aggiunte successive compaiono nel diario e nel rapporto come **aggiunte**, e nulla va perso.' },
        ],
      },
      {
        id: 'links', title: 'Condividere e presentare', icon: 'link',
        blocks: [
          { kind: 'lead', text: '**Condividi l’intervento** (nel menu dell’intervento aperto, e nel rapporto) dà un link come codice QR e come indirizzo. **Revoca link** lo rende subito non valido.' },
          { kind: 'list', items: [
            '**Intervento · leggere** – mappa, piani, diario, foto, orari. Nessun login, nulla è modificabile. Per la centrale, il CI e i corpi vicini durante l’intervento, per il comune e i corpi vicini dopo: resta valido oltre la chiusura.',
            '**Squadre · operare** – solo le squadre di questo intervento, da portare su un proprio dispositivo (nelle squadre: **Condividi squadre**). Ciò che vi si registra finisce nel rapporto. Vale fino alla chiusura.',
            'Collaborare invece di guardare soltanto? **Accedere** sull’altro dispositivo – un link non rende nessuno editore. Nel menu di un dispositivo con link c’è per questo **Accedi**.',
          ] },
          { kind: 'sub', text: 'Presentare' },
          { kind: 'list', items: [
            '**Presentare** – nel menu, sulla scheda dell’intervento aperto, accanto a **Condividi**, o in **Condividi l’intervento** – › **Avvia**: chi ha aperto l’intervento o il link di lettura può **Seguire** – il suo schermo mostra ciò che mostra il tuo, su ogni superficie.',
            '**Indica** trasforma un tocco in un punto e un tratto in una linea, che poi svaniscono – visibili a tutti, nulla viene salvato.',
            '**Termina** smette; **Non seguire più** libera di nuovo il proprio schermo. Se una presentazione è già in corso, si può **subentrare**. Presentare richiede la rete.',
          ] },
        ],
      },
      {
        id: 'erfassung', title: 'Rilevamento tramite QR', icon: 'cam',
        blocks: [
          { kind: 'lead', text: 'Dove un corpo ha attivato il rilevamento (Amministrazione › «Link e accessi»), un **poster QR** in rimessa apre la vista di rilevamento – senza login, per tutti quelli senza accesso a un tablet.' },
          { kind: 'list', items: [
            'Si sceglie un intervento in corso o uno il cui rapporto è ancora aperto; dal proprio telefono si rilevano **presenze**, **materiale**, orari, dati, organizzazioni partner e foto.',
            'Un nome avanza toccandolo: **non presente → rimessa → sul posto → partito**. La **ⓘ** accanto alla ricerca lo ripete, compreso il significato dell’ora accanto (da = arrivo, a = partenza).',
            'I dati confluiscono nello **stesso intervento** del tablet del posto comando e vengono uniti (con un avviso da controllare in caso di scostamento).',
            'Come ripiego c’è il **foglio di registrazione vuoto (PDF)** da stampare e completare a mano.',
          ] },
        ],
      },
      {
        id: 'sync', title: 'Multi-dispositivo e offline', icon: 'check',
        blocks: [
          { kind: 'lead', text: 'Tutti i dispositivi vedono lo stesso intervento in tempo reale.' },
          { kind: 'list', items: [
            'Le modifiche vengono sincronizzate automaticamente; l’indicatore in alto mostra lo stato.',
            'La modifica simultanea viene unita per oggetto (vince la modifica più recente).',
            '**Sola lettura**: gli osservatori vedono la mappa in tempo reale, senza gli strumenti tattici.',
          ] },
          { kind: 'sub', text: 'Offline' },
          { kind: 'list', items: [
            '**Preparazione offline**: l’app installata scarica da sé carta, piani, simboli e livelli di riferimento poco dopo l’apertura di un intervento – senza dialoghi, senza notifiche. Vengono presi **tutti** i livelli cartografici configurati, anche quello ora nascosto: l’esperienza dice che lo si attiva quando la rete è già andata. Il pulsante **Carica tutto per l’offline** fa lo stesso in qualsiasi momento, a mano.',
            'Quanto viene caricato dipende dal **Raggio offline** della stazione (nell’amministrazione, uguale per tutti i dispositivi).',
            'Che cosa sia davvero pronto lo dice **Impostazioni › Questo dispositivo** nel menu – riga per riga: carta, piani, simboli, merci pericolose, livelli di riferimento, personale, memoria del dispositivo. **Meteo** e **Ricerca oggetti** richiedono la rete e vi figurano come «solo con rete».',
            'Affidabile offline è solo l’**app installata**. In una scheda del browser la memoria può essere svuotata in qualsiasi momento, e la scheda dovrebbe essere ancora aperta al prossimo intervento.',
            'Senza rete continua a funzionare tutto ciò che sta sul dispositivo: disegnare e posare simboli, autoprotezione, presenze, materiale, diario e rapporto. Foto e note vocali restano salvate e partono più tardi.',
            'Appena la rete torna, le modifiche escono da sé e vengono unite con gli altri dispositivi – per oggetto, vince la modifica più recente. Finché qualcosa è in attesa, lo dice l’indicatore in alto.',
          ] },
        ],
      },
      {
        id: 'bedienung', title: 'Uso e giorno/notte', icon: 'move',
        blocks: [
          { kind: 'sub', text: 'Tocca e trascina (touch/iPad)' },
          { kind: 'list', items: [
            'Un dito sposta la carta/il piano; due dita zoomano (pinch).',
            'Quando l’app torna dallo sfondo, nessuno strumento è più in mano – un disegno iniziato chiede come sempre se deve restare.',
            'Anche con un dito solo: **doppio tocco** ingrandisce; **toccare, premere di nuovo e trascinare** zooma in modo continuo – verso il basso ingrandisce, verso l’alto riduce. Uguale su carta e piano, con la **Selezione**. Uno strumento ha la precedenza: dove tocca (punti, misura, aggiungi, nota, cerchio …) ogni tocco è suo; dove traccia (mano libera, multiplo) il doppio tocco zooma ancora. Due dita zoomano sempre. Una linea o una superficie fatta punto per punto si conclude con ✓, mai con un doppio tocco.',
            'Toccando di nuovo **Selezione** il pulsante passa a **Multiplo**: un riquadro trascinato seleziona più oggetti. Prima toccare un oggetto, poi trascinare – un dito su un oggetto non selezionato sposta la carta. Linee, superfici e cerchi si spostano con **✥**. Un singolo oggetto selezionato si copia con **Duplica** nella barra della selezione.',
            '**Tenere premuto** un punto di misura, di linea o di superficie finché l’anello è chiuso lo rimuove; il **+** a metà di un tratto ne aggiunge uno.',
          ] },
          { kind: 'sub', text: 'Mouse', only: 'keyboard' },
          { kind: 'list', only: 'keyboard', items: [
            'Lo scorrimento zooma; il **clic destro** su un punto di misura, di linea o di superficie lo rimuove.',
          ] },
          { kind: 'sub', text: 'Tasti', only: 'keyboard' },
          { kind: 'list', only: 'keyboard', items: [
            '[[Esc]] torna indietro di un livello – strumento, pannello aperto, selezione (l’ordine completo in **Scorciatoie da tastiera**).',
            '[[Canc]] / [[Backspace]] elimina la selezione (non mentre si scrive in un campo).',
          ] },
          { kind: 'sub', text: 'Barre con etichette' },
          { kind: 'list', items: [
            'Nelle **Impostazioni** ([[⌘]] [[,]]) sotto «Etichette delle barre»: **Attivo** scrive sotto ogni simbolo la sua parola – nella barra sinistra e destra, nella barra dello strumento scelto (per la linea «Mano libera» · «Punti» · «Annulla») e nella barra di visualizzazione in basso a destra, nell’intervento come su «Mappa & oggetti». **Nessuna** lascia ovunque solo i simboli. Per chi non conosce ancora i simboli a memoria – le barre diventano un po’ più larghe, e nell’intervento «Espandi» non serve più. Sul **Telefono** è su **Attivo** fin dall’inizio.',
            'Se è spenta, resta il simbolo; un tocco su **Espandi** mostra i nomi finché la barra resta aperta.',
            'Ovunque altrove vale: **tenere premuto** un pulsante che porta solo un simbolo – dopo un breve istante la sua parola compare come fumetto sopra di esso, su touch con una breve vibrazione. Rilasciando il pulsante **non** si attiva: chiedere che cosa sia una cosa non deve anche farla. Con il mouse basta passarci sopra.',
          ] },
          { kind: 'sub', text: 'Giorno / notte' },
          { kind: 'list', items: [
            'Nelle **Impostazioni** ([[⌘]] [[,]]) sotto «Schema colori»: Automatico (segue la luce del giorno), Dispositivo (segue il chiaro/scuro del tablet o del telefono), Giorno o Notte. La modalità notte attenua carta e interfaccia per il buio.',
          ] },
        ],
      },
      {
        id: 'verwaltung', title: 'Amministrazione e dati della stazione', icon: 'gear',
        blocks: [
          { kind: 'lead', text: 'Tutto ciò che vale per l’intero corpo – personale, gradi, veicoli, materiale, livelli cartografici, piani degli oggetti, checklist – si gestisce in **Amministrazione**, non durante un intervento. L’accesso è una **Chiave admin** propria, non il PIN d’intervento.' },
          { kind: 'sub', text: 'La cartella di lavoro (Excel)' },
          { kind: 'list', items: [
            'In **Dati › Cartella di lavoro** gli elenchi del corpo stanno in un unico file Excel: scaricarlo, modificarlo in Excel, Numbers o LibreOffice, ricaricarlo. Otto fogli – Mannschaft, Dienstgrade, Fahrzeuge, Mittel, Mittel-Bestände, Quellen, Partnerorganisationen, Symbolfelder (i fogli si chiamano come nel file, in tedesco).',
            'Prima di scrivere arriva sempre un’**Anteprima**: foglio per foglio, che cosa sarebbe nuovo, che cosa cambia, che cosa scompare – e ogni riga rifiutata con foglio e numero di riga. Fino alla conferma non viene scritto nulla, e annullare non scrive nulla.',
            'Ricaricare lo stesso file non cambia proprio nulla. Il download è quindi anche il modello – e si può prendere senza rischi solo per guardarlo.',
          ] },
          { kind: 'note', text: '**Un foglio assente non è un foglio vuoto.** Togliere un intero foglio dal file lascia quell’elenco invariato. Cancellarne solo le righe lasciando la riga di intestazione lo svuota – ed è esattamente così che si svuota un elenco di proposito.' },
          { kind: 'note', text: '**«Manca» significa due cose.** Una persona che manca nel foglio «Mannschaft» viene **disattivata**, mai cancellata – gli interventi chiusi risolvono il suo nome tramite quella riga. Un identificativo che manca in uno degli altri elenchi viene **rimosso**. L’anteprima nomina entrambi con esattamente queste parole, invece di limitarsi a contarli.' },
          { kind: 'sub', text: 'Se qualcosa va storto lo stesso' },
          { kind: 'list', items: [
            'Ogni modifica agli **elenchi** conserva lo stato precedente: **Backup › Ultime modifiche** li mostra con l’orario e ne ripristina uno – che abbia scritto un modulo, la cartella di lavoro o il terminale.',
            '**Il personale non è lì dentro.** Le persone non sono configurazione, ma record propri – un import che tocca solo il foglio Mannschaft non compare affatto sotto «Ultime modifiche». In compenso lì non viene mai cancellato nessuno, solo disattivato: annullare significa riattivare. Per ripristinare l’elenco intero si usa il file scaricato prima dell’import.',
            'La cartella di lavoro **non è un backup**: copre solo gli elenchi. Il backup è l’export JSON sotto **Backup**.',
          ] },
        ],
      },
    ],

    search: 'Cerca nella guida …',
    searchHint: 'Prova un\'altra parola chiave – la ricerca copre titoli e testo.',
  },
}
