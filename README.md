# Kilosaurus Temps

Suivi de mon temps de travail par projet, depuis un téléphone ou un PC.

- **Les données** vivent dans une base Cloudflare D1 (SQLite) : une ligne par session ou par bloc
  d'heures.
- **L'API et l'app** sont servies par un même Worker Cloudflare (offre gratuite, sans carte).
- **L'app** est une page web installable sur l'écran d'accueil (PWA). Il existe aussi un APK Android
  avec son widget, et une mini-fenêtre de bureau pour Windows.
- **Un agent Claude Code** peut aussi loguer du temps pour son utilisateur.

La conception complète est dans `docs/specs/`.

## Contenu du dépôt

| Dossier | Rôle |
|---|---|
| `server/` | Le Worker : `worker.js` (routage, codes, blocage), `core.js` (règles métier), `db.js` (accès SQL), `tz.js` (fuseau de Paris), `schema.sql` (la base) |
| `web/` | L'app (HTML, CSS, JS sans framework) |
| `android/` | L'APK : l'app embarquée et le widget lecture / stop |
| `desktop/` | La mini-fenêtre de bureau (Electron) |
| `claude/kilosaurus-temps/` | Le skill Claude Code pour loguer depuis un agent |
| `tools/` | Serveur de dev, reprise de l'historique, test de bout en bout, icônes |
| `tests/` | Tests du serveur, des calculs de l'app et de la reprise |

Les fichiers `.xlsx` et `reprise.*` ne sont jamais commités : ils contiennent les heures réelles.

---

## Mise en place

À faire une seule fois.

### 1. Compte Cloudflare

Créez un compte sur https://dash.cloudflare.com/sign-up (gratuit, sans carte bancaire). Ignorez la
proposition d'ajouter un nom de domaine. Dans **Workers et Pages**, choisissez un sous-domaine
`workers.dev` court : l'app aura l'adresse `https://kilosaurus-temps.<sous-domaine>.workers.dev`.

### 2. Outils

Il faut Node 24 ou plus récent.

```bash
npm install
npx wrangler login
```

`wrangler login` ouvre le navigateur : cliquez sur **Allow**.

### 3. La base

```bash
npx wrangler d1 create kilosaurus-temps --location weur
```

Copiez l'identifiant affiché (`database_id`) dans `wrangler.toml`, puis créez les tables :

```bash
npm run db:schema
```

### 4. Les codes

Les codes secrets ne sont ni dans la base ni dans le code : ce sont des secrets du Worker.

```bash
npx wrangler secret put CODE_AMOHS_TELEPHONE
npx wrangler secret put CODE_AMOHS_PC
npx wrangler secret put CODE_AMOHS_CLAUDE
```

Chaque commande demande la valeur : collez-la dans le terminal.

- **Un code par appareil** (`_TELEPHONE`, `_PC`…) : un appareil perdu se révoque seul, sans toucher
  aux autres.
- **Code d'agent** : tout nom dont un segment est `CLAUDE` (`CODE_AMOHS_CLAUDE`,
  `CODE_AMOHS_CLAUDE_PC`). Ses lignes sont marquées « claude ».
- **32 caractères au minimum**, aléatoires : l'URL de l'API est publique, et le code est la seule
  serrure. Un code plus court est ignoré. Pour en générer un en PowerShell :
  `$b = New-Object byte[] 36; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) -replace '[+/=]', ''`.
- **Révoquer** : `npx wrangler secret delete CODE_…`, ou changer sa valeur avec `secret put`.

### 5. Publier

```bash
npm run deploy
```

L'adresse s'affiche à la fin. Vérification : `https://<adresse>/api` répond
`{"ok":true,"data":{"service":"kilosaurus-temps"}}`.

### 6. Reprendre l'historique

Une fois, depuis l'ancienne Google Sheet :

1. Arrêtez le compteur. Dans la Sheet : **Fichier → Télécharger → Microsoft Excel (.xlsx)**, et
   posez le fichier à la racine sous le nom `export.xlsx`.
2. `py -m pip install openpyxl tzdata`
3. `py tools/migrate_d1.py export.xlsx reprise.sql`

   Le script liste les lignes « à vérifier » (sessions plus longues que le seuil d'oubli, colonne
   Heures qui ne correspond plus à Début / Fin) et refuse celles qui violent une règle de la base
   (fin avant début, session de plus de 24 h, chevauchement, compteur en cours). Une ligne se
   corrige dans la Sheet, ou s'écarte avec `--exclude id1,id2`.
