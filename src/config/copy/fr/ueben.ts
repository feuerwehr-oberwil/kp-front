// French copy · «Üben», the drills on the private practice Einsatz.
// One slice of the `fr` overlay, assembled in ../fr.ts; the German base is ../de/ueben.ts.

import type { Copy, Localizable } from '../index'

export const uebenCopy: Localizable<Pick<Copy, 'ueben'>> = {
  ueben: {
    menu: 'S’exercer',
    sheetLead: 'Sur un terrain d’exercice sur cet appareil uniquement. Rien ne va à l’intervention.',
    next: 'À suivre',
    nextGo: 'Commencer',
    allDrills: 'Tous les exercices',
    doneCount: '{n} sur {total} réussis',
    soon: 'bientôt',
    doneMark: 'Réussi',
    kicker: '{module} · {i} / {n}',
    show: 'Montrer',
    showMore: 'Montrer plus',
    solve: 'Solution',
    hideHint: 'Masquer',
    more: 'Plus',
    restart: 'Recommencer',
    leave: 'Quitter l’exercice',
    doneTitle: 'Réussi',
    doneSolved: 'Fait avec la solution – pour s’exercer, recommencez simplement.',
    doneNext: 'Exercice suivant',
    doneAgain: 'Encore',
    doneList: 'Tous les exercices',
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
    modules: {
      karteWasser: 'Carte & eau',
      atemschutzGebaeude: 'ARI & bâtiment',
      protokollAbschluss: 'Journal & clôture',
    },
    introGo: 'C’est parti',
    drills: {
      fahrzeugLeitung: {
        title: 'Véhicule avec conduite',
        intro: 'Sur la carte, une conduite avec flèche montre d’où vient l’eau et où elle va. Vous placez un TLF à côté d’une hydrante et tirez la conduite du TLF jusqu’à l’entrée.',
        task: 'Placez le TLF à côté de l’hydrante H1 et tirez une conduite avec flèche du TLF jusqu’à l’entrée.',
        goals: {
          tlf: 'TLF à côté de l’hydrante H1',
          leitung: 'Conduite avec flèche du TLF à l’entrée',
        },
        tlfFar: 'Le TLF est à {m} m de H1 – trop loin pour le tuyau vers l’hydrante',
        tlfOnTop: 'Le TLF est sur l’hydrante – placez-le à côté',
        vehicleFar: 'Le véhicule est à {m} m de H1 – et ne s’appelle pas encore «TLF»',
        startFar: 'La conduite commence à {m} m du TLF',
        endFar: 'La conduite s’arrête à {m} m de l’entrée',
        noArrow: 'La flèche manque – elle montre où l’eau s’écoule',
        arrowBack: 'La flèche pointe vers le TLF – l’eau s’écoule vers l’entrée',
        hint: {
          karte: 'Vers la carte',
          addPhone: 'Ajouter › Véhicule, puis touchez à côté de H1',
          addTablet: 'Symbole › Véhicule, puis touchez à côté de H1',
          pick: 'Choisir Véhicule',
          tapBeside: 'Touchez à côté de H1',
          tapVehicle: 'Touchez le véhicule',
          name: 'Désignation : TLF',
          drag: 'Glissez le TLF à côté de H1',
          linePhone: 'Ajouter › Ligne, puis glissez du TLF à l’entrée',
          lineTablet: 'Ligne, puis glissez du TLF à l’entrée',
          linePick: 'Choisir Ligne',
          lineDraw: 'Partez du TLF, glissez jusqu’à l’entrée',
          lineFix: 'Tirez une nouvelle ligne du TLF à l’entrée',
          lineTap: 'Touchez la conduite',
          arrow: 'Fin de ligne : flèche',
          reverse: 'Inverser le sens',
        },
      },
      absperrkreis: {
        title: 'Cercle de bouclage',
      },
      messen: {
        title: 'Mesurer',
      },
      leitungRechnen: {
        title: 'Calculer une conduite',
      },
      pumpenVerschieben: {
        title: 'Déplacer les pompes',
      },
      truppAnmelden: {
        title: 'Annoncer une équipe',
      },
      funkkontakt: {
        title: 'Contact radio & pression',
      },
      rueckzug: {
        title: 'Retrait',
      },
      notfall: {
        title: 'Urgence ARI',
      },
      truppGeschoss: {
        title: 'Équipe dans un étage',
      },
      gefahrUg: {
        title: 'Danger au sous-sol',
      },
      eintrag: {
        title: 'Entrée au journal',
      },
      pendenz: {
        title: 'Point en suspens',
      },
      checkliste: {
        title: 'Check-list',
      },
      anwesenheit: {
        title: 'Présences',
      },
      material: {
        title: 'Matériel',
      },
      fehlalarm: {
        title: 'Clore une fausse alarme',
      },
    },
  },
}
