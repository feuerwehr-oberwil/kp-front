// French copy · «Üben», the topics and their steps on the private practice Einsatz.
// One slice of the `fr` overlay, assembled in ../fr.ts; the German base is ../de/ueben.ts.

import type { Copy, Localizable } from '../index'

export const uebenCopy: Localizable<Pick<Copy, 'ueben'>> = {
  ueben: {
    menu: 'S’exercer',
    sheetLead: 'Sur un terrain d’exercice sur cet appareil uniquement. Rien ne va à l’intervention.',
    next: 'À suivre',
    nextGo: 'Commencer',
    allDrills: 'Tous les exercices',
    stepCount: '{n} / {total}',
    steps: '{total} étapes courtes',
    nextStep: 'Continuer avec «{step}»',
    doneMark: 'Réussi',
    free: 'Exercice libre',
    freeSub: 'Terrain d’exercice sans tâche – tout essayer',
    tryOut: 'Essayer sur le terrain d’exercice',
    kicker: '{topic} · {i} / {n}',
    show: 'Montrer',
    showMore: 'Montrer plus',
    solve: 'Solution',
    hideHint: 'Masquer',
    closeFirst: 'Fermer d’abord',
    more: 'Plus',
    restart: 'Recommencer',
    leave: 'Quitter l’exercice',
    doneSolved: 'Fait avec la solution – pour s’exercer, recommencez simplement.',
    doneNext: 'Continuer',
    doneAgain: 'Encore',
    doneList: 'Tous les exercices',
    endTitle: '{topic} : réussi',
    moreTitle: 'Ce qu’il y a encore',
    idleTitle: 'Terrain d’exercice',
    idleText: 'Sur cet appareil uniquement – aucun autre appareil ni aucune liste d’interventions ne le voit.',
    idlePick: 'Choisir un exercice',
    restartTitle: 'Recommencer le terrain d’exercice ?',
    restartMessage: 'La carte, le journal, les équipes et le rapport du terrain d’exercice sont supprimés. Les vraies interventions ne sont pas touchées.',
    restartConfirm: 'Recommencer',
    localOnly: 'Sur cet appareil uniquement',
    siteMissing: '{name} manque sur la carte – «Recommencer» rétablit le terrain d’exercice',
    site: {
      hydrant: 'H1',
      eingang: 'Entrée',
    },
    introGo: 'C’est parti',
    topics: {
      karte: {
        title: 'Carte et dessin',
        intro: 'Un véhicule, ses conduites et leurs connexions : dessiner sur la carte en six étapes courtes. Chaque étape s’appuie sur la précédente.',
        more: [
          'Fin de ligne : flèche avec arrêt (limite de propagation) et tronçon (la conduite se divise)',
          'Type de ligne : pointillée, ligne d’arrêt, zone de largage – avec couleur, épaisseur et texte',
          'Sur la conduite : personne, équipe, étage et contenu',
          'Sur le symbole : nom, rotation, nombre et étage',
          'Autres outils : surface, périmètre de sécurité, note, mesure et sélection multiple',
          'Verrouiller : plus rien ne bouge par erreur',
        ],
        hint: {
          karte: 'Vers la carte',
          linePhone: 'Ajouter › Ligne',
          lineTablet: 'Ligne',
          linePick: 'Choisir Ligne',
          lineTap: 'Touchez la conduite',
        },
        steps: {
          fahrzeug: {
            title: 'Placer un véhicule',
            task: 'Placez un véhicule près de l’hydrante H1.',
            goals: {
              fahrzeug: 'Véhicule près de l’hydrante H1',
            },
            learned: 'Chaque symbole se place ainsi : choisir le symbole, toucher la carte. Glisser le déplace.',
            far: 'Le véhicule est à {m} m de H1 – glissez-le plus près de l’hydrante',
            hint: {
              addPhone: 'Ajouter › Véhicule, puis touchez à côté de H1',
              addTablet: 'Symbole › Véhicule, puis touchez à côté de H1',
              pick: 'Choisir Véhicule',
              tapBeside: 'Touchez à côté de H1',
              drag: 'Glissez le véhicule vers H1',
            },
          },
          leitung: {
            title: 'Conduite avec flèche',
            task: 'Tirez une conduite du véhicule jusqu’à l’entrée et donnez-lui une flèche.',
            goals: {
              leitung: 'Conduite avec flèche du véhicule à l’entrée',
            },
            learned: 'La flèche montre où l’eau s’écoule. «Inverser le sens» la retourne sans redessiner.',
            startFar: 'La conduite commence à {m} m du véhicule',
            endFar: 'La conduite s’arrête à {m} m de l’entrée',
            noArrow: 'La flèche manque – elle montre où l’eau s’écoule',
            arrowBack: 'La flèche pointe vers le véhicule – l’eau s’écoule vers l’entrée',
            hint: {
              draw: 'Partez du véhicule, glissez jusqu’à l’entrée',
              fix: 'Tirez une nouvelle ligne du véhicule à l’entrée',
              arrow: 'Fin de ligne : flèche',
              reverse: 'Inverser le sens',
            },
          },
          verbinden: {
            title: 'Connecter',
            task: 'Tirez une deuxième conduite de l’hydrante H1 au véhicule et restez sur le véhicule jusqu’à ce que l’anneau bleu soit plein. Déplacez ensuite le véhicule.',
            goals: {
              zubringer: 'Conduite connectée à H1 et au véhicule',
              mitziehen: 'Véhicule déplacé – les conduites suivent',
            },
            learned: 'Une conduite connectée suit son véhicule. Partir du symbole connecte tout de suite ; à la fin, il faut l’anneau plein.',
            looseVehicle: 'La conduite n’est pas connectée au véhicule – retirez-la et restez sur le véhicule jusqu’à ce que l’anneau soit plein',
            looseH1: 'La conduite n’est pas connectée à l’hydrante – retirez-la et partez directement de H1',
            hint: {
              draw: 'Partez de H1, glissez vers le véhicule et restez-y jusqu’à ce que l’anneau soit plein',
              close: 'Fermer la conduite',
              move: 'Touchez le véhicule, puis glissez',
            },
          },
          beschriften: {
            title: 'Annoter la conduite',
            task: 'Donnez un numéro et un tuyau à la conduite vers l’entrée.',
            goals: {
              nummer: 'La conduite a un numéro',
              schlauch: 'Tuyau choisi',
            },
            learned: 'Le numéro et le tuyau figurent sur la carte au bout de la conduite. Dans la même fiche : personne, équipe, étage et texte.',
            hint: {
              nummer: 'Conduite n° : +',
              schlauch: 'Choisir le tuyau',
            },
          },
          punkte: {
            title: 'Points',
            task: 'Insérez un point dans la conduite vers l’entrée. Retirez ensuite un point.',
            goals: {
              einfuegen: 'Point inséré',
              entfernen: 'Point retiré',
            },
            learned: 'Les points mènent une conduite autour d’un obstacle : «+» en insère un, glisser le déplace, maintenir le retire.',
            hint: {
              plus: 'Touchez + : un nouveau point',
              hold: 'Maintenez le point jusqu’à ce que l’anneau soit plein',
            },
          },
          loesen: {
            title: 'Libérer et retirer',
            task: 'Libérez une conduite du véhicule. Retirez-la ensuite et ramenez-la avec «Annuler».',
            goals: {
              geloest: 'Connexion libérée',
              geloescht: 'Conduite retirée',
              zurueck: 'Ramenée avec «Annuler»',
            },
            learned: '«Annuler» revient sur chaque étape – sur la carte, pour les équipes et dans la présence.',
            hint: {
              detach: 'Libérer la connexion',
              remove: 'Retirer',
              undo: 'Annuler',
            },
          },
        },
      },
    },
  },
}