4. `node tools/check_import.mjs reprise.sql` : le fichier passe les règles de la base et ses totaux
   par projet et par type sont identiques.
5. `npx wrangler d1 execute kilosaurus-temps --remote --file reprise.sql`, puis relisez le nombre
   de lignes avec la commande que `check_import` affiche.

### 7. Installer l'app

Ouvrez l'adresse de l'app, puis :

- **iPhone (Safari)** : bouton **Partager → Sur l'écran d'accueil**.
- **Android (Chrome)** : menu **⋮ → Installer l'application** (ou utilisez l'APK, plus bas).
- **PC (Chrome, Edge)** : icône d'installation dans la barre d'adresse, ou la mini-fenêtre de bureau.

Au premier lancement, l'app demande le code de l'appareil. Elle le garde ensuite.

---

## Utilisation

- **Type de travail** (Misc, Writing, Art, Dev…) : la rangée de boutons colorés. Compteur en cours,
  un tap bascule le type sans trou : le temps d'avant reste sous l'ancien type. Compteur arrêté, un
  tap choisit le type du prochain lancement.
- **Lancer** : un tap sur un projet, avec le type choisi. Si un autre compteur tourne, il se ferme
  et le nouveau démarre.
- **Stop** : ferme le compteur. **+ note** : une note sur le compteur en cours.
- **⏸ Pause** : le compteur continue, marqué pause (même projet) ; **▶ Reprendre** revient à la
  tâche d'avant. Les pauses comptent dans le total du jour (« dont N min de pause »), sont hachurées
  sur la frise et ont leur ligne dans les récaps.
- **Sessions** : un jour à la fois, avec des flèches pour reculer. Un tap sur une ligne permet de la
  supprimer, ou de corriger son début, sa fin, son projet, son type ou sa note. ⚠ signale une
  session plus longue que le seuil d'oubli (8 h). Demande le réseau.
- **Aujourd'hui** : le total du jour, compteur en cours compris, et la frise de la journée colorée
  par type. Une session commencée la veille ne compte que pour sa partie d'aujourd'hui. Les blocs
  comptent dans le total mais n'ont pas de place sur la frise.
- **Récap** : semaine (barres par jour, empilées par type) et mois (par type et par projet), avec
  flèches pour remonter le temps. Demande le réseau.
- **Déclarer 2 à 12** : un bloc d'heures pour aujourd'hui, sans début ni fin, avec le type choisi.
  **Autre jour…** : un bloc pour une date passée.
- **Oubli** : si un compteur tourne depuis plus de 8 h à l'ouverture, l'app demande l'heure de fin
  avant toute autre chose. Une session ne peut pas dépasser 24 h.
- **Point de couleur en haut à gauche** : vert synchronisé, orange en attente (hors ligne), rouge
  erreur. Un tap affiche le détail, dont la durée de la dernière réponse du serveur.
- **Hors ligne** : l'app réagit normalement. Les actions sont gardées sur l'appareil et envoyées
  au retour du réseau, avec l'heure du tap. Ces lignes sont marquées « hors ligne ».
- **Autres appareils** : l'app relit l'état toutes les 20 s quand elle est affichée ; un compteur
  lancé ailleurs apparaît vite.
- **Menu (roue dentée)** : nouveau projet, **Afficher Studio** (masqué par défaut, réglage propre à
  chaque appareil ; masqué, son historique compte quand même dans les récaps), changer de code.
- **« Accès bloqué »** : après 10 codes refusés en 15 min depuis une même adresse, cette adresse est
  refusée pendant une heure. Les autres appareils ne sont pas touchés. Si vous n'avez pas tapé de
  mauvais code vous-même, quelqu'un essaie d'en deviner un : changez vos codes. Pour débloquer sans
  attendre :
  `npx wrangler d1 execute kilosaurus-temps --remote --command "DELETE FROM lockouts"`.
- **Sauvegarde** : D1 peut remettre la base à n'importe quelle minute des 7 derniers jours :
  `npx wrangler d1 time-travel restore kilosaurus-temps --timestamp <date ISO>`.

## L'app Android (APK) et son widget

L'APK contient **l'app complète** (les mêmes écrans que la version web, embarqués dans le
téléphone) et un **widget** lecture / stop pour l'écran d'accueil, pensé pour écrire : il lance le
projet choisi en type Writing, avec la session en cours et le total du jour.

### Fabriquer l'APK

```bash
bash android/build.sh
```

