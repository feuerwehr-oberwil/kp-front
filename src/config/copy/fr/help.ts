// French copy · the «Funktionen & Hilfe» overlay.
// One slice of the `fr` overlay, assembled in ../fr.ts; the German base is ../de/help.ts.

import type { Copy, Localizable } from '../index'

export const helpCopy: Localizable<Pick<Copy, 'help'>> = {
  help: {
    menu: 'Fonctions et aide',
    title: 'Que fait PC Front ?',
    contents: 'Sommaire',
    close: 'Fermer',
    introFallback: 'PC Front est la conduite d’intervention numérique de votre corps de sapeurs-pompiers : carte de situation tactique, plans d’objet, surveillance de la protection respiratoire et un journal partagé – le tout en direct sur plusieurs appareils à la fois.',
    sections: [
      {
        id: 'ueberblick', title: 'Aperçu', icon: 'info',
        blocks: [
          { kind: 'intro' },
          { kind: 'sub', text: 'Les espaces de travail (barre de gauche)', only: 'wide' },
          { kind: 'sub', text: 'Les espaces de travail (barre du bas)', only: 'phone' },
          { kind: 'list', items: [
            '**Carte** – la carte tactique avec symboles, lignes, surfaces et les couches des réseaux.',
            '**Plans** – les modules et vues de bâtiment de ce corps comme surfaces de travail tactiques, étage par étage.',
            '**Checklist** – listes de contrôle d’intervention à dérouler.',
            '**Binômes** – surveillance des binômes engagés avec temps et pression, avec ou sans ARI.',
            '**Présence** – qui est engagé, avec heures et remarque ; aussi des invités hors de la liste du personnel.',
            '**Matériel** – ce qui a été engagé, depuis le catalogue ou saisi librement.',
            '**Rapport** – le rapport d’intervention : un formulaire prérempli, complété tout au long de l’intervention et imprimé à la fin.',
          ] },
          { kind: 'note', text: 'Principe directeur : utilisable à 3 h du matin, après six mois sans entraînement. Reconnaître plutôt que retenir, utilisable avec des gants et hors ligne.' },
        ],
      },
      {
        id: 'anmelden', title: 'Connexion et rôles', icon: 'lock',
        blocks: [
          { kind: 'lead', text: 'On se connecte une fois par appareil : **Qui es-tu ?** montre les comptes du corps – toucher le sien, saisir le **NIP**, **Se connecter**.' },
          { kind: 'list', items: [
            'La connexion reste sur l’appareil ; chaque ouverture de l’app la prolonge. **Déconnexion** (dans le menu) demande d’abord confirmation.',
            'Sans réseau, pas de connexion possible – mais un appareil connecté ouvre aussi hors ligne les interventions enregistrées.',
            'NIP oublié, nouveau compte nécessaire ? C’est **l’administration** qui s’en charge – dans l’app elle-même, on ne peut pas changer de NIP.',
            'Là où le corps l’a mis en place, **Se connecter avec Microsoft** fonctionne aussi.',
          ] },
          { kind: 'sub', text: 'Rôles' },
          { kind: 'list', items: [
            '**Éditeur** – tout : carte, plans, binômes, journal, rapport ; ouvrir et partager des interventions.',
            '**Chef d’intervention** – voit tout et écrit présence, matériel, checklists, rapport, données d’intervention et journal ; clôt et rouvre. Carte, plans et binômes restent en lecture.',
            '**Observateur** – lecture seule.',
            'Ce qu’un rôle n’a pas le droit de faire n’apparaît tout simplement pas – pas de bouton grisé. En haut figure alors **Consultation**, et le menu dit pourquoi. Quel compte a quel rôle, l’administration le décide.',
          ] },
        ],
      },
      {
        id: 'karte-objekte', title: 'Carte & objets – sans intervention', icon: 'pin',
        blocks: [
          { kind: 'lead', text: 'Sans intervention ouverte, PC Front arrive ici : la carte du corps avec tous ses objets, pour consulter et préparer. Ce n’est pas une intervention – mesurer, marquer et consulter se fait sur cet appareil seulement, et rien n’en est enregistré.' },
          { kind: 'sub', text: 'Recherche et objets' },
          { kind: 'list', items: [
            'Le champ en haut cherche des **adresses et des objets**. Un résultat ouvre ses informations : dangers, hydrantes à proximité et les **plans d’objet**.',
            'Chaque objet est entouré sur la carte avec ses bâtiments et porte son nom ; le toucher l’ouvre. Toucher un autre bâtiment montre ce que le registre en sait.',
            'Les plans de l’objet choisi se trouvent dans la barre de gauche et s’ouvrent dans le même lecteur de plans qu’en intervention – en lecture seule. Le bouton en bas à gauche ramène à l’objet.',
          ], only: 'wide' },
          { kind: 'list', items: [
            'La recherche en haut à droite trouve des **adresses et des objets**. Un résultat ouvre ses informations : dangers, hydrantes à proximité et les **plans d’objet**.',
            'Chaque objet est entouré sur la carte avec ses bâtiments et porte son nom ; le toucher l’ouvre. Toucher un autre bâtiment montre ce que le registre en sait.',
            'Les plans sont des lignes dans les informations de l’objet et s’ouvrent dans le même lecteur de plans qu’en intervention – en lecture seule. «Retour» en bas ramène à la carte.',
          ], only: 'phone' },
          { kind: 'list', items: [
            '**Visite d’objet** et **Signaler** dans les informations lancent la saisie, là où le corps l’a mise en place.',
          ] },
          { kind: 'sub', text: 'Outils' },
          { kind: 'list', items: [
            '**Poser un point** – un point avec son adresse et ses coordonnées (LV95 + WGS84) à copier. Un appui long sur la carte libre en pose un aussi – sur le téléphone, c’est le seul moyen.',
            '**Mesurer** – distance ou surface.',
            '**Matières dangereuses** – saisir le numéro UN : les indications ADR/ERG et les distances en cercles autour du point choisi.',
            '**Couches** – conduites, hydrantes, radar météo et les données de la station ; un réglage propre, indépendant de toute intervention.',
            '**Checklist** – les checklists et modes d’emploi d’appareils du corps à lire, avec leur propre recherche.',
          ] },
          { kind: 'list', only: 'keyboard', items: [
            'Au clavier : tous les raccourcis de cette vue sous **Raccourcis clavier** › «Carte & objets».',
          ] },
          { kind: 'note', text: 'Quand une intervention est en cours, elle figure dans la barre en haut – en rouge, ou hachurée avec le mot «Exercice» pour un exercice – et un toucher l’ouvre. Une alarme est affichée, mais jamais ouverte d’elle-même.' },
        ],
      },
      {
        id: 'einsatz', title: 'Gérer les interventions', icon: 'swap',
        blocks: [
          { kind: 'lead', text: 'Tout se trouve dans le **Menu** en haut à gauche – en intervention il porte le nom de l’intervention, sur «Carte & objets» l’emblème du corps.' },
          { kind: 'list', items: [
            'Tout en haut, l’intervention ouverte : **Modifier** (les données d’intervention), **Clore** avec le nombre de points encore ouverts, et **Transmettre**.',
            'En dessous, les autres interventions en cours – un toucher change d’intervention. S’il y en a plusieurs, l’intervention en haut affiche un **+N**.',
            '**Nouvelle alarme** – une alarme reçue qui n’est pas encore une intervention : **Ouvrir** l’ouvre. Le **✕** la masque seulement sur cet appareil ; elle reste comme ligne grise «Masqué», et **Montrer** la fait revenir.',
            '**Ouvrir une intervention** – une intervention à la main, sans alarme. La première question est **Réel | Exercice**, ensuite le lieu (objet, adresse ou sur la carte) et le mot-clé. Ce qui est à moitié saisi reste, même si l’app se recharge.',
            '**Toutes les interventions** – aussi les clôturées : un toucher ouvre en lecture, **Rouvrir** pour compléter.',
            '**Quitter l’intervention** – retour à la carte ; l’intervention continue.',
            '**Clore l’intervention** clôt l’intervention en cours – le même dialogue que dans le rapport, avec la même liste de ce qui reste ouvert. Si aucun rapport n’a encore été établi (PDF ou impression), c’est indiqué tout en haut ; clore reste possible.',
          ] },
          { kind: 'sub', text: 'Exercice' },
          { kind: 'list', items: [
            'Un exercice est une intervention comme une autre – tout fonctionne pareil. Il ne compte pas dans la statistique des interventions et figure hachuré avec le mot «Exercice» dans la barre.',
            'Ouvrir : **Ouvrir une intervention** › **Exercice** – le bouton s’appelle alors **Ouvrir l’exercice**. Une intervention en cours devient exercice, ou l’inverse, via **Modifier**.',
            'Dans **Toutes les interventions**, on ne peut supprimer qu’un exercice clôturé qui en était un dès le départ. Là où ce n’est pas possible, il est écrit «Supprimer : seulement dans l’administration».',
          ] },
        ],
      },
      {
        id: 'alarme', title: 'Alarmes sur cet appareil', icon: 'bell',
        blocks: [
          { kind: 'lead', text: 'Une nouvelle alarme réveille chaque appareil connecté avec un compte **Éditeur** et qui autorise les alarmes – comme «Neuer Einsatz», même app fermée.' },
          { kind: 'list', items: [
            'Si cet appareil est prêt, **Réglages › Cet appareil** le dit avec **Alarme prête** : installée comme app, notifications autorisées, abonnement alarme, connexion. Ce qui manque est affiché, avec le bouton correspondant ; **Alarme test** vérifie tout le chemin.',
            'Les comptes **Chef d’intervention** et **Observateur** ne sont pas réveillés par «Neuer Einsatz» – sous «Alarme prête», la ligne **Compte** le dit.',
            'Les alarmes **ARI** (en retard, pression d’alarme, urgence) sonnent sur chaque appareil qui a l’intervention ouverte, avec n’importe quel compte.',
            '**Pas d’alarmes sur cet appareil** les coupe ici ; **Activer** les remet.',
          ] },
        ],
      },
      {
        id: 'navigation', title: 'Navigation et interface', icon: 'cursor',
        blocks: [
          { kind: 'lead', text: 'Trois zones fixes : la barre des espaces à gauche, la barre d’intervention en haut, la barre d’outils à droite.', only: 'wide' },
          { kind: 'lead', text: 'Deux barres en bas, une en haut : tout en bas la barre des espaces, au-dessus la barre d’outils, en haut la barre d’intervention.', only: 'phone' },
          { kind: 'sub', text: 'Barres du bas', only: 'phone' },
          { kind: 'list', only: 'phone', items: [
            'La **barre des espaces** tout en bas a cinq cases : Carte, Plans, Checklist, Binômes et Rapport. **Plans** et **Rapport** regroupent plusieurs pages (Rapport, Présence, Matériel) : toucher la case une seconde fois ou la maintenir ouvre le choix.',
            'Au-dessus, la **barre d’outils** de la carte ou du plan. **+** est l’unique porte vers tout ce qu’on y place.',
            'Un bouton qui ne porte qu’un symbole dit son nom quand on le **maintient appuyé**. Dans les **Réglages**, «Étiquettes des barres» écrit les mots dessous en permanence.',
          ] },
          { kind: 'sub', text: 'Barre de gauche', only: 'wide' },
          { kind: 'list', items: [
            'Au clavier et à la souris, les cases de la barre de gauche et de droite qui ont un raccourci portent leur lettre – de même «Journal» et «Entrée» en haut. Tous les raccourcis sont sous **Raccourcis clavier**.',
            'Tirer le bord droit de la barre la déplie avec les libellés ou la replie.',
          ], only: 'wide' },
          { kind: 'sub', text: 'Barre d’intervention (haut)' },
          { kind: 'list', items: [
            'À gauche, le nom de l’intervention avec le **Menu** (clore l’intervention, les autres interventions en cours, réglages, cette aide …) et l’**horloge d’intervention**.',
            'À droite la **Météo**, **Annuler/Rétablir**, **Journal** et **Entrée**.',
          ], only: 'wide' },
          { kind: 'list', only: 'phone', items: [
            'À gauche, le nom de l’intervention avec le **Menu** (clore l’intervention, les autres interventions en cours, réglages, cette aide …), à droite **Annuler** et le **Journal**.',
            'Le bouton rond en bas à droite est **Entrée**.',
          ] },
          { kind: 'sub', text: 'Bandeau de messages' },
          { kind: 'list', items: [
            'Juste sous la barre d’intervention se trouve **un** bandeau pour tout ce qui est en attente et le reste jusqu’à ce que quelqu’un agisse : un binôme ARI en retard, une nouvelle alarme, un rappel échu, des données d’alarme non vérifiées, une mise à jour prête. Chaque message est une ligne sous la précédente – plus de cartes qui se recouvrent.',
            'L’ordre est fixe, pas chronologique : d’abord l’**ARI**, puis l’**Alarme**, puis le **Rappel**. Ce qui attend quelqu’un passe toujours avant ce qui disparaît de soi-même.',
            'Seuls les boutons libellés agissent, le **✕** et – si le message mène quelque part – son **titre**. Toucher la ligne ailleurs ne fait rien : lire ne doit pas être la même chose qu’agir. Si rien n’est en attente, le bandeau n’existe pas.',
          ] },
          { kind: 'sub', text: 'Barre d’outils (droite)', only: 'wide' },
          { kind: 'list', items: [
            'Les outils de dessin et de placement.',
            'En dessous, dans le coin en bas à droite, la **barre d’affichage** – toujours visible, même quand les outils défilent : sur la carte **Couches** et **Vues** (la boussole), sur le plan **Ajuster** et la flèche du nord ; avec une souris aussi **−** et **+**.',
          ], only: 'wide' },
        ],
      },
      {
        id: 'tastatur', title: 'Raccourcis clavier', icon: 'type', only: 'keyboard',
        blocks: [
          { kind: 'lead', text: 'Au clavier, tout est accessible sans souris. Les raccourcis ne font rien pendant la saisie dans un champ, ni derrière une fenêtre ouverte. Quand une case a une touche, sa lettre y est inscrite – dans les deux barres, dans la barre d’affichage en bas à droite et sur «Journal» et «Entrée» en haut.' },
          { kind: 'sub', text: 'Changer d’espace' },
          { kind: 'list', items: [
            'Les chiffres ouvrent le module de plan portant ce numéro – lesquels existent dépend des modules de ce corps : [[1]] module 1, [[2]] ou [[3]] le module «2/3», [[4]] module 4 …',
            '[[K]] Carte · [[C]] Checklist · [[A]] Binômes (A comme Atemschutz) · [[P]] Présence · [[M]] Matériel · [[R]] Rapport – chaque fois la première lettre du mot ALLEMAND, car c’est à lui que la touche est liée (Présence : P comme Personal).',
            '[[⌘]] [[[]] / [[⌘]] [[]]] parcourt tous les espaces un à un (y compris Environs et Bâtiment, qui n’ont pas de numéro).',
          ] },
          { kind: 'sub', text: 'Outils (identiques sur la carte et le plan)' },
          { kind: 'list', items: [
            '[[V]] Sélection · [[W]] Sélection multiple · [[S]] Symbole · [[L]] Ligne · [[F]] Surface · [[U]] Périmètre · [[N]] Note · [[T]] Équipe · [[D]] Mesurer.',
          ] },
          { kind: 'sub', text: 'Édition' },
          { kind: 'list', items: [
            '[[⌘]] [[Z]] Annuler · [[⌘]] [[⇧]] [[Z]] Rétablir · [[⌘]] [[D]] Dupliquer · [[⌫]] supprime la sélection.',
            '[[Esc]] revient d’un niveau par pression jusqu’à ce que la carte soit libre : Couches / Vues → un symbole en cours de pose, ou le relevé de coordonnées → l’outil → le panneau de note → la sélection – dans le même ordre sur les plans. Un menu, une carte ou une fenêtre par-dessus, [[Esc]] le ferme d’abord, seul. Dans un champ, [[Esc]] ne fait que quitter le champ et garde le texte saisi ; il ferme l’**Entrée** et garde son texte pour la prochaine fois.',
          ] },
          { kind: 'sub', text: 'Affichage et panneaux' },
          { kind: 'list', items: [
            '[[+]] / [[−]] Zoom · [[0]] Ajuster · [[G]] Ma position · [[X]] Relever les coordonnées (marche/arrêt). «Vers le nord» n’a pas de touche – c’est le rôle de la boussole, toujours visible et qui tourne avec la carte.',
            '[[J]] Journal · [[E]] Entrée · [[B]] Couches · [[⌘]] [[,]] Réglages · [[?]] cette aide.',
            'Sur le **tableau**, [[Pg↑]] / [[Pg↓]] feuillettent ses pages.',
          ] },
          { kind: 'sub', text: 'Carte & objets (sans intervention)' },
          { kind: 'list', items: [
            'Les mêmes touches là où la même chose existe : [[K]] Carte · [[C]] Checklist · les chiffres les modules de l’objet choisi · [[D]] Mesurer · [[B]] Couches · [[G]] Ma position · [[0]] Ajuster · [[+]] / [[−]] Zoom · [[⌘]] [[,]] Réglages · [[?]] cette aide.',
            'En plus, ce qui n’existe qu’ici : [[P]] Poser un point (P comme Punkt) · [[U]] Matières dangereuses (U comme numéro UN) · [[/]] ou [[⌘]] [[K]] la recherche.',
            '[[Esc]] revient pas à pas vers la carte : recherche → Vues → outil → plan ouvert → sélection.',
          ] },
        ],
      },
      {
        id: 'lage', title: 'Carte – la carte tactique', icon: 'map',
        blocks: [
          { kind: 'lead', text: 'La carte tactique par-dessus le fond de carte réel (zone d’intervention et environs).' },
          { kind: 'list', items: [
            '**Carte de base** (en haut du panneau des couches) change le fond : Carto, OpenStreetMap ou satellite.',
            '**Vues** – la boussole (en bas à droite, sur le téléphone dans la barre d’outils à côté de Couches) – propose **Vers le nord**, **Ajuster**, **Ma position**, **Relever les coordonnées** et les vues enregistrées ; avec une souris, **−** et **+** se trouvent à côté. Lors du relevé, toucher la carte pour fixer un point (LV95 + WGS84).',
            '**Météo** figure en continu dans la barre d’intervention : température, une flèche dans la direction où va le vent, et sa force – la direction de propagation d’un coup d’œil. Un toucher montre les rafales et la direction en degrés.',
            '**Véhicules** apparaissent en direct par GPS (nom + orientation), votre propre position sous forme de point bleu discret.',
            '**Info bâtiment** en bas à gauche indique les dangers du bâtiment sur le lieu d’intervention (⚠ gaz · PV) – le chiffre à côté compte les mesures immédiates – et ouvre sa fiche : dangers, **Mesures immédiates** et remarques en haut, les données des registres en dessous. À la première ouverture de l’intervention sur cet appareil, la fiche s’ouvre d’elle-même pour être lue – la carte reste utilisable. ✕ la ferme ; ensuite, la puce la rouvre. Un autre lieu ou objet avec du contenu l’affiche une nouvelle fois.',
          ] },
        ],
      },
      {
        id: 'ebenen', title: 'Couches et données', icon: 'layers',
        blocks: [
          { kind: 'lead', text: 'Via **Couches**, vous affichez les données des réseaux et des dangers – classées par type.' },
          { kind: 'list', items: [
            '**Inhalte** – symboles tactiques, véhicules, traces de véhicules, personnes (en direct), croquis et notes. Si l’une d’elles est masquée, le bouton **Couches** porte un point.',
            '**Corps** – constructions souterraines (garages, abris, tunnels) de la mensuration officielle, en tirets dès le zoom rue ; affichées par défaut.',
            'Les couches disponibles dépendent des géodonnées de ce corps – aucune n’est fournie avec l’app. Courantes sont :',
            '**Eaux usées** – eaux sales/mixtes, eaux pluviales/propres, regards / grilles.',
            '**Gaz** – conduites.',
            '**Électricité** – lignes, installations PV.',
            '**Dangers** – crues, profondeur d’inondation.',
          ] },
          { kind: 'lead', text: 'Chaque couche peut être affichée/masquée et son opacité réglée.' },
          { kind: 'list', items: [
            'Le préchargement hors ligne se fait de lui-même – ce qui est prêt, **Réglages › Cet appareil** le dit (voir «Multi-appareils et hors ligne»).',
          ] },
          { kind: 'note', text: 'Les données des réseaux couvrent la zone d’intervention configurée et sont disponibles localement – elles fonctionnent aussi hors ligne.' },
        ],
      },
      {
        id: 'zeichnen', title: 'Dessin et symboles', icon: 'pen',
        blocks: [
          { kind: 'lead', text: 'Les outils de la carte – les mêmes sur le plan.' },
          { kind: 'list', items: [
            '**Symbole** – le symbole tactique (FKS/VKF). Sélection rapide des symboles les plus courants ou recherche dans toute la bibliothèque. Toucher pour placer ; avec «Placer plusieurs», en poser plusieurs à la suite.',
            '**Formes** – dans la même fenêtre, après les dangers : **Flèche**, **Rectangle** et **Rotation** (avec porteur Héli ou TLF), pour tout ce qui n’a pas de symbole tactique. La poignée fait pivoter ; sur le rectangle, des poignées propres tirent largeur et hauteur, sur la flèche l’extrémité fixe longueur et direction. Sur la flèche, **Barre d’arrêt** ajoute la barre en travers de la pointe – la limite de propagation : jusqu’ici, et arrêté là.',
            '**Sélection** – toucher des objets, les déplacer, les ajuster dans l’éditeur.',
            '**Multiple** – toucher **Sélection** une nouvelle fois pendant qu’elle est active : le bouton passe sur Multiple (icône et mot), et tirer un cadre sélectionne plusieurs symboles/dessins à la fois. Un nouveau toucher ramène à Sélection.',
            '**Ligne** – **Main levée** (glisser) ou **Points** (toucher, ✓) se choisit dans la barre de l’outil. Ensuite, dans l’éditeur, la **Ligne** – Continue, Pointillée, ligne d’arrêt ou Zone de largage – et l’**Extrémité** – **Aucune**, **Flèche**, **Flèche avec arrêt** (la même barre en travers de la pointe) ou **Tronçon** ; **Inverser le sens** la place à l’autre bout sans déplacer la ligne.',
            '**Surface** – tirer le contour librement ou toucher les sommets et ✓ (surface affichée dès 3 points). Tirer un sommet le déplace, le **+** au milieu d’un côté en ajoute un, **maintenir appuyé** un point le supprime.',
            '**Périmètre de sécurité** – glisser du centre vers le bord fixe le rayon en mètres (remplissage réglable).',
            '**Note** – texte libre directement sur la carte.',
            '**Équipe** – poser le marqueur d’un binôme : toucher et choisir le binôme.',
            '**Mesurer** – distance (longueur + profil altimétrique) ou surface (aire + périmètre). Tirer les points pour déplacer, le **+** au milieu d’un segment pose un point intermédiaire, **maintenir appuyé** un point le supprime (à la souris : clic droit).',
            '**Point de mesure** – pour les mesures de gaz (CO, Ex, O₂, H₂S) à un endroit, sur la carte ou un étage : chercher «Point de mesure» dans la fenêtre des symboles, le poser, saisir les valeurs. Jaune = A1 (préalarme), rouge = A2 (alarme principale) ; une ancienne valeur porte son âge («18′»). **Mesures gaz** liste tous les points de mesure.',
            '**Transport d’eau** – sous le profil altimétrique d’une distance ou dans une conduite : choisir le Ø du tuyau, le débit, la source (hydrante, étang, pompe) et la pression d’entrée ; le graphique montre la pression le long de la conduite et place les pompes. **Mettre sur la carte comme conduite** garde le calcul ; sur une conduite, l’interrupteur **Pompes sur la carte** les dessine comme symboles.',
          ] },
          { kind: 'sub', text: 'Préréglages des symboles' },
          { kind: 'lead', text: 'Chaque symbole n’apporte que les réglages utiles : **Rotation** pour les symboles orientés (flèches, échelles, parois), **Nombre** quand plusieurs comptent, **Étage** ou une **Plage d’étages** (p. ex. escalier/ascenseur), **Propagation** pour les sinistres – plus les champs de saisie adaptés (p. ex. nom, substance, statut).' },
        ],
      },
      {
        id: 'wassertransport', title: 'Transport d’eau', icon: 'drop',
        blocks: [
          { kind: 'lead', text: 'Calcule une conduite de transport : quelle pression arrive où, et où les pompes doivent se trouver. Une **aide à la planification** – les sources des chiffres sont derrière le **ⓘ** de l’en-tête (AGV, FKS).' },
          { kind: 'sub', text: 'Dessiner la conduite' },
          { kind: 'list', items: [
            'Dessiner une **Ligne** le long de la route, **de la source jusqu’au lieu d’intervention** – l’eau va du premier au dernier point. Toucher la conduite, ouvrir **Dimensions** et toucher **Calculer le transport d’eau**.',
            'Ou d’abord essayer : **Mesurer › Distance**, puis **Calculer le transport d’eau** sous le profil altimétrique. **Mettre sur la carte comme conduite** reprend la distance avec tout le calcul.',
            'Mauvais sens ? **⇄** dans l’en-tête l’inverse, le dessin reste. La lettre au début de la conduite (**H**, **É**, **P**) montre où est la source.',
          ] },
          { kind: 'sub', text: 'Source, eau, pression d’entrée' },
          { kind: 'list', items: [
            '**Ø du tuyau** – 55, 75, 2× 75 ou 110 mm (dans une conduite, la ligne **Tuyau**, là aussi 40 mm) ; la perte de charge vient de la table AGV.',
            '**Eau** – le débit qui doit arriver au bout (l/min). Choisir une proposition ou saisir une autre quantité.',
            '**Source** – hydrante, étang ou pompe. La **Pression d’entrée** est celle avec laquelle la conduite y commence : la pression statique à l’hydrante, la pression de sortie d’une pompe. Un étang n’en a pas – la première pompe se trouve à la source.',
          ] },
          { kind: 'sub', text: 'Lire le diagramme' },
          { kind: 'list', items: [
            'La ligne noire est la **pression** le long de la conduite, le **terrain** en dessous. Les bandes : vert **bon** au-dessus de 3 bar, jaune **juste** 2–3 bar, rouge **trop peu** sous 2 bar.',
            'Les points **P1**, **P2** … sont les pompes – placées automatiquement là où la pression tombe à 2 bar (FKS : une pompe a besoin d’au moins 2 bar de pression d’entrée). Sur la carte, elles portent les mêmes noms.',
            'Survoler le diagramme ou le toucher du doigt montre la pression à cet endroit – le point correspondant apparaît sur la carte.',
            'En dessous, **montée/descente** et **Pression à l’arrivée**. **Tuyaux** indique la réserve à part, p. ex. «34 + 3 de réserve × 20 m».',
          ] },
          { kind: 'sub', text: 'Déplacer les pompes' },
          { kind: 'list', items: [
            'Toucher une pompe montre où elle se trouve, sa **Pression d’entrée** et sa **Pression de sortie** (réglable avec **−**/**+**).',
            '**Glisser** une pompe – latéralement dans le diagramme ou le long de la conduite sur la carte – la fixe à cet endroit («à la main») ; les pompes suivantes sont recalculées. Ensuite apparaît **Toutes les pompes automatiques**, qui remet tout à zéro.',
            '**Pompes sur la carte** dessine les pompes comme motopompes sur la carte et sur le croquis imprimé. Toucher une pompe sur la carte ouvre la conduite avec les **Dimensions** ouvertes.',
          ] },
          { kind: 'sub', text: 'Avertissements' },
          { kind: 'list', items: [
            '**Pompe 1 : pression d’entrée sous 2 bar** – une pompe placée à la main est trop loin ; la rapprocher de la source ou **Toutes les pompes automatiques**. **Pas de pression** : plus aucune eau n’y arrive.',
            '**Plus que d’habitude** – beaucoup de pompes ; à côté, combien il en faudrait avec un autre Ø de tuyau.',
            '**Calculé sans profil altimétrique** (hors ligne, hors de Suisse) et **hors de la table AGV** – les chiffres sont estimés.',
            'Un avertissement de pompe est noté une fois dans le **journal** quand il apparaît, et figure ainsi au rapport.',
          ] },
        ],
      },
      {
        id: 'plan', title: 'Plan – modules et bâtiments', icon: 'doc',
        blocks: [
          { kind: 'lead', text: 'Une surface de travail par objet par-dessus les plans de module et de bâtiment – étage par étage, avec ses propres outils.' },
          { kind: 'list', items: [
            'En bas à gauche, la puce de l’**Objet** avec un voyant – la toucher ouvre «Plan · …» avec les lignes **Objet** (choisir un autre objet), **Carte** et **Échelle**. L’objet détermine les plans proposés.',
            'Les mêmes outils que sur la carte : **Sélection**, **Symbole**, **Ligne**, **Surface**, **Périmètre de sécurité**, **Note**, **Équipe** et **Mesurer**.',
            '**Étages** en pile : avec les boutons **étage sup./sous-sol** sur le plan, ajouter un étage au-dessus/en dessous.',
            '**Ajuster** et la flèche du nord dans la barre d’affichage, comme sur la carte.',
            '**Binômes** sous forme de marqueurs colorés ; les **Traces** d’un binôme (à son marqueur) montrent son trajet. Les pastilles de binôme «sorti» sont grisées/barrées.',
            '**Échelle** – toucher les deux extrémités de l’échelle imprimée et saisir la longueur réelle. Ensuite lignes, surfaces et **Mesurer** affichent de vrais mètres. Sans échelle, **Mesurer** la demande d’abord – le champ reste vide jusqu’à ce qu’une longueur soit saisie, et **Annuler** reprend une calibration fausse.',
            'Une feuille **liée** à la carte mesure déjà d’elle-même – de même que la pile d’étages du bâtiment, qui connaît sa taille d’après l’emprise. La ligne **Échelle** derrière la puce de l’objet dit alors d’où elle vient. On ne calibre à la main que ce qui n’est pas lié.',
            '**Une note rapide à la main ?** Le plan est la surface de croquis : dessiner librement, barrer, griffonner. La carte reste structurée (symboles, lignes, notes) pour que le rapport et le journal restent propres.',
          ] },
          { kind: 'sub', text: 'Lier à la carte (géoréférence)' },
          { kind: 'list', items: [
            '**Lier à la carte** (derrière la puce de l’objet) pose cette feuille sur la carte : le plan cède la moitié de la surface, la carte se place à côté. Sur un téléphone il n’y a pas de place pour les deux – la barre du bas passe alors entre **Carte** et le plan, on glisse l’endroit sous le réticule et on touche **+** ; la loupe en bas à gauche montre sur quoi il se trouve, et le statut **0/2** ouvre les étapes. Poser le même endroit sur les deux surfaces – un angle de maison, une hydrante, un croisement. **L’ordre n’a pas d’importance** : une moitié posée trouve seule son homologue, et on peut passer d’une surface à l’autre à volonté. Deux points suffisent à poser la feuille.',
            'Le **feu tricolore** dans la barre dit en permanence où l’on en est : deux points donnent une solution exacte et donc **non vérifiée** – seul le troisième mesure l’écart («4 points · ⌀ 1.2 m»). **Vérifier la superposition** pose la feuille sur la carte pour un contrôle visuel.',
            '**Tirer** une croix posée la déplace, la **toucher** ouvre **Déplacer**, **Retirer le point** ou **Garder**. Toucher **lié** ouvre la **Précision** avec les paires et l’écart ; **Copier** copie les points sur un autre module du même objet, **Retirer** les enlève (avec confirmation). **Fermer** n’abandonne rien – ce qui est posé est déjà enregistré.',
            'Dès lors, **les deux surfaces montrent les mêmes objets** – pas une copie, le même objet : le toucher montre les données, le tirer le déplace, mêmes sommets et mêmes poignées des deux côtés.',
            'Là où un objet **se trouve** est décidé par la dernière main qui l’a posé : tiré sur une feuille, il est sur la feuille – et suit la correction du lien. Tiré sur la carte, il est au sol. Un lien corrigé replace tout ce qui est posé sur cette feuille – une ligne au journal, qu’un ↶ annule. **Forme de la feuille mesurée** est le même repositionnement sans intervention : l’app a mesuré la feuille ouverte et résolu le lien à sa vraie forme. **Retirer** le lien ne perd rien : la feuille et la carte gardent toutes deux ce qu’elles montrent.',
            'Dans les **Couches**, chaque feuille liée reçoit une ligne propre («Plan (module 2)») : la feuille elle-même, en image sous la carte. Les objets qui y sont posés n’ont plus besoin de ligne – ils appartiennent à la couche sur laquelle ils ont été posés.',
          ] },
          { kind: 'note', text: '**Bâtiment** est UNE case dans la barre des espaces : tant qu’aucun n’est choisi (symbole de contour), elle montre les contours de bâtiment en direct d’OpenStreetMap – toucher un bâtiment, le reprendre, et la case devient la pile d’étages. Si l’intervention a un lieu, le bâtiment y est déjà marqué – vérifier et reprendre suffit. En bas à gauche, «Choisir un autre bâtiment» ramène au choix. Le **module 6** (plans d’étage) est par défaut une simple visionneuse à feuilleter/zoomer – on annote sur la pile d’étages du bâtiment, pas sur le PDF du module 6. Si un module est une visionneuse, la configuration des modules de ce corps le dit.' },
          { kind: 'note', text: '**Dans quel sens se trouve le bâtiment ?** Un toucher sur la **Flèche du nord** de la pile d’étages (dans la barre d’affichage) ouvre la petite fenêtre «Pivoter le bâtiment» : un curseur **Rotation** avec aperçu, plus **Nord en haut** et **Pivoter sur le grand axe** en un seul toucher chacun. Le contour tourne avec, les marquages restent où ils sont sur le bâtiment – et les pages d’étage imprimées montrent l’angle réglé.' },
        ],
      },
      {
        id: 'atemschutz', title: 'Binômes et surveillance ARI', icon: 'stopwatch',
        blocks: [
          { kind: 'lead', text: 'Surveillance sans faille de chaque binôme ARI selon FKS – le signal de sécurité est le **temps depuis le dernier contact radio**, et non une autonomie restante estimée.' },
          { kind: 'sub', text: 'Annoncer le binôme' },
          { kind: 'list', items: [
            '**Qui entre** : trois emplacements, celui du haut est le **CG** – toucher toute la ligne désigne quelqu’un comme chef de groupe, le **✕** le retire. Un binôme plus grand ajoute simplement des lignes.',
            'La **recherche de personne** atteint tout l’effectif, pas seulement les présents ; à côté de chaque nom figure ce qui s’y oppose (absent, à la caserne, déjà dans un binôme). **(+)** enregistre un invité (corps voisin) – ajouté en même temps à la présence, où il compte comme la même personne.',
            'La **Pression d’entrée** (bar) et le **Canal radio** sont juste à côté.',
            'En dessous, la **Mission** : type (sous ARI Sauver, Éteindre, Fouiller, Sécuriser, Reconnaître, Autre ; sans ARI Circulation, Sanitaire, Alimentation en eau, Sécuriser, Mise à disposition, Autre), **Objectif / lieu** en clair, **Conduite n°** (les conduites déjà dessinées sont proposées à côté) et la **Couleur** sur la carte et le plan.',
            'La mission ne retient personne : **Annoncer le binôme** fonctionne sans elle. La carte affiche alors **«mission ouverte»**, et un toucher dessus ouvre le formulaire.',
            'Ce qui est saisi survit à une fermeture par **✕** ou par un clic à côté – seul **Annuler** l’efface.',
          ] },
          { kind: 'sub', text: 'Surveillance par binôme' },
          { kind: 'list', items: [
            'L’horloge de chaque binôme compte **depuis le dernier contact** : **Contact ok** → après {contactMin} min jaune **Contact à faire** → après encore {graceSec} s rouge **En retard** avec alarme. Les deux valeurs sont fixées par le corps dans l’administration.',
            '**Contact** confirme le contact radio et réinitialise l’horloge.',
            '**Pression** ouvre les valeurs : **un toucher sur une valeur l’enregistre aussitôt** – il n’y a pas de confirmation. Cela compte comme contact et est journalisé. Mauvaise valeur ? **↶ Annuler** la reprend. À la pression d’alarme, la pression passe au rouge.',
            'Statut **Annoncé → En intervention → Repli → Sorti**. **Repli** peut être annulé avec **Poursuivre** ; **Sorti** demande la pression restante. Un binôme sorti revient à la surveillance avec **Réengager** (nouvelle bouteille) – le **relevé de pression du premier engagement est conservé** et figure entièrement sur le rapport.',
            'Les binômes sortis figurent en gris sous **Sortis**. Dans l’ordre «Tel que placé», ils gardent au contraire leur place.',
            'Un **binôme retiré** ne quitte que la surveillance : il figure toujours sur le rapport, avec tout ce qui a été mesuré, marqué **«Retiré»**. **Groupes retirés** dans l’en-tête le ramène – le message «annuler» est la porte rapide, pas la seule.',
            'Le **journal** par binôme (dépliable) montre chaque contact avec l’heure et la pression.',
            'Le **⋯** au pied de la carte : **Modifier** ajuste la mission / l’objectif ou le binôme en cours d’intervention, **Placer** pose le binôme sur la carte ou le plan (ensuite **Montrer sur le plan**), plus conduite, tri et **Retirer**.',
            'Une personne dans un binôme ne peut pas être désinscrite dans la **Présence** – toucher sa ligne saute à la carte de ce binôme et la met brièvement en évidence.',
            'Les binômes en retard remontent en haut et un compteur apparaît. La **cloche** coupe l’alarme par appareil – son **et** notification, et seulement jusqu’à la fin de cette intervention. Si elle est rouge, le navigateur n’a pas autorisé le son : la toucher. La surveillance elle-même n’est jamais muette. Tout est consigné au journal.',
            '**Transmettre la surveillance** (le QR à côté de la cloche) passe les binômes sur un autre appareil – voir «Partager et présenter».',
          ] },
          { kind: 'sub', text: 'Urgence ARI' },
          { kind: 'list', items: [
            'Sur un binôme engagé figure la large tuile **Urgence**. On la **maintient appuyée** jusqu’à ce qu’elle soit entièrement remplie – un toucher bref ne déclenche rien.',
            'Le binôme est alors rouge partout, avec sa propre horloge d’urgence et une alarme sur chaque appareil. Sa page dit ce qui compte maintenant : où il était, dernier contact, dernière pression, canal – et **Engager l’équipe de sécurité**.',
            'On y met fin de la même façon : maintenir **Urgence terminée** appuyé – ou annoncer **Sorti**, ce qui la termine aussi. Les deux figurent au journal et sur le rapport ; ↶ les reprend.',
          ] },
        ],
      },
      {
        id: 'anwesenheit', title: 'Présence', icon: 'people',
        blocks: [
          { kind: 'lead', text: 'Qui est engagé, et de quand à quand – la base de la feuille de personnel et des heures. L’effectif vient de l’administration ; ici on note seulement qui est là aujourd’hui.' },
          { kind: 'sub', text: 'Saisir' },
          { kind: 'list', items: [
            '**Toucher** une ligne la fait avancer : **libre → présent → parti → libre**. Le premier «présent» commence à l’**Heure d’alarme** (on saisit en général après l’arrivée) ; un retour commence maintenant.',
            'Chaque ligne a une **Remarque** («chauffeur TLF», «blessé, relevé 21:40»). Elle dit ce que cette personne a fait ici et figure sur la feuille de personnel. Si une ligne passe par «libre» par erreur, la remarque revient au prochain «présent».',
            '**Sur place** ou à la **Caserne** forme une paire dans la ligne – la réponse à «qui pourrait-on encore appeler». L’en-tête montre la répartition dès que quelqu’un est à la caserne.',
            'Quelqu’un qui n’est pas sur la liste du personnel (corps voisin, invité) : taper son nom dans la recherche, la dernière ligne devient alors **Ajouter «…» comme invité**. La personne porte la marque **Invité** – une affirmation sur cette intervention, pas sur l’appartenance au corps.',
            'Une personne **dans une équipe** ne peut pas être désinscrite ici – un toucher saute à la carte du binôme ; y annoncer d’abord **Sorti**.',
          ] },
          { kind: 'sub', text: 'Corriger' },
          { kind: 'list', items: [
            '**Annuler / Rétablir** dans la barre d’intervention reprend le dernier toucher. Le journal garde les deux : le toucher et la correction.',
            'Heures fausses ? L’**horloge** de la ligne ouvre les **Plages saisies** de la personne : corriger de/à, aussi pour une plage antérieure si quelqu’un est venu deux fois. Qui revient reçoit une nouvelle plage avec **De retour**.',
            'Les trois vues en haut : **Présence** (qui est là), **Planning** (qui est disponible quand), **Tours** (relèves en bandes).',
          ] },
          { kind: 'note', text: 'La saisie fonctionne aussi **par QR** (affiche à la caserne) : qui s’y inscrit apparaît ici – et les deux côtés peuvent toucher la même personne sans rien perdre.' },
        ],
      },
      {
        id: 'mittel', title: 'Matériel', icon: 'box',
        blocks: [
          { kind: 'lead', text: 'Ce qui a été engagé – depuis le catalogue du corps ou saisi librement. Le rapport en imprime la liste de matériel.' },
          { kind: 'list', items: [
            'Le **Catalogue** vient de l’administration, avec unité et stock («sur le TLF», «Pio»). **+** augmente la quantité, la ligne reste.',
            '**Autre matériel** saisit ce que le catalogue ne connaît pas – une désignation et une quantité suffisent.',
            'Si un symbole de matériel (ventilateur, absorbant) est posé sur la carte ou le plan sans être encore saisi, une **barre au-dessus de la liste** le dit : «Posé, mais pas saisi». **Reprendre** saisit tout ce qui manque avec la provenance du stock – un toucher plutôt que la même chose saisie deux fois. S’il y a plus d’une possibilité, le bouton s’appelle **Saisir …** et demande.',
            'Mettre une quantité à **0** ne retire pas la ligne du procès-verbal – le rapport montre ce qui a été engagé et ce qui a été repris.',
          ] },
        ],
      },
      {
        id: 'zeitplan', title: 'Planning et tours', icon: 'clock',
        blocks: [
          { kind: 'lead', text: 'Les deuxième et troisième vues de la présence : non pas «qui est là» mais **qui est disponible quand** – pour une intervention qui dure plus d’un tour.' },
          { kind: 'list', items: [
            'Dans le **Planning**, chaque personne a sa ligne ; tirer (ou le crayon) planifie une fenêtre de disponibilité. C’est un **plan**, pas un procès-verbal : il n’écrit aucune présence – celle-ci naît quand quelqu’un touche vraiment.',
            '**affecté** (plein) ou **disponible** (creux) – la différence entre «vient» et «pourrait venir» ; en vert, qui est vraiment là.',
            'La **Période** en haut décide du nombre d’heures visibles à la fois.',
            'Dans **Tours**, les mêmes fenêtres sont groupées en bandes nommées («nuit 22–06») : créer une bande n’écrit aucun tour, et une ligne supprimée ne supprime aucune disponibilité.',
            'Les deux vues s’impriment : **Sur papier** (l’imprimante dans l’en-tête) – **Disponibilités**, et dès qu’il y a des bandes **Plan des tours** ; en PDF ou directement sur l’imprimante de caserne.',
          ] },
        ],
      },
      {
        id: 'checkliste', title: 'Checklist', icon: 'check',
        blocks: [
          { kind: 'lead', text: 'Une liste avec une recherche : des tâches à dérouler, un référentiel tactique et de mots-clés, les modes d’emploi d’appareils du corps.' },
          { kind: 'list', items: [
            '**Correspondances** vient en premier : les entrées liées à ce que dit le mot-clé de l’intervention.',
            '**Tâches** – listes de contrôle d’intervention (p. ex. conduite, rapport de situation) avec barre de progression ; cocher les points, les embranchements suivent des procédures à plusieurs étapes.',
            'Les groupes de référence du corps – chercher un mot-clé et ouvrir l’entrée (avec code couleur des dangers et croquis) – et les **Modes d’emploi** des appareils.',
          ] },
          { kind: 'lead', text: 'L’état est conservé et synchronisé sur tous les appareils.' },
        ],
      },
      {
        id: 'verlauf', title: 'Journal et entrée', icon: 'verlauf',
        blocks: [
          { kind: 'lead', text: 'Un journal partagé et continu à travers la carte et le plan – la chronique de l’intervention.' },
          { kind: 'list', items: [
            '**Entrée** : un toucher bref ouvre la saisie de texte. **Maintenir appuyé** ouvre deux champs – **Note vocale** et **Photo** – qui restent jusqu’à ce qu’on en touche un ; le bouton lui-même devient un **✕** et annule. Des photos peuvent aussi être jointes dans l’entrée même.',
            'Dès **deux lettres**, des noms sont proposés – effectif, matériel, organisations partenaires, véhicules et groupes d’alarme, plus les postes **CI** et **Rempl. CI**. Un toucher insère le nom entier ; il est mis en évidence dans le journal et sur le rapport imprimé. Écrire le poste donne le nom («CI (Widmer Céline)»), écrire le nom donne le poste. Il n’y a pas de champ «De» séparé : la phrase dit déjà qui a annoncé.',
            'Dès que la phrase se termine par un nom, **→** et **←** sont proposés à côté : un toucher écrit la flèche, et «CI → sanitaire : patient stable» se lit comme le protocole radio qu’est le journal. Sur le papier cela devient «->».',
            'Tant que le champ est **vide**, des puces de départ attendent : d’abord **CI →**, puis les formulations déjà écrites sur cette intervention (sinon la liste du corps). Elles restent jusqu’à ce que l’on tape vraiment – une deuxième puce s’ajoute à la première.',
            'Les actions importantes (symbole posé, dessin créé/supprimé …) sont consignées automatiquement au journal.',
            '**Annuler/Rétablir** s’applique à la carte, au plan, aux binômes – et à la **Présence**, où il reprend le dernier toucher.',
            'Une entrée de journal avec un lieu ramène à l’endroit dans la carte ou le plan quand on la touche ; photos et notes vocales s’ouvrent/se lisent directement dans le journal.',
            'Une **faute de frappe** se corrige : le **crayon** de la ligne figure sur tout ce que quelqu’un a tapé lui-même – pas sur ce que l’app a écrit au sujet d’une action («binôme 2 rentré»). La ligne porte ensuite **Corrigé HH:MM** ; le texte d’origine reste dans le journal et dans la chaîne de vérification.',
            '**Lecture** (▶ au journal) rejoue la carte et le plan à un instant antérieur (curseur temporel ; l’édition est bloquée pendant ce temps). Pendant l’intervention elle commence à «Maintenant», après la clôture au début.',
            'Le texte à moitié saisi dans l’**Entrée** reste, même si l’app se recharge – photos et notes vocales non.',
          ] },
          { kind: 'sub', text: 'En suspens' },
          { kind: 'list', items: [
            'L’**anneau** à côté de «Info · Ordre · Mesure immédiate» fait d’une entrée un **point en suspens** : il reste ouvert jusqu’à ce qu’il soit coché. Un toucher sur l’anneau ouvre le choix – **Nouvel en-suspens**, **En-suspens urgent**, ou un point déjà ouvert auquel cette entrée est rattachée comme **Message**.',
            'Les points ouverts figurent **en haut du journal**, les urgents tout en haut, puis les plus anciens. L’heure dit **quand ils ont été donnés** ; un toucher dessus montre plutôt leur âge. L’anneau à gauche les coche.',
            'Un point en suspens rassemble des **Messages** : toucher la ligne en écrit un – avec tout ce qu’une entrée sait faire, donc aussi en note vocale ou en photo. Tous les messages figurent sous leur point, et dans le journal chacun porte le début du point comme renvoi ; un toucher dessus y saute.',
            'Un point en suspens n’a de lui-même **aucune échéance** – sur le lieu du sinistre, personne ne rappelle à l’heure. Qui en veut une touche l’**horloge** à côté de l’anneau : **dans 5/10/15/30/60 minutes** ou **Heure …** avec jour et heure – dans le même sélecteur d’heure que partout (rouleaux, ou saisir l’heure), aujourd’hui ou l’un des prochains jours ; un moment déjà passé ne peut pas être repris. Un rappel n’est donc plus une sorte de ligne à part, mais une entrée qui se signale en plus d’elle-même – avec type, photo et note vocale comme toute autre. Dans la liste, l’échéance figure comme heure à côté de la ligne.',
            'Sur le rapport, ils apparaissent comme **«Ordres / en-suspens»** avec Quoi, Qui, Donné et Fait ; ceux encore ouverts figurent comme **ouvert**. La section peut être décochée sous **Autres options d’impression** (le **▾** à côté du PDF). Sur le **tableau**, la même liste est une page «Ordres / en-suspens» – coché d’un côté, coché de l’autre.',
          ] },
          { kind: 'note', text: '**Qui** n’est pas demandé : la phrase le nomme. «Werkhof Oberwil fournit du matériel de barrage» suffit – le nom mis en évidence arrive comme Qui sur le rapport.' },
        ],
      },
      {
        id: 'rapport', title: 'Rapport et clôture', icon: 'doc',
        blocks: [
          { kind: 'lead', text: 'Le **Rapport d’intervention** est une surface à part dans la barre des espaces, après Matériel – une feuille de saisie préremplie, pas un formulaire à partir de zéro. Il se complète tout au long de l’intervention, pas seulement à la fin.' },
          { kind: 'list', items: [
            'Sur les écrans larges, deux colonnes : à gauche le **formulaire** à remplir (alarme, bref rapport, heures, remarques, retour à la centrale d’engagement), à droite la **mise en concordance** à cocher (présences, matériel, organisations partenaires, photos).',
            'Sous le titre figure ce qui est saisi – et une puce **Contrôle** qui compte ce qui est **en suspens** («4 en suspens · 1 remarque») : heures, présences, matériel, chef d’intervention, bref rapport, retour à la centrale. Un toucher ouvre la liste. Rien de tout cela ne bloque jamais l’impression.',
            'Le **Cadrage du croquis** se trouve à côté du formulaire : déplacer, zoomer, **Portrait/Paysage** et le **Kroki à** – quel moment l’image montre, avec des repères là où quelque chose s’est produit. Ce qui s’imprime est exactement ce qui est à l’écran ; il n’y a pas d’étape de confirmation.',
            '**Rapport d’intervention (PDF)** produit le rapport fini – rendu côté serveur, un seul bouton. Le **▾** à côté, **Autres options d’impression**, choisit les sections – ce qui part sur le papier (croquis, plans, bâtiment, ARI, présences, matériel, journal d’intervention, ordres / en-suspens, photos …) – et télécharge les annexes en ZIP. Le menu reste ouvert pendant que l’on coche.',
            'Là où un corps exploite une **imprimante de caserne** : **Imprimer** met le rapport dans sa file d’attente. Mis en file n’est pas imprimé – tant qu’un travail reste en suspens, **Impression en attente** figure sous l’en-tête du rapport, avec **Vérifier** et **Annuler**. Le rapport ne compte comme établi que lorsque l’imprimante annonce «imprimé».',
            'Si le corps a déposé ses propres formulaires (Administration › Rapport), **Formulaires & liens** apparaît à la fin, sous le cadrage du croquis – une liste à cocher. **Ouvrir** appelle le formulaire avec le mot-clé, le lieu, la date et le chef d’intervention déjà remplis, dans la mesure où le lien le prévoit. La coche se met à la main : l’app ne voit pas si un formulaire a été envoyé.',
            'Si quelque chose cloche dans l’enregistrement – une chaîne de vérification rompue, une note vocale sans transcription, une photo encore en file d’attente –, le **Contrôle** le compte comme **remarque** ; si tout est en ordre, la puce n’apparaît pas.',
            'La personne de contact et le retour à la centrale portent un **Sans objet** en fin de ligne – pour la fausse alarme ou la nappe d’huile où ni l’un ni l’autre n’existe. C’est une réponse, pas un contournement : elle est consignée et figure ainsi au rapport.',
            '**Clore l’intervention** clôt l’intervention et fixe l’heure de fin – dans l’en-tête du rapport dès qu’un PDF ou une impression existe, sinon dans le menu (le dialogue cite alors le rapport manquant comme point ouvert). Ensuite, le rapport ne peut plus qu’être lu et signé. Les photos et notes vocales non encore synchronisées le sont d’abord ; si c’est impossible (hors ligne), elles **restent enregistrées sur cet appareil** et seront synchronisées à la prochaine ouverture – la confirmation dit combien.',
            '**Signatures** (facultatives) : le chef d’intervention et le commandant signent du doigt – en intervention comme après la clôture. Si la partie signée change ensuite, la signature figure comme **non valable** ; un toucher signe à nouveau.',
            '**Partager** (en bas du rapport, et dans le menu sous **Partager l’intervention**) : un lien vers cette intervention uniquement, en lecture seule – plus sous «Partager et présenter».',
          ] },
          { kind: 'note', text: 'Une intervention close peut être **rouverte** – les compléments ultérieurs apparaissent dans le journal et dans le rapport comme **compléments**, et rien n’est perdu.' },
        ],
      },
      {
        id: 'links', title: 'Partager et présenter', icon: 'link',
        blocks: [
          { kind: 'lead', text: '**Partager l’intervention** (dans le menu à l’intervention ouverte, et dans le rapport) donne un lien en QR code et en adresse. **Révoquer le lien** le rend immédiatement invalide.' },
          { kind: 'list', items: [
            '**Intervention · lire** – carte, plans, journal, photos, heures. Sans connexion, rien ne peut être modifié. Pour la centrale, le CI et un corps voisin pendant l’intervention, pour la commune et le corps voisin après : il reste valable au-delà de la clôture.',
            '**Binômes · utiliser** – seulement les binômes de cette intervention, à tenir sur un appareil à part (aux binômes : **Transmettre la surveillance**). Ce qui y est saisi figure au rapport. Valable jusqu’à la clôture.',
            'Collaborer plutôt que regarder ? **Se connecter** sur l’autre appareil – un lien ne fait de personne un éditeur. Le menu d’un appareil à lien propose pour cela **Se connecter**.',
          ] },
          { kind: 'sub', text: 'Présenter' },
          { kind: 'list', items: [
            '**Présenter** – dans le menu, à l’intervention ouverte, ou dans **Partager l’intervention** – › **Démarrer** : qui a l’intervention ou le lien de lecture ouvert peut **Suivre** – son écran montre ce que montre le tien, sur chaque surface.',
            '**Montrer** fait d’un toucher un point et d’un trait une ligne, qui s’estompent – visibles par tous, rien n’est enregistré.',
            '**Terminer** arrête ; **Ne plus suivre** libère son propre écran. Si une présentation est déjà en cours, on peut la **Reprendre**. Présenter nécessite du réseau.',
          ] },
        ],
      },
      {
        id: 'erfassung', title: 'Saisie par QR code', icon: 'cam',
        blocks: [
          { kind: 'lead', text: 'Là où un corps a activé la saisie (Administration › «Liens et accès»), un **poster QR** à la caserne ouvre la vue de saisie – sans connexion, pour tous ceux qui n’ont pas accès à une tablette.' },
          { kind: 'list', items: [
            'On choisit une intervention en cours ou une dont le rapport est encore ouvert ; depuis son propre téléphone, on saisit **présences**, **matériel**, heures, données, organisations partenaires et photos.',
            'Un nom avance en le touchant : **absent → caserne → sur place → parti**. Le **ⓘ** à côté de la recherche le redit, y compris ce que signifie l’heure à côté (de = arrivée, à = départ).',
            'Les données rejoignent la **même intervention** que la tablette du poste de commandement et sont fusionnées (avec un avis de contrôle en cas d’écart).',
            'En repli, il existe la **feuille de saisie vierge (PDF)** à imprimer et à compléter à la main.',
          ] },
        ],
      },
      {
        id: 'sync', title: 'Multi-appareils et hors ligne', icon: 'check',
        blocks: [
          { kind: 'lead', text: 'Tous les appareils voient la même intervention en direct.' },
          { kind: 'list', items: [
            'Les modifications sont synchronisées automatiquement ; l’indicateur en haut montre l’état.',
            'Les éditions simultanées sont fusionnées par objet (la modification la plus récente l’emporte).',
            '**Lecture seule** : les observateurs voient la carte en direct, sans les outils tactiques.',
          ] },
          { kind: 'sub', text: 'Hors ligne' },
          { kind: 'list', items: [
            '**Préparation hors ligne** : l’app installée va chercher d’elle-même carte, plans, symboles et couches de référence peu après l’ouverture d’une intervention – sans dialogue, sans notification. **Toutes** les couches cartographiques configurées sont chargées, y compris celle qui est masquée : l’expérience montre qu’on l’active une fois le réseau déjà perdu. Le bouton **Tout charger pour le hors ligne** fait de même à tout moment, à la main.',
            'La quantité chargée dépend du **Rayon hors ligne** de la station (dans l’administration, le même pour tous les appareils).',
            'Ce qui est réellement prêt est indiqué par **Réglages › Cet appareil** dans le menu – ligne par ligne : carte, plans, symboles, matières dangereuses, couches de référence, effectif, stockage de l’appareil. **Météo** et **Recherche d’objet** nécessitent du réseau et y figurent comme «avec réseau uniquement».',
            'Seule l’**app installée** est fiable hors ligne. Dans un onglet de navigateur, le stockage peut être vidé à tout moment, et l’onglet devrait encore être ouvert à la prochaine intervention.',
            'Sans réseau, tout ce qui est sur l’appareil continue de fonctionner : dessiner et poser des symboles, ARI, présence, matériel, journal et rapport. Photos et notes vocales restent enregistrées et partent plus tard.',
            'Dès que le réseau revient, les modifications partent d’elles-mêmes et sont fusionnées avec les autres appareils – par objet, la modification la plus récente l’emporte. Tant que quelque chose est en attente, l’indicateur en haut le dit.',
          ] },
        ],
      },
      {
        id: 'bedienung', title: 'Utilisation et jour/nuit', icon: 'move',
        blocks: [
          { kind: 'sub', text: 'Toucher et glisser (tactile/iPad)' },
          { kind: 'list', items: [
            'Un doigt déplace la carte/le plan ; deux doigts zooment (pincer).',
            'Quand l’app revient de l’arrière-plan, plus aucun outil n’est en main – un dessin commencé demande comme toujours s’il reste.',
            'Un seul doigt zoome aussi : **toucher deux fois** zoome ; **toucher, puis appuyer de nouveau et tirer** zoome en continu – vers le bas pour agrandir, vers le haut pour réduire. Pareil sur la carte et le plan, avec la **Sélection**. Un outil a la priorité : là où il touche (points, mesure, ajouter, note, cercle …), chaque toucher lui appartient ; là où il trace (main levée, multiple), toucher deux fois zoome toujours. Deux doigts zooment toujours. Une ligne ou une surface posée point par point se termine avec ✓, jamais en touchant deux fois.',
            'Toucher **Sélection** une nouvelle fois fait passer le bouton sur **Multiple** : un cadre tiré sélectionne plusieurs objets. Toucher d’abord un objet, puis le tirer – un doigt sur un objet non sélectionné déplace la carte. Lignes, surfaces et cercles se déplacent avec **✥**.',
            '**Maintenir appuyé** un point de mesure, de ligne ou de surface jusqu’à ce que l’anneau soit fermé le supprime ; le **+** au milieu d’un segment en ajoute un.',
          ] },
          { kind: 'sub', text: 'Souris', only: 'keyboard' },
          { kind: 'list', only: 'keyboard', items: [
            'La molette zoome ; un **clic droit** sur un point de mesure, de ligne ou de surface le supprime.',
          ] },
          { kind: 'sub', text: 'Touches', only: 'keyboard' },
          { kind: 'list', only: 'keyboard', items: [
            '[[Esc]] revient d’un niveau – outil, panneau ouvert, sélection (l’ordre complet sous **Raccourcis clavier**).',
            '[[Suppr]] / [[Retour arrière]] supprime la sélection (pas pendant la saisie dans un champ).',
          ] },
          { kind: 'sub', text: 'Barres avec libellés' },
          { kind: 'list', items: [
            'Dans les **Réglages** ([[⌘]] [[,]]) sous «Étiquettes des barres» : **Activé** écrit sous chaque symbole son mot – dans la barre de gauche et de droite, dans la barre de l’outil choisi (pour la ligne «Main levée» · «Points» · «Annuler») et dans la barre d’affichage en bas à droite, en intervention comme sur «Carte & objets». **Désactivé** ne laisse partout que les symboles. Pour tous ceux qui ne connaissent pas encore les symboles par cœur – les barres deviennent un peu plus larges, et en intervention «Déplier» n’est alors plus nécessaire. Sur le **téléphone**, c’est **Activé** dès le départ.',
            'Si c’est désactivé, seul le symbole reste ; un toucher sur **Déplier** montre les noms tant que la barre reste ouverte.',
            'Partout ailleurs : **maintenir appuyé** un bouton qui ne porte qu’un symbole – après un court instant, son mot apparaît en bulle au-dessus, avec une brève vibration sur tactile. Relâcher ne déclenche **pas** le bouton : demander ce qu’est une chose ne doit pas la faire en même temps. À la souris, il suffit de survoler.',
          ] },
          { kind: 'sub', text: 'Jour / nuit' },
          { kind: 'list', items: [
            'Dans les **Réglages** ([[⌘]] [[,]]) sous «Schéma de couleurs» : Automatique (suit la lumière du jour), Appareil (suit le clair/sombre de la tablette ou du téléphone), Jour ou Nuit. Le mode nuit atténue la carte et l’interface pour l’obscurité.',
          ] },
        ],
      },
      {
        id: 'verwaltung', title: 'Administration et données de la station', icon: 'gear',
        blocks: [
          { kind: 'lead', text: 'Tout ce qui vaut pour l’ensemble du corps – personnel, grades, véhicules, matériel, couches cartographiques, plans d’objet, checklists – se gère sous **Administration**, pas pendant une intervention. L’accès est une **Clé d’administration** propre, ce n’est pas le NIP d’intervention.' },
          { kind: 'sub', text: 'Le classeur (Excel)' },
          { kind: 'list', items: [
            'Sous **Données › Classeur**, les listes du corps forment un seul fichier Excel : le télécharger, le modifier dans Excel, Numbers ou LibreOffice, le réimporter. Huit feuilles – Mannschaft, Dienstgrade, Fahrzeuge, Mittel, Mittel-Bestände, Quellen, Partnerorganisationen, Symbolfelder (les feuilles portent ces noms dans le fichier).',
            'Un **Aperçu** précède toujours l’écriture : feuille par feuille, ce qui serait nouveau, ce qui change, ce qui disparaît – et chaque ligne refusée avec sa feuille et son numéro. Rien n’est écrit avant la confirmation, et annuler n’écrit rien.',
            'Réimporter le même fichier ne change absolument rien. Le téléchargement est donc aussi le modèle – et on peut le prendre sans risque juste pour regarder.',
          ] },
          { kind: 'note', text: '**Une feuille absente n’est pas une feuille vide.** Supprimer une feuille entière du fichier laisse cette liste inchangée. N’en supprimer que les lignes en gardant la ligne de titre la vide – c’est exactement ainsi qu’on vide une liste volontairement.' },
          { kind: 'note', text: '**«Absent» veut dire deux choses.** Une personne absente de la feuille «Mannschaft» est **désactivée**, jamais supprimée – les interventions clôturées résolvent son nom par cette ligne. Un identifiant absent d’une des autres listes est **retiré**. L’aperçu emploie exactement ces deux mots et ne se contente pas de compter.' },
          { kind: 'sub', text: 'Si malgré tout ça tourne mal' },
          { kind: 'list', items: [
            'Chaque modification des **Listes** conserve l’état précédent : **Sauvegarde › Dernières modifications** les montre avec l’heure et en restaure un – que l’auteur soit un formulaire, le classeur ou le terminal.',
            '**Le personnel n’y figure pas.** Les personnes ne sont pas de la configuration, mais des enregistrements propres – un import qui ne touche que la feuille Mannschaft n’apparaît pas du tout sous «Dernières modifications». En contrepartie personne n’y est jamais supprimé, seulement désactivé : annuler revient à réactiver. Pour restaurer la liste entière, reprenez le fichier téléchargé avant l’import.',
            'Le classeur n’est **pas une sauvegarde** : il ne couvre que les listes. La sauvegarde est l’export JSON sous **Sauvegarde**.',
          ] },
        ],
      },
    ],

    search: 'Rechercher dans l\'aide …',
    searchHint: 'Essaie un autre mot-clé – la recherche porte sur les titres et le texte.',
  },
}
