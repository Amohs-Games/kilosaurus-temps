# Kilosaurus Temps — sauvegardes

> S'ajoute à `2026-10-03-base-de-donnees-design.md` (la base, le journal `ops`, la suppression
> douce). Rien de ce qui existe n'est retiré.

## Objectif

Les heures enregistrées ne doivent jamais être perdues : ni par une erreur de l'app, ni par une
commande SQL malheureuse, ni par un problème du compte Cloudflare.

- **Une journée finie est figée** : au passage de 6 h, sa version est copiée dans la base et ne
  peut plus être modifiée ni effacée. Corriger une session après coup reste possible dans l'app ;
  la version d'origine reste lisible.
- **Une copie complète quitte Cloudflare chaque jour** : la mini-fenêtre de bureau la range sur le
  PC et dans Google Drive, vérifiée.
- **Une panne se voit** : si une sauvegarde ne passe plus, l'app le dit sur tous les appareils.
- **Pas de bouton d'export** : tout est automatique.

## Critères de réussite

1. Chaque journée finie a sa copie figée dans la base au plus tard à 7 h le lendemain ; une
   tentative de la modifier ou de l'effacer en SQL est refusée par la base (testé).
2. Un export complet rechargé dans une base vide redonne exactement les mêmes lignes, table par
   table (testé, à l'aller-retour).
3. Une copie de bureau dont le contenu ne correspond pas à l'empreinte annoncée par le serveur
   n'est jamais gardée (testé).
4. Si la dernière copie de bureau réussie a plus de 48 h, l'app l'affiche sur tous les appareils.
5. Aucun fichier de sauvegarde n'est jamais écrasé ni écrit à moitié.

## Les couches de protection

| Couche | Protège de | Où | État |
|---|---|---|---|
| Suppression douce + journal `ops` | une correction ou une suppression dans l'app : l'avant et l'après de chaque écriture sont gardés pour toujours | la base | existe |
| Retour dans le temps D1 | n'importe quelle erreur des 7 derniers jours, remise à la minute près | Cloudflare | existe |
| **Journées figées** | une erreur plus ancienne que 7 jours, une commande SQL qui vide une table | la base | nouveau |
| **Copie de bureau** | la perte de la base ou du compte Cloudflare | PC + Google Drive | nouveau |

Pourquoi pas une copie complète vers une deuxième base, ni un envoi direct du serveur vers Drive :

- Sur l'offre gratuite, un Worker a **10 ms de calcul** par appel, cron compris. Copier toute la
  base d'une base D1 à une autre fait passer chaque ligne par le Worker : ça tient aujourd'hui
  (53 lignes) et casse le jour où l'historique grossit. La copie figée se fait en SQL, dans la base
  même (`INSERT … SELECT`) : le Worker ne fait qu'envoyer la requête, le coût ne grandit pas avec
  l'historique.
- Le stockage de fichiers de Cloudflare (R2) demande une carte bancaire, même gratuit. Un envoi
  vers Google Drive demande une autorisation OAuth qui expire ou se révoque : la sauvegarde
  s'arrêterait sans bruit.

## 1. Journées figées (serveur)

### Tables

Une table d'archive par table de données, même colonnes, plus le jour figé :

- `archive_entries` — `archived_day` (aaaa-mm-jj) + toutes les colonnes d'`entries`. Clé :
  (`archived_day`, `id`).
- `archive_days` — une ligne par jour figé : `day`, `archived_ms`, `rows` (nombre de lignes
  copiées), `hours` (total d'heures du jour, sessions et blocs, au moment de figer).

Les tâches (conception à venir) auront leur `archive_tasks` sur le même modèle.

**Protection** : des triggers SQLite refusent tout `UPDATE` et tout `DELETE` sur ces tables
(`RAISE(ABORT, …)`). Seul un `DROP` volontaire, fait à la main, peut les retirer — et la copie de
bureau, elle, est hors de portée.

### Quand

- Un **Cron Trigger** appelle le Worker toutes les heures (`5 * * * *`).
- À chaque appel, il fige **chaque jour fini pas encore figé** : un jour J est fini quand il est
  6 h passées le lendemain (fuseau de Paris). Un appel raté est rattrapé au suivant ; le passage à
  l'heure d'été ou d'hiver ne pose pas de problème.
- Ce qui est copié pour le jour J : les lignes d'`entries` dont `day` = J, **supprimées comprises**
  (avec leur `deleted_ms`), telles qu'elles sont à ce moment-là.
- Une seule écriture groupée (`batch`) par jour : les lignes et la ligne `archive_days` entrent
  ensemble ou pas du tout. Rejouer ne double rien : un jour déjà présent dans `archive_days` est
  sauté, et la clé de `archive_entries` refuserait de toute façon une deuxième copie.
- Premier passage : tous les jours passés de l'historique sont figés d'un coup, un `batch` par
  jour.

### Lire une version d'origine

Pas d'écran dédié. Une action d'API `archivedDay { day }` renvoie les lignes figées du jour, pour
l'agent ou pour une restauration à la main.

## 2. Copie de bureau (mini-fenêtre)

### Ce que fait la mini-fenêtre

1. **Au lancement, puis toutes les heures**, si la copie du jour de travail (6 h → 6 h) n'existe
   pas encore dans les deux dossiers : elle la fait.
2. Elle utilise le code d'accès qu'elle a déjà (code `PC`).
3. Elle demande l'export **table par table, par pages de 500 lignes** (action `export`) : chaque
   appel reste petit, quelle que soit la taille de l'historique.
4. Elle demande au serveur l'**empreinte** de la base (action `exportCheck`) : pour chaque table,
   le nombre de lignes et des sommes calculées par la base elle-même (somme des `touched_ms`,
   des `start_ms`, des `end_ms`, longueur totale des notes…). Elle recalcule les mêmes valeurs sur
   ce qu'elle a reçu. Si une seule diffère (une écriture est tombée pendant l'export, une page a
   manqué), elle jette tout et recommence au tour suivant.
5. Elle écrit le fichier **à côté** (`….tmp`), le relit, vérifie qu'il redonne la même
   empreinte, puis le **renomme** à son nom définitif. Jamais d'écrasement : si le nom existe,
   rien n'est écrit.
6. Même chose dans le second dossier.
7. Quand les deux dossiers ont leur copie, elle le signale au serveur (action `backupDone`, avec
   le jour et l'empreinte).

### Le fichier

- Nom : `kilosaurus-temps_aaaa-mm-jj.json.gz` (jour de travail).
- Contenu : toutes les tables (`projects`, `settings`, `entries` supprimées comprises, `ops`,
  `archive_days`, `archive_entries`), l'empreinte, la date de l'export, la version du schéma.
  `lockouts` n'est pas copiée (sans valeur).
- Compressé (gzip, fourni par Node) : quelques dizaines de Ko aujourd'hui.
- **Tout est gardé**, sans limite. À revoir si le dossier dépasse 1 Go.

### Les dossiers

- PC : `Documents\PROJECTS\KILOSAURUS\Sauvegardes\` (hors du dépôt, qui est public).
- Google Drive : `G:\Mon Drive\KILOSAURUS\Temps\Sauvegardes\`.
- Les deux chemins sont réglables dans `window.json`. Si Drive n'est pas monté, la copie PC est
  faite quand même, Drive est retentée à l'heure suivante, et `backupDone` n'est pas envoyé tant
  que les deux ne sont pas là.
- Chaque tentative, réussie ou non, est notée dans `desktop.log`.

## 3. Alerte

- `status` renvoie `backup` : date de la dernière copie de bureau complète, dernier jour figé.
- L'app affiche un bandeau orange en haut, sur tous les appareils :
  - « Pas de sauvegarde sur le PC depuis N jours » si la dernière copie de bureau a plus de 48 h ;
  - « Journées non figées depuis le JJ/MM » si un jour fini depuis plus de 2 h n'est pas figé.
- Le bandeau ne se ferme pas : il disparaît quand la sauvegarde repasse.
- `backupDone` est une écriture de réglage : elle ne passe pas par le journal `ops` et n'est pas
  « annulable » (elle ne doit pas devenir la dernière action que l'agent annulerait).

## 4. Restauration

- `tools/restore.mjs <fichier.json.gz> <sortie.sql>` : vérifie l'empreinte du fichier, puis écrit
  le SQL qui recharge toutes les tables dans une base vide.
- La procédure est dans le README : créer une base D1 neuve, appliquer `schema.sql`, exécuter le
  SQL produit, relire les comptes, pointer `wrangler.toml` dessus.
- Le test d'aller-retour (critère 2) passe par ce script : export depuis la base de test →
  restauration dans une base `node:sqlite` vide → comparaison ligne à ligne.

## 5. API

| Action | Écrit | Rôle |
|---|---|---|
| `export { table, after, limit }` | non | une page de lignes d'une table, triée par clé |
| `exportCheck` | non | l'empreinte de chaque table, calculée en SQL |
| `backupDone { day, check }` | réglage | note la dernière copie de bureau complète |
| `archivedDay { day }` | non | les lignes figées d'un jour |

Le Worker gagne un point d'entrée `scheduled` (le cron) qui appelle la fonction qui fige les
jours, dans `core.js` comme le reste des règles.

## 6. Sauvegarde manuelle avant la mise en service

Faite le 2026-10-08 à 18 h 51 avec `npx wrangler d1 export kilosaurus-temps --remote` :
`Documents\PROJECTS\KILOSAURUS\Sauvegardes\kilosaurus-temps_2026-10-08_1851_manuelle.sql`, copie
identique (SHA-256) dans `G:\Mon Drive\KILOSAURUS\Temps\Sauvegardes\`. Rechargée dans une base
vide : mêmes comptes que la base en ligne (3 projets, 4 réglages, 53 lignes dont 51 actives,
79 actions au journal). La même commande refait une sauvegarde à la main avant toute
modification du schéma.

## 7. Tests

- Figer : un jour fini est copié une fois ; un jour pas fini (avant 6 h le lendemain) ne l'est
  pas ; rejouer ne double rien ; un jour raté est rattrapé ; `UPDATE` et `DELETE` sur l'archive
  sont refusés.
- Export : les pages couvrent toute la table sans trou ni doublon ; l'empreinte recalculée côté
  client égale celle du serveur ; une écriture entre l'export et la vérification fait échouer la
  vérification.
- Restauration : aller-retour identique.
- Mini-fenêtre : la logique de copie (pages, empreinte, écriture à côté puis renommage, pas
  d'écrasement) vit dans un module sans Electron, testé avec un faux serveur et un dossier
  temporaire.

## Hors périmètre

- Restaurer depuis l'app : la restauration reste une opération à la main, documentée.
- Écran pour consulter les journées figées.
- Les tâches : leur table d'archive suivra leur conception.