Le script utilise le kit Android fourni avec Unity (`Hub/Editor/<version>/…/AndroidPlayer`), ou
`ANDROID_SDK` et `JAVA_HOME` s'ils sont définis. Il ne demande ni Gradle, ni Android Studio, ni
internet. Le fichier produit : `android/build/kilosaurus-temps.apk`.

L'adresse de l'API est `Api.DEFAULT_URL` dans `android/src/…/Api.java` : une seule source, que
`build.sh` recopie aussi dans l'app embarquée.

Au premier build, une clé de signature est créée (`android/release.keystore` et
`android/keystore.properties`). **Sauvegardez ces deux fichiers** : une mise à jour de l'app doit
être signée avec la même clé, sinon il faut désinstaller l'ancienne version. Ils ne sont jamais
commités. Pour une mise à jour, augmentez le numéro de version :
`VERSION_CODE=11 VERSION_NAME=2.1 bash android/build.sh`.

**Dépôt automatique** (facultatif) : créez `android/local.properties` avec une ligne
`apk_drop=G:/Mon Drive/KILOSAURUS/Temps` (un dossier Google Drive synchronisé, par exemple). Chaque
build y copie l'APK en remplaçant le précédent : la dernière version s'installe ensuite depuis
l'app Drive du téléphone. Ce fichier est propre à la machine et n'est jamais commité. Attention :
un build d'essai y est copié aussi.

### Installer sur un téléphone

1. Envoyez `kilosaurus-temps.apk` sur le téléphone (message, Drive, câble…) et ouvrez-le.
2. Android demande d'autoriser l'installation d'applis inconnues pour l'app qui ouvre le fichier
   (Fichiers, Drive…) : acceptez, puis **Installer**.
3. Ouvrez **Kilosaurus Temps** et saisissez votre code.

### Poser le widget

1. Appui long sur l'écran d'accueil → **Widgets** → **Kilosaurus Temps** → **Lecture / stop**
   (3 × 1 case, redimensionnable).
2. Le réglage s'ouvre : code (déjà rempli si vous vous êtes connecté dans l'app), puis **Charger mes
   projets**, choix du projet, **Enregistrer**.

Utilisation :

- **▶** lance le projet du widget en type **Writing**. **■** arrête le compteur en cours, quel que
  soit son projet ou son type.
