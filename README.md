# Kilosaurus Temps

Suivi de mon temps de travail par projet, depuis un téléphone ou un PC.

- **Les données** vivent dans une Google Sheet : un onglet par projet, une ligne par session ou
  par bloc d'heures.
- **L'API** est un Apps Script lié à la Sheet.
- **L'app** est une page web installable sur l'écran d'accueil (PWA), hébergée sur GitHub Pages.
- **Un agent Claude Code** peut aussi loguer du temps pour son utilisateur.

La v1 compte le temps, et rien d'autre : pas de totaux affichés. La conception complète est dans
`docs/specs/`.

## Contenu du dépôt

| Dossier | Rôle |
|---|---|
| `apps-script/` | L'API : `Core.gs` (règles métier), `Sheet.gs` (accès à la Sheet), `Code.gs` (point d'entrée, codes, verrou), `Test.gs` (test sur la vraie Sheet), `appsscript.json` |
| `web/` | L'app (HTML, CSS, JS sans framework). Seul `config.js` est à modifier. |
| `claude/kilosaurus-temps/` | Le skill Claude Code pour loguer depuis un agent |
| `tools/` | Report de l'ancien fichier, icônes, faux serveur et test de bout en bout (dev) |
| `tests/` | Tests de la logique, lancés dans Node |

