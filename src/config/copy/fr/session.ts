// French copy · demo, login, boot, errors, updates, install, session.
// One slice of the `fr` overlay, assembled in ../fr.ts; the German base is ../de/session.ts.

import type { Copy, Localizable } from '../index'

type Keys =
  | 'demo' | 'login' | 'splash' | 'errorBoundary' | 'surfaceError' | 'symbols' | 'update'
  | 'install' | 'meldeleiste' | 'session' | 'tabLock'

export const sessionCopy: Localizable<Pick<Copy, Keys>> = {
  login: {
    subtitle: 'Aide à la conduite',
    pinEnter: 'Saisir le NIP',
    connectionFailed: 'Liste des comptes non chargée – réessayer',
    loadingRoster: 'Chargement de l’effectif…',
    noUsers: 'Aucun compte enregistré',
    whoAreYou: 'Qui es-tu ?',
    unsentTitle: 'Modifications non transmises de {name}',
    unsentFormer: 'un ancien compte',
    unsentLogin: 'Se connecter en tant que {name}',
    unsentMore: 'et {n} autres',
    unsentBody: 'Elles ne se trouvent que sur cet appareil et ne sont transmises que lorsque ce compte se connecte ici.',
    loginFailed: 'Non connecté – saisir à nouveau le PIN',
    pleaseWait: 'Un instant, s’il te plaît…',
    clearDigit: 'Retirer le dernier chiffre',
    submitPin: 'Se connecter',
    retry: 'Réessayer',
    offlineHint: 'Sans réseau, aucune connexion au compte n’est possible. Les interventions enregistrées ne s’ouvrent que si cet appareil était encore connecté.',
    microsoft: 'Se connecter avec Microsoft',
    microsoftErrors: {
      cancelled: 'Connexion Microsoft annulée.',
      expired: 'La connexion Microsoft a pris trop de temps. Réessayer.',
      failed: 'La connexion Microsoft a échoué. Réessayer ou se connecter avec le NIP.',
      unknown: 'Ce compte Microsoft n’est pas autorisé pour KP Front. Connectez-vous avec le NIP ou demandez à l’admin.',
      inactive: 'Le compte associé est désactivé. Veuillez demander à l’admin.',
    },
  },
  splash: {
    stuck: 'Le démarrage prend plus de temps que d’habitude',
    stuckHint: 'Le chargement prend plus de temps. Les interventions enregistrées sont disponibles hors ligne.',
    reload: 'Redémarrer',
  },
  errorBoundary: {
    title: 'Une erreur est survenue',
    body: 'La vue n’a pas pu être chargée. Les modifications déjà enregistrées sont conservées.',
    bodyRepeat: 'Cette intervention ne s’ouvre pas – même après un rechargement. « Vers la liste des interventions » permet de continuer ; les données déjà transmises sont conservées.',
    reload: 'Recharger',
    closeIncident: 'Vers la liste des interventions',
    discardLocal: 'Supprimer la copie sur cet appareil',
    discardLocalHint: 'Supprime uniquement la copie sur cet appareil et recharge l’intervention. Les modifications de cet appareil non encore transmises seront perdues.',
    discardLocalOffline: 'Impossible sans réseau – l’intervention ne pourrait plus être rechargée ensuite.',
    discardLocalOfflineUnsynced: 'Des modifications de cet appareil n’ont pas encore été transmises.',
    bodyRepeatRoot: 'L’app ne démarre pas – même après un rechargement. Réinitialise l’app ; les interventions et modifications enregistrées sont conservées.',
    resetShell: 'Réinitialiser l’app',
    resetShellHint: 'Vide uniquement la liste des interventions et les données de connexion sur cet appareil. Les interventions et leurs modifications restent enregistrées.',
  },
  surfaceError: {
    title: 'Cette vue n’a pas pu être chargée',
    body: 'Le reste de l’intervention continue – les binômes restent sous surveillance. Les modifications déjà enregistrées sont conservées.',
    retry: 'Reconstruire la vue',
    toMap: 'Vers la carte',
    repeatHint: 'Cette vue plante à répétition – merci de le signaler dans le retour.',
  },
  symbols: {
    loadFailedTitle: 'La bibliothèque de symboles n’a pas pu être chargée',
    loadFailedSub: 'La carte et le croquis continuent sans graphismes de symboles',
    retry: 'Réessayer',
    dismiss: 'Masquer',
  },
  meldeleiste: {
    region: 'Messages',
    more: '+{n} autre message',
    moreMany: '+{n} autres messages',
    less: 'Afficher moins',
  },
  session: {
    expiredTitle: 'Connexion expirée',
    expiredHint: 'Les modifications restent sur cet appareil et seront transmises après la connexion',
    expiredHintNamed: 'Les modifications restent sur cet appareil et seront transmises après la connexion de {name}',
    relogin: 'Se reconnecter',
    foreignUnsentTitle: 'Modifications non transmises de {name} sur cet appareil',
    foreignUnsentSub: '{name} doit se connecter ici',
    foreignUnsentFormerSub: 'Elles restent enregistrées sur cet appareil',
    foreignUnsentDismiss: 'Masquer',
  },
  tabLock: {
    title: 'Ouvert dans un autre onglet',
    hint: 'Cet onglet est en lecture seule – l’édition est active dans l’autre onglet.',
    takeOver: 'Éditer ici',
  },
  update: {
    available: 'Nouvelle version prête',
    hint: 'Active au prochain démarrage – fermer complètement l’app et la rouvrir.',
    hintApply: 'Une pression suffit – l’app se recharge brièvement.',
    apply: 'Mettre à jour',
    applying: 'Mise à jour …',
    dismiss: 'Masquer',
    updated: 'Mise à jour effectuée – {v}',
  },
  install: {
    menu: 'Installer comme app',
    bannerTitle: 'Installer KP Front comme app',
    bannerHint: 'Hors ligne, plein écran, icône propre.',
    bannerAction: 'Guide',
    dismiss: 'Masquer',
    title: 'Installer comme app',
    why: 'Installé, KP Front fonctionne comme une app : disponible hors ligne sur place, en plein écran sans barre du navigateur, avec sa propre icône sur l’écran d’accueil.',
    nativeButton: 'Installer maintenant',
    nativeHint: 'Le navigateur demandera une confirmation – valider avec « Installer ».',
    manualIntro: 'Ou manuellement :',
    installed: 'Installé – lancer désormais KP Front depuis l’icône de l’app.',
    alreadyStandalone: 'KP Front fonctionne déjà comme app installée.',
    ios: {
      intro: 'Sur iPad/iPhone :',
      steps: [
        'Toucher le symbole de partage {share} dans la barre d’outils',
        'Choisir « Sur l’écran d’accueil »',
        'Confirmer avec « Ajouter »',
      ],
      note: 'Si « Sur l’écran d’accueil » manque : ouvrir la page dans Safari.',
    },
    android: {
      intro: 'Dans Chrome sur Android :',
      steps: [
        'Toucher le menu ⋮ en haut à droite',
        'Choisir « Installer l’application »',
        'Confirmer',
      ],
      note: 'Dans d’autres navigateurs : menu → « Ajouter à l’écran d’accueil ».',
    },
    desktop: {
      intro: 'Dans Chrome ou Edge :',
      steps: [
        'Ouvrir le menu du navigateur ⋮ en haut à droite',
        'Choisir « Installer KP Front » et confirmer',
      ],
      note: 'Selon la version, l’entrée est directe ou sous « Enregistrer et partager ». Si une icône d’installation apparaît à droite de la barre d’adresse, elle fonctionne aussi. Si rien n’apparaît, KP Front est déjà installé sur cet appareil.',
    },
    macSafari: {
      intro: 'Dans Safari sur Mac :',
      steps: [
        'Ouvrir le menu « Fichier »',
        'Choisir « Ajouter au Dock »',
        'Confirmer avec « Ajouter »',
      ],
      note: '',
    },
    unsupported: 'Ce navigateur ne permet pas l’installation. Ouvrir de préférence la page dans Chrome, Edge ou Safari et installer là.',
  },
  demo: {
    ribbon: 'DÉMO',
    ariaLabel: 'Instance de démonstration avec des données fictives',
    actionBlocked: 'Impossible dans la démo.',
    welcome: {
      title: 'Bienvenue sur PC Front',
      intro: 'Une intervention préparée avec des données fictives. Dessine, conduis les équipes et teste librement la conduite de l’intervention.',
      reloadWarn: 'Tous les visiteurs travaillent ensemble. La démo est réinitialisée à minuit et à midi.',
      canTitle: 'Ce que tu peux essayer',
      can: ['Modifier la carte et le plan', 'Conduire les équipes ARI et le matériel', 'Ouvrir les plans d’objet et le rapport'],
      cta: 'C\'est parti',
      meta: 'Aucune donnée réelle – la création d’interventions est bloquée',
    },
  },
}