- **En pause** (lancée depuis l'app) : le widget affiche « ⏸ En pause » et la durée de la pause. Le
  gros bouton devient **▶** et reprend la tâche d'avant la pause ; un petit **■** à côté arrête le
  compteur.
- **Aucune attente** : le widget change d'état au moment du tap, même sans réseau. Les taps partent
  derrière, un par un et dans l'ordre, chacun avec son heure ; sans réseau ils attendent et repartent
  tout seuls (toutes les minutes, au tap suivant, ou à l'ouverture de l'app).
- **Heure du serveur** : le widget mesure l'écart entre l'horloge du téléphone et celle du serveur,
  et s'en sert pour l'heure des taps et les chronos. Un téléphone qui avance ou retarde ne décale
  pas les sessions.
- **Toujours juste** : le widget se redessine au démarrage du téléphone, à un changement d'heure ou
  de fuseau, et à minuit (le total « Aujourd'hui » repart de zéro, à quelques minutes près).
- **Compteur oublié** : au-delà de 8 h, un message remplace « Aujourd'hui » ; le toucher ouvre l'app,
  qui demande l'heure de fin.
- **Toucher le nom du projet** rouvre le réglage. Toucher le message relance l'envoi ou relit l'état.
- Un compteur lancé depuis l'app apparaît tout de suite sur le widget. Lancé depuis un autre
  appareil, il apparaît au prochain tap, à l'ouverture de l'app, ou au plus tard après 30 min
  (limite d'Android).
- Un widget réglé avant la v2 garde son réglage : l'ancienne adresse (Apps Script) est remplacée
  toute seule par la nouvelle.

## La mini-fenêtre de bureau (Windows)

Une petite fenêtre sans bordure, dans un coin de l'écran, au-dessus de tout : le compteur, les
projets et les tâches (la version compacte du site, `?mini=1`). Elle se lance au démarrage de
Windows et s'ajuste à la hauteur de son contenu : son bord haut reste en place et elle grandit vers
le bas, sauf si elle sortait de l'écran (elle remonte alors juste ce qu'il faut).

```bash
cd desktop && npm install && npm start
```

Le premier lancement l'inscrit au démarrage de Windows ; il faut ensuite saisir son code une fois
(le code `PC`). Pour pouvoir la relancer à la main (raccourci **Kilosaurus Temps** sur le bureau et
dans le menu Démarrer) : `powershell -ExecutionPolicy Bypass -File desktop\install-shortcuts.ps1`.
L'adresse du site est `SITE` dans `desktop/main.js`.

Au démarrage de Windows, si le réseau n'est pas encore là, la fenêtre s'affiche quand même et
recharge la page toutes les 10 s. Les lancements et les erreurs sont notés dans
`%APPDATA%\kilosaurus-temps-desktop\desktop.log`. Si `npm install` n'a pas téléchargé Electron
(`node_modules/electron/dist` vide), lancez `node node_modules/electron/install.js`. Le démarrage
automatique pointe vers ce dossier : si le dépôt est déplacé, relancez `npm start` depuis le nouvel
emplacement.

- **Déplacer** : glisser la barre du haut. **Sessions** ouvre la fenêtre des sessions dans une
  deuxième fenêtre ; à sa fermeture, la mini-fenêtre se met à jour. **Plus d'infos ↗** ouvre la
  version complète (journée, récap, blocs) dans Brave, sinon Chrome, sinon le navigateur par défaut.
- **Icône près de l'horloge** (clic droit) : afficher / masquer, **Verrouiller la position**,
  **Toujours au-dessus**, **Lancer au démarrage**, remettre dans le coin, ouvrir en grand,
  recharger, quitter. Un clic gauche affiche ou masque la fenêtre.
- **Ctrl + Alt + K** affiche ou masque la fenêtre depuis n'importe où.
- Les réglages (position, verrou…) sont gardés dans `%APPDATA%\kilosaurus-temps-desktop\window.json`.
- Lancée depuis un terminal de VS Code, la fenêtre ne s'ouvre pas : VS Code pose
  `ELECTRON_RUN_AS_NODE`, qui fait tourner Electron comme Node. Lancez-la depuis un autre terminal,
  ou retirez d'abord cette variable.

## Ajouter un projet

Depuis l'app : **menu → + Nouveau projet**. Il se place après les autres. Les 4 premiers projets
(hors Studio s'il est masqué) ont un bouton direct, les suivants passent dans « Plus… ».

## Loguer depuis un agent Claude Code

1. Créez un code d'agent : `npx wrangler secret put CODE_AMOHS_CLAUDE` (ou
   `CODE_AMOHS_CLAUDE_PC` pour un agent par machine), avec une valeur différente des autres codes.
2. Copiez le dossier `claude/kilosaurus-temps/` dans `~/.claude/skills/` sur la machine.
3. Définissez deux variables d'environnement sur cette machine : `KILOSAURUS_TEMPS_URL` (l'adresse
   de l'app suivie de `/api`) et `KILOSAURUS_TEMPS_CODE` (le code d'agent).

L'agent a les mêmes actions que l'app, plus `logSession` : une session avec un début et une fin
quelconques (24 h au plus), refusée si elle chevauche une autre session.

## Mettre à jour

- **L'API et l'app web** : `npm run deploy` publie les deux ensemble. La nouvelle version s'affiche
  dès l'ouverture suivante de la page : le service worker charge le réseau d'abord et ne garde sa
  copie que pour le hors ligne.
- **La base** : `server/schema.sql` ne fait que créer ce qui manque ; une modification de table
  demande sa propre commande SQL.
- **L'APK** embarque sa copie du site : il faut le reconstruire et le réinstaller.

## Développement

Il faut Node 24 ou plus récent (`node:sqlite`). L'app n'a aucune dépendance.

```bash
npm test                      # serveur (règles, annulation, Worker), calculs de l'app
npm run test:py               # reprise de l'historique (Python, openpyxl, tzdata)
npm run dev                   # serveur de dev : http://localhost:8787/?dev-code=code-amohs
node tools/e2e.js [captures]  # pilote Chrome contre le serveur de dev, en taille téléphone
```

Le serveur de dev exécute le vrai `server/core.js` sur une base SQLite en mémoire. Les codes de test
sont `code-amohs` et `code-amohs-claude` (agent). `--forgot` simule un compteur oublié.
`/__phone?dev-code=…` affiche l'app dans un cadre de 375 px, `?vue=sessions` la fenêtre des
sessions seule.

Toute la logique métier est dans `server/core.js`. Elle ne parle qu'à une petite interface SQL
(`server/db.js`) que fournissent à la fois D1 et `node:sqlite` : les tests tournent sur les mêmes
requêtes que la production. Chaque écriture enregistre ses changements de lignes et une entrée du
journal `ops` dans la même transaction : c'est ce journal qui permet d'annuler.