Les fichiers `.xlsx` ne sont jamais commités : le dépôt est public (GitHub Pages gratuit l'exige),
et ils contiennent les heures et les emails.

---

## Mise en place

Compte environ 30 minutes, à faire une seule fois.

### 1. Créer la Sheet

Le fichier de départ se construit à partir de l'ancien Google Form : posez
`Kilosaurus Timesheet.xlsx` (l'export de l'ancienne feuille) à la racine, puis lancez
`py -m pip install openpyxl` et `py tools/migrate.py`. Seules vos lignes sont reprises (la liste
`PERSONS` du script) ; celles des autres personnes sont ignorées. Le script vérifie que vos heures
sont identiques à celles de l'ancien fichier, et s'arrête sinon.

1. Dans Google Drive : **Nouveau → Importer un fichier →** `Kilosaurus_Temps.xlsx`.
2. Ouvrez-le avec Google Sheets, puis **Fichier → Enregistrer au format Google Sheets**. Travaillez
   ensuite uniquement sur cette copie Google Sheets ; vous pouvez supprimer le `.xlsx` du Drive.
3. **Fichier → Paramètres → Fuseau horaire : (GMT+01:00) Paris.** Indispensable : les dates et
   les heures sont lues et écrites dans ce fuseau.

La Sheet contient :

- **Les onglets de projet** (`Fluffy`, `Heirfall`, `Studio`…). Chaque onglet sans `_` au début est
  un projet. L'ordre des onglets donne l'ordre des boutons dans l'app. La colonne **L — Type**
  (Misc, Art, Dev, Writing) est ajoutée par le script à la première écriture ; une cellule vide
  vaut Misc (les anciens noms Autre et Narration se lisent Misc et Writing).
- **`_Config`** : la liste des personnes, le seuil d'oubli (8 h), le nom de l'onglet studio, le
  nombre de boutons visibles.
- **`_Corrections`** : la trace de chaque correction d'heure.
- **`_Modèle`** : l'onglet vierge copié pour chaque nouveau projet. Ne le supprimez pas.

Ne modifiez pas à la main les heures ou les dates des lignes : passez par l'app, pour que la
correction soit tracée. La colonne Heures n'est pas une formule, elle ne se recalcule pas toute
seule.

### 2. Installer le script

1. Dans la Sheet : **Extensions → Apps Script**.
2. Supprimez le contenu de `Code.gs`, puis collez celui de `apps-script/Code.gs`.
3. Créez trois autres fichiers (**+ → Script**) nommés `Core`, `Sheet` et `Test`, et collez-y
   `Core.gs`, `Sheet.gs` et `Test.gs`.
4. **Paramètres du projet** (roue dentée) → cochez **Afficher le fichier manifeste
   « appsscript.json »**. Revenez à l'éditeur, ouvrez `appsscript.json` et remplacez son contenu
   par celui de `apps-script/appsscript.json`.
5. Enregistrez (Ctrl + S).

### 3. Créer les codes

Les codes secrets ne sont ni dans la Sheet ni dans le code : ils sont dans les propriétés du
script.

**Paramètres du projet → Propriétés du script → Ajouter une propriété du script :**

| Propriété | Valeur |
|---|---|
| `CODE_AMOHS_TELEPHONE` | le code du téléphone (app et widget) |
| `CODE_AMOHS_PC` | le code du navigateur du PC |
| `CODE_AMOHS_CLAUDE` | le code de l'agent Claude (facultatif, voir plus bas) |

Le nom de la propriété est `CODE_` suivi du nom tel qu'écrit dans `_Config`, en majuscules, sans
accent ni espace.

- **Un code par appareil** : ajoutez un suffixe, par exemple `CODE_AMOHS_TELEPHONE` et
  `CODE_AMOHS_PC`. Toutes ces lignes vont au nom de la personne. Un appareil perdu se révoque seul,
  sans toucher aux autres.
- **32 caractères au minimum**, aléatoires : l'URL de l'API est publique, et le code est la seule
  serrure. Un code plus court est ignoré par le script. Pour en générer un en PowerShell :
  `$b = New-Object byte[] 36; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) -replace '[+/=]', ''`.
- **Révoquer** : supprimez ou changez la propriété.

### 4. Vérifier avec le test

1. Dans l'éditeur, choisissez la fonction **`runSelfTest`** dans la liste en haut, puis
   **Exécuter**.
2. La première fois, Google demande l'autorisation d'accéder à la Sheet. Si Google affiche « Google n'a pas validé cette application »,
   cliquez sur **Paramètres avancés**, puis sur **Accéder à … (non sécurisé)** : c'est votre
   propre script.
3. Le journal doit afficher **« OK : parcours complet validé, Sheet intacte. »**

Le test crée deux onglets temporaires (`ZZ Test A…`, `ZZ Test B…`) et une personne fictive. Il joue
un parcours complet (lancement, bascule, arrêt, oubli, bloc, session d'agent, corrections), puis
efface tout ce qu'il a créé et vérifie que le reste de la Sheet n'a pas bougé. Pendant les quelques
secondes du test, les onglets temporaires peuvent apparaître dans l'app : c'est normal.

### 5. Déployer l'API

1. **Déployer → Nouveau déploiement** → type **Application Web**.
2. **Exécuter en tant que : Moi.** **Qui a accès : Tout le monde.**
3. **Déployer**, puis copiez l'**URL de l'application Web** (elle se termine par `/exec`).

Créez le déploiement depuis l'éditeur, comme ci-dessus, et **après** avoir lancé `runSelfTest` une
première fois (étape 4) : un déploiement créé avant cette autorisation, ou en ligne de commande
avec clasp, a déjà répondu aux GET mais perdu la réponse des POST (page 404 après la redirection
de Google).

Pour publier une modification du script plus tard : **Déployer → Gérer les déploiements →**
crayon → **Version : Nouvelle version → Déployer**. L'URL ne change pas. (Un *nouveau*
déploiement, lui, crée une nouvelle URL.)

### 6. Brancher l'app sur l'API

Dans `web/config.js`, remplacez l'URL par celle copiée à l'étape 5.

### 7. Publier l'app sur GitHub Pages

1. Créez un dépôt **public** sur GitHub (GitHub Pages n'est gratuit que pour les dépôts publics).
2. Poussez ce dépôt sur la branche `main`.
3. Dans le dépôt GitHub : **Settings → Pages → Build and deployment → Source : GitHub Actions.**
4. Le workflow `.github/workflows/pages.yml` publie le dossier `web/` à chaque push sur `main`.
   L'adresse de l'app s'affiche dans **Settings → Pages** (du type
   `https://<compte>.github.io/<dépôt>/`).

### 8. Installer l'app sur son téléphone

Ouvrez l'adresse de l'app, puis :

- **iPhone (Safari)** : bouton **Partager → Sur l'écran d'accueil**.
- **Android (Chrome)** : menu **⋮ → Installer l'application** (ou **Ajouter à l'écran d'accueil**).
- **PC (Chrome, Edge)** : icône d'installation dans la barre d'adresse, ou utilisez simplement
  l'onglet.

Au premier lancement, l'app demande le code personnel. Elle le garde ensuite sur l'appareil.

### 9. Couper l'ancien Google Form

Le jour où l'app démarre : dans le Form, **Réponses → décochez « Accepter les réponses »**. Sinon,
du temps continue d'arriver dans l'ancien fichier, que plus rien ne lit.

---

## Utilisation

- **Type de travail** (Misc, Art, Dev, Writing) : la rangée de boutons colorés. Compteur en
  cours, un tap bascule le type sans trou : le temps d'avant reste sous l'ancien type. Compteur
  arrêté, un tap choisit le type du prochain lancement.
- **Lancer** : un tap sur un projet, avec le type choisi. Si un autre compteur tourne, il se ferme
  et le nouveau démarre.
- **Stop** : ferme le compteur. **+ note** : une note sur le compteur en cours.
- **⏸ Pause** : le compteur continue, marqué pause (même projet) ; **▶ Reprendre** revient à la
  tâche d'avant. Les pauses comptent dans le total du jour (« dont N min de pause »), sont hachurées
  sur la frise et ont leur ligne dans les récaps.
- **Aujourd'hui** : le total du jour, pauses exclues, compteur en cours compris, et la frise de la
  journée colorée par type. Une session commencée la veille ne compte que pour sa partie
  d'aujourd'hui. Les blocs déclarés comptent dans le total mais n'ont pas de place sur la frise.
- **Récap** : semaine (barres par jour, empilées par type) et mois (par type et par projet), avec
  flèches pour remonter le temps. Demande le réseau.
- **Déclarer 2 à 12** : un bloc d'heures pour aujourd'hui, sans début ni fin, avec le type choisi.
  **Autre jour…** : un bloc pour une date passée.
- **Corriger une heure** : directement dans la Sheet (l'app n'affiche plus la dernière entrée).
- **Oubli** : si un compteur tourne depuis plus de 8 h à l'ouverture, l'app demande l'heure de fin
  avant toute autre chose.
- **Point de couleur en haut à gauche** : vert synchronisé, orange en attente (hors ligne), rouge
  erreur. Un tap affiche le détail.
- **Hors ligne** : l'app réagit normalement. Les actions sont gardées sur l'appareil et envoyées
  au retour du réseau, avec l'heure du tap. Ces lignes sont marquées « hors ligne » dans la Sheet.
- **Menu (roue dentée)** : nouveau projet, **Afficher Studio** (le projet Studio est masqué par
  défaut ; réglage propre à chaque appareil ; masqué, son historique compte quand même dans les
  récaps), changer de code.
- **« Accès bloqué »** : après 10 codes refusés, l'API refuse tout le monde pendant une heure, vous
  compris. Vos données ne risquent rien, et l'app garde vos actions pour les envoyer au déblocage.
  Si vous n'avez pas tapé de mauvais code vous-même, quelqu'un essaie de deviner un code : changez
  vos codes. Pour débloquer sans attendre : dans l'éditeur Apps Script, exécutez **`unlockApi`**.

## L'app Android (APK) et son widget

L'APK contient **l'app complète** (les mêmes écrans que la version web, embarqués dans le
téléphone) et un **widget** lecture / stop pour l'écran d'accueil, pensé pour écrire : il lance le
projet choisi en type Writing, avec la session en cours et le total du jour. Il parle directement à
l'API : aucun hébergement web n'est nécessaire.

### Fabriquer l'APK

```bash
bash android/build.sh
```

Le script utilise le kit Android fourni avec Unity (`Hub/Editor/<version>/…/AndroidPlayer`), ou
`ANDROID_SDK` et `JAVA_HOME` s'ils sont définis. Il ne demande ni Gradle, ni Android Studio, ni
internet. Le fichier produit : `android/build/kilosaurus-temps.apk`.

Au premier build, une clé de signature est créée (`android/release.keystore` et
`android/keystore.properties`). **Sauvegardez ces deux fichiers** : une mise à jour de l'app doit
être signée avec la même clé, sinon il faut désinstaller l'ancienne version. Ils ne sont jamais
commités. Pour une mise à jour, augmentez le numéro de version :
`VERSION_CODE=2 VERSION_NAME=1.1 bash android/build.sh`.

**Dépôt automatique** (facultatif) : créez `android/local.properties` avec une ligne
`apk_drop=G:/Mon Drive/KILOSAURUS/Temps` (un dossier Google Drive synchronisé, par exemple). Chaque
build y copie l'APK en remplaçant le précédent : la dernière version s'installe ensuite depuis
l'app Drive du téléphone. Ce fichier est propre à la machine et n'est jamais commité.

L'adresse de l'API est celle de `web/config.js` (pour l'app) et de `Api.DEFAULT_URL` dans
`android/src/…/Api.java` (pour le widget, modifiable dans son réglage).

### Installer sur un téléphone

1. Envoyez `kilosaurus-temps.apk` sur le téléphone (message, Drive, câble…) et ouvrez-le.
2. Android demande d'autoriser l'installation d'applis inconnues pour l'app qui ouvre le fichier
   (Fichiers, Drive…) : acceptez, puis **Installer**.
3. Ouvrez **Kilosaurus Temps** et saisissez votre code perso.

### Poser le widget

1. Appui long sur l'écran d'accueil → **Widgets** → **Kilosaurus Temps** → **Lecture / stop**
   (3 × 1 case, redimensionnable). Après une mise à jour qui change sa taille, retirez l'ancien
   widget et reposez-le.
2. Le réglage s'ouvre : code perso (déjà rempli si vous vous êtes connecté dans l'app), puis
   **Charger mes projets**, choix du projet (Heirfall, par exemple), **Enregistrer**.

Utilisation :

- **▶** lance le projet du widget en type **Writing**. **■** arrête le compteur en cours, quel que
  soit son projet ou son type. Le type se change dans l'app.
- **Aucune attente** : le widget change d'état au moment du tap, même sans réseau. Les taps partent
  derrière, un par un et dans l'ordre, chacun avec son heure ; sans réseau ils attendent et repartent
  tout seuls (toutes les minutes, au tap suivant, ou à l'ouverture de l'app). Le message « Pas de
  réseau : N action(s) en attente » le signale. Un code refusé n'est pas renvoyé tout seul : corrigez-le
  dans le réglage.
- **Deux compteurs** : la session en cours, et « Aujourd'hui », le total du jour.
- **Toucher le nom du projet** rouvre le réglage (changer de projet ou de code). Toucher le message
  relance l'envoi ou relit l'état.
- Un compteur lancé depuis l'app apparaît tout de suite sur le widget. Lancé depuis un autre
  appareil, il apparaît à la prochaine mise à jour (30 min au plus, limite d'Android) ou au
  prochain tap.

## La mini-fenêtre de bureau (Windows)

Une petite fenêtre sans bordure, dans un coin de l'écran, au-dessus de tout : le compteur, les
projets et les tâches (la version compacte du site, `?mini=1`). Elle se lance au démarrage de
Windows et s'ajuste à la hauteur de son contenu.

```bash
cd desktop && npm install && npm start
```

Le premier lancement l'inscrit au démarrage de Windows ; il faut ensuite saisir son code une fois
(le code `PC`). Pour pouvoir la relancer à la main (raccourci **Kilosaurus Temps** sur le bureau et
dans le menu Démarrer) : `powershell -ExecutionPolicy Bypass -File desktop\install-shortcuts.ps1`.

Au démarrage de Windows, si le réseau n'est pas encore là, la fenêtre s'affiche quand même et
recharge la page toutes les 10 s. Les lancements et les erreurs sont notés dans
`%APPDATA%\kilosaurus-temps-desktop\desktop.log`. Si `npm install` n'a pas téléchargé Electron (`node_modules/electron/dist` vide),
lancez `node node_modules/electron/install.js`. Le démarrage automatique pointe vers ce dossier :
si le dépôt est déplacé, relancez `npm start` depuis le nouvel emplacement.

- **Déplacer** : glisser la barre du haut. **Plus d’infos ↗** ouvre la version complète (journée,
  récap, blocs) dans Chrome, ou dans le navigateur par défaut si Chrome est absent.
- **Icône près de l'horloge** (clic droit) : afficher / masquer, **Verrouiller la position**,
  **Toujours au-dessus**, **Lancer au démarrage**, remettre dans le coin, ouvrir en grand,
  recharger, quitter. Un clic gauche affiche ou masque la fenêtre.
- **Ctrl + Alt + K** affiche ou masque la fenêtre depuis n'importe où.
- Les réglages (position, verrou…) sont gardés dans `%APPDATA%\kilosaurus-temps-desktop\window.json`.
- Lancée depuis un terminal de VS Code, la fenêtre ne s'ouvre pas : VS Code pose
  `ELECTRON_RUN_AS_NODE`, qui fait tourner Electron comme Node. Lancez-la depuis un autre terminal,
  ou retirez d'abord cette variable.

## Ajouter un projet

Depuis l'app : **menu → + Nouveau projet**. Ou dans la Sheet : dupliquez `_Modèle` et renommez la
copie. Placez l'onglet où vous voulez : les 4 premiers projets (hors Studio s'il est masqué) ont un bouton direct,
les suivants passent dans « Plus… ». Le nombre de boutons directs se règle dans `_Config`.

## Loguer depuis un agent Claude Code

1. Créez la propriété `CODE_AMOHS_CLAUDE` (ou `CODE_AMOHS_CLAUDE_PC` pour un agent par machine),
   avec un code différent des autres. Tout code dont le nom contient le segment `CLAUDE` est un
   code d'agent. Les lignes de l'agent vont à votre nom, marquées « claude ». Le code d'agent se
   révoque sans toucher aux autres.
2. Copiez le dossier `claude/kilosaurus-temps/` dans `~/.claude/skills/` sur la machine.
3. Définissez deux variables d'environnement sur cette machine : `KILOSAURUS_TEMPS_URL` (l'URL de
   l'étape 5) et `KILOSAURUS_TEMPS_CODE` (le code d'agent).

L'agent a les mêmes actions que l'app, plus `logSession` : une session avec un début et une fin
quelconques (24 h au plus), refusée si elle chevauche une autre de vos sessions.

## Mettre à jour

- **Le script** : collez les fichiers modifiés, puis publiez une nouvelle version (étape 5).
- **L'app web** : poussez sur `main` (une minute de publication). La nouvelle version s'affiche dès
  l'ouverture suivante de la page : le service worker charge le réseau d'abord et ne garde sa copie
  que pour le hors ligne ; une page déjà ouverte se recharge seule quand la nouvelle version
  s'installe. L'APK, lui, embarque sa copie du site : il faut le reconstruire et le réinstaller.

## Développement

Il faut Node 20 ou plus récent. L'app n'a aucune dépendance.

```bash
npm test                      # logique serveur (Core.gs), parcours de runSelfTest, calculs de l'app
npm run dev                   # faux serveur : http://localhost:8787/?dev-code=code-amohs
node tools/e2e.js [captures]  # pilote Chrome contre le faux serveur, en taille téléphone
```

Le faux serveur exécute le vrai `Core.gs` sur une Sheet en mémoire. Les codes de test sont
`code-amohs`, et pour les personnes fictives `code-alex`, `code-sam` et `code-alex-claude` (agent). `--forgot` simule un
compteur oublié. `/__phone?dev-code=…` affiche l'app dans un cadre de 375 px.

Toute la logique métier est dans `Core.gs`, en JavaScript pur, sans API Google : c'est ce qui
permet de la tester dans Node. `Sheet.gs` et `Code.gs` ne font que la brancher sur Google.
