# PRD - Sanem (v3)

Service web auto-hébergé permettant à des amis distants d'envoyer de gros fichiers
(animes, ~1,5 Go en moyenne) par drag & drop dans le navigateur, vers le PC de l'hôte,
puis de **consulter et regarder** ce qui a été déposé, exposé publiquement via Tailscale
Funnel.

Nom : « Sanem » (vanuatais : *envoyer, faire parvenir*). Les deux modes de l'interface
portent également des termes vanuatais : **Putum** (*poser, mettre*) pour le dépôt, et
**Lukluk** (*regarder*) pour la consultation.

**Ce document est une spécification d'implémentation contraignante.** Il est écrit pour
être exécuté par un agent IA de développement sans connaissance préalable du projet. Les
choix techniques y sont **verrouillés** : là où le document dit « imposé », il n'y a pas
d'alternative acceptable. Toute déviation doit être validée par le propriétaire du projet
avant d'être codée.

### Ce qui change par rapport à la v2

La v2 ne faisait que **recevoir**. La v3 ajoute un second parcours : **consulter, regarder
et télécharger** ce qui a été déposé. Trois interdits de la v2 sont levés (téléchargement
depuis l'UI, prévisualisation vidéo, arborescence de dossiers) et un modèle de menace
change de nature (§8). Les fondations de la v2 - protocole tus, stockage, nettoyage,
authentification - ne bougent pas.

## 1. Objectif produit

### Parcours 1 - déposer (existant, inchangé)

Un ami distant (aucune compétence technique, Tailscale non installé chez lui) ouvre une
URL publique, saisit un mot de passe partagé, dépose des fichiers dans une zone centrale,
et voit leur progression jusqu'à la fin du transfert. L'upload **reprend automatiquement
après une coupure réseau**, sans repartir de zéro. L'hôte récupère les fichiers dans
`~/sanem-data/uploads/`.

### Parcours 2 - regarder (nouveau en v3)

Après authentification, l'utilisateur choisit entre les deux modes. En mode **Lukluk**, il
voit une vidéothèque : une mise en avant du contenu le plus récent, puis des rangées
horizontales de vignettes (reprendre la lecture, séries, nouveautés, tout). Il clique sur
une vidéo, elle se lit dans un lecteur plein écran avec les contrôles usuels, et l'épisode
suivant de la même série s'enchaîne à la fin. Les fichiers non lisibles dans un navigateur
restent listés et téléchargeables.

Un **dossier de premier niveau dans `uploads/` est une série** : c'est la seule notion
d'organisation, et elle est volontairement plate (§9).

### Hors périmètre v3 (ne pas implémenter)

Suppression de fichiers par les amis, liens de partage par fichier, notifications, comptes
nominatifs, quota disque, politique de rétention des fichiers **finalisés**, arborescence
de profondeur supérieure à un niveau, transcodage accéléré matériellement (§10),
synchronisation des positions de lecture entre appareils.

> Le nettoyage de `tmp/` et la purge du cache de transcodage (§7) ne sont **pas** une
> politique de rétention : c'est de l'hygiène de stockage, et c'est **obligatoire**.

## 2. Décisions verrouillées

| Sujet               | Décision imposée                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Runtime             | Node.js 22 LTS (`node:22-alpine`). `@tus/server` exige `node >= 20.19`.                                                    |
| Framework HTTP      | **Express 5**. Pas de Fastify.                                                                                             |
| Serveur d'upload    | **`@tus/server` + `@tus/file-store`**, in-process. Pas de binaire `tusd` séparé.                                           |
| Protocole d'upload  | **tus** (resumable). Interdiction absolue de le remplacer par du multipart maison.                                         |
| Route tus           | **`/files`**. Pas `/uploads`.                                                                                              |
| Frontend            | **Uppy v5** via bundle CDN, chargé par `<script>`. Pas de bundler, pas de React/Vue/Svelte.                                |
| UI upload           | **`@uppy/dashboard`** (inclus dans le bundle), thème sombre.                                                               |
| Style visuel        | **Néon** (fond sombre, accents vifs, glow sur les barres de progression). L'alternative « zen » est **rejetée**.           |
| Lecteur vidéo       | Balise **`<video>` native** pilotée par une barre de contrôle maison. Pas de Video.js, Plyr, Shaka ou autre lecteur tiers. |
| Lecture adaptative  | **`hls.js`** via CDN épinglé, pour les sources qui passent par le transcodage (§10). Natif sur Safari/iOS.                 |
| Outil média         | **`ffmpeg` et `ffprobe`**, invoqués par `execFile` avec un tableau d'arguments. **Jamais** via un shell.                   |
| Découpage transcode | **HLS segmenté**. Un flux `ffmpeg` unique est **rejeté** : il casse le positionnement (§10).                               |
| Encodage            | **`libx264` logiciel** uniquement. Aucune accélération matérielle (VAAPI, NVENC, QSV) dans cette version.                  |
| Authentification    | Mot de passe unique partagé + cookie de session signé. Pas de comptes.                                                     |
| Exposition          | **Tailscale Funnel**. Pas de Caddy/Nginx.                                                                                  |
| Stockage            | `~/sanem-data/` sur l'hôte, monté en volume Docker.                                                                        |
| Conteneurisation    | Docker + `docker compose`. Obligatoire.                                                                                    |
| Port local          | **3900** par défaut (hors plage 8080-8090 déjà occupée), configurable.                                                     |
| Langue              | UI en français. Code, commentaires et `AGENTS.md` en anglais.                                                              |

## 3. Arborescence imposée

L'agent doit produire exactement cette structure. Ni plus (pas de fichiers « bonus »), ni
moins. Le `Makefile` est la seule exception approuvée hors de cette liste (confort
opérationnel, ajouté sur demande du propriétaire).

```
sanem/
├── AGENTS.md                 # contexte agent (voir §15)
├── CLAUDE.md                 # symlink -> AGENTS.md
├── README.md                 # doc humaine (voir §15)
├── PRD.md                    # ce document
├── Makefile                  # exception approuvée
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .dockerignore
├── .gitignore
├── package.json
├── eslint.config.js
├── src/
│   ├── server.js             # bootstrap Express, montage des routes, démarrage
│   ├── config.js             # lecture + validation des variables d'env (fail fast)
│   ├── auth.js               # middleware session, POST /api/login, /api/logout, /api/session
│   ├── tus.js                # instanciation @tus/server, hook onUploadFinish
│   ├── files.js              # GET /api/files, listing arborescent + métadonnées média
│   ├── filename.js           # sanitisation + déduplication des chemins (§9)
│   ├── media.js              # GET /api/media, GET /api/download - lecture directe + Range
│   ├── transcode.js          # ffprobe, matrice de compatibilité, HLS à la demande (§10)
│   ├── thumbs.js             # extraction et cache des vignettes (§10)
│   └── cleanup.js            # nettoyage de tmp/ et purge du cache transcode/ (§7)
├── public/
│   ├── index.html            # page unique + sprite d'icônes #i-* (§11.5)
│   ├── favicon.svg           # marque Sanem, variante 16 px (§11.5)
│   ├── app.js                # routeur d'écrans, dépôt Uppy, vidéothèque
│   ├── player.js             # lecteur vidéo : contrôles, zones tactiles, épisode suivant
│   └── style.css             # thème néon + points de rupture responsive
└── test/
    ├── filename.test.js      # tests unitaires de sanitisation (§12)
    ├── media.test.js         # tests d'intégration de la lecture (§12)
    ├── resume.test.js        # test d'intégration reprise sur coupure (§12)
    ├── player-ui.test.js     # E2E Chrome : overlay, hamburger, plein écran téléphone
    └── fixtures/
        └── clip.mp4          # fixture H.264/AAC pour player-ui.test.js
```

## 4. Dépendances épinglées

`package.json` doit utiliser des versions **exactes** (pas de `^` ni `~`) :

```json
{
  "name": "sanem",
  "version": "1.0.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test",
    "lint": "eslint ."
  },
  "dependencies": {
    "@tus/file-store": "2.1.1",
    "@tus/server": "2.4.4",
    "cookie-parser": "1.4.7",
    "express": "5.2.1",
    "express-rate-limit": "8.6.2"
  },
  "devDependencies": {
    "eslint": "9.39.5",
    "tus-js-client": "4.3.1"
  }
}
```

**Aucune dépendance npm nouvelle en v3.** `ffmpeg` et `ffprobe` sont des binaires système
fournis par l'image Docker (§14), pas des paquets npm : aucun wrapper du type
`fluent-ffmpeg` n'est autorisé, l'invocation se fait directement avec
`node:child_process`.

Frontend, épinglé dans `public/index.html` (Uppy s'expose sur `window.Uppy`, hls.js sur
`window.Hls`) :

```html
<link rel="stylesheet" href="https://releases.transloadit.com/uppy/v5.2.4/uppy.min.css">
<script src="https://releases.transloadit.com/uppy/v5.2.4/uppy.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js"></script>
```

> Avant de coder, l'agent doit vérifier les signatures d'API réelles des versions
> installées (notamment `onUploadFinish` de `@tus/server`, dont la signature a changé
> entre les majeures) et la version réellement disponible de `hls.js`. Les extraits de ce
> PRD sont indicatifs sur la forme, contraignants sur l'intention.

## 5. Variables d'environnement

| Variable                   | Obligatoire | Défaut     | Description                                                                                                                                                                                                                            |
| -------------------------- | ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANEM_PASSWORD`           | oui         | aucun      | Mot de passe partagé. **Crash au démarrage si absent ou < 5 caractères.** Seuil bas assumé pour le POC ; compensé par le rate limiting du §8. **Lire l'avertissement du §8 sur le modèle de menace v3 avant de choisir cette valeur.** |
| `SANEM_SESSION_SECRET`     | oui         | aucun      | Secret de signature des cookies. **Crash au démarrage si absent ou < 32 caractères.** Jamais généré à la volée (invaliderait les sessions à chaque redémarrage).                                                                       |
| `SANEM_PORT`               | non         | `3900`     | Port d'écoute local.                                                                                                                                                                                                                   |
| `SANEM_DATA_DIR`           | non         | `/data`    | Racine de stockage dans le conteneur.                                                                                                                                                                                                  |
| `SANEM_TMP_TTL_HOURS`      | non         | `48`       | Âge au-delà duquel un upload inachevé est considéré orphelin (§7).                                                                                                                                                                     |
| `SANEM_MAX_FILE_GB`        | non         | `20`       | Refus au-delà, côté client et serveur.                                                                                                                                                                                                 |
| `SANEM_TRANSCODE_CACHE_GB` | non         | `20`       | Taille maximale du cache `transcode/`. Au-delà, purge LRU (§7).                                                                                                                                                                        |
| `SANEM_FFMPEG_CONCURRENCY` | non         | `1`        | Nombre maximum de processus `ffmpeg` simultanés. **Ne pas augmenter sans raison** : les uploads restent la fonction principale du service (§10).                                                                                       |
| `SANEM_X264_PRESET`        | non         | `veryfast` | Preset `libx264` de la voie 3 (§10). Valeurs acceptées : les presets x264 standard.                                                                                                                                                    |

`src/config.js` valide tout au démarrage et **termine le process avec un message
explicite** si une contrainte est violée. Aucune variable hors de ce tableau ne doit être
introduite. Toute variable ajoutée doit exister simultanément dans ce tableau, dans
`.env.example` et dans `src/config.js`.

## 6. Stockage

```
$SANEM_DATA_DIR/
├── uploads/            # fichiers finalisés, source de vérité
│   ├── <série>/        # dossier de premier niveau = une série (§9)
│   │   └── <fichier>
│   └── <fichier>       # fichier hors série, à la racine
├── tmp/                # uploads en cours (géré par @tus/file-store) - doit rester propre
├── thumbs/             # vignettes JPEG extraites par ffmpeg - cache régénérable
└── transcode/          # segments HLS produits à la demande - cache régénérable
```

Les quatre répertoires sont créés au démarrage s'ils n'existent pas. `tmp/` et `uploads/`
sont sur le même système de fichiers, ce qui rend la finalisation atomique par
`fs.rename()` (prévoir un repli copie + suppression en cas d'`EXDEV`).

**`thumbs/` et `transcode/` sont des caches, jamais une source de vérité.** Les supprimer
entièrement ne doit provoquer aucune perte de donnée : le service les régénère. Aucun
fichier de ces deux répertoires n'est listé par `GET /api/files`.

### Profondeur d'arborescence

`uploads/` accepte **exactement un niveau de dossier**. Tout chemin plus profond est
aplati par la sanitisation du §9. Cette limite est délibérée : elle couvre le cas « une
saison, des épisodes » sans transformer Sanem en explorateur de fichiers.

### Finalisation d'un upload

Dans le hook `onUploadFinish` :

1. Calculer le chemin final via `src/filename.js` (§9).
1. Créer le dossier de série s'il n'existe pas encore (`fs.mkdir` avec `recursive: false`
   après la sanitisation, pour ne jamais créer une profondeur non voulue).
1. `fs.rename(tmp/<id>, uploads/<série>/<nom-final>)`.
1. **Supprimer le sidecar de métadonnées** `tmp/<id>.json` créé par `@tus/file-store`.
1. Vérifier qu'aucun résidu portant `<id>` ne subsiste dans `tmp/`, et logger l'opération.
1. **Déclencher l'analyse média de manière non bloquante** : `ffprobe` puis extraction de
   la vignette (§10). La réponse tus ne doit **jamais** attendre ces travaux.

**Invariant vérifiable** : après un upload réussi, `tmp/` ne contient aucune trace de cet
upload, et la réponse tus est renvoyée sans avoir attendu `ffprobe`.

## 7. Nettoyage (obligatoire)

### 7.1 `tmp/`

Aucun fichier orphelin ne doit subsister. Trois mécanismes complémentaires, tous requis :

1. **À la finalisation** - suppression immédiate du fichier temporaire et de son sidecar
   `.json` (§6).
1. **Expiration tus** - `FileStore` configuré avec une période d'expiration égale à
   `SANEM_TMP_TTL_HOURS`, et appel périodique du nettoyage intégré de `@tus/server`
   (toutes les heures via `setInterval`, `unref()` sur le timer pour ne pas bloquer
   l'arrêt du process).
1. **Balayage filet de sécurité** - `src/cleanup.js` parcourt `tmp/` et supprime tout
   fichier dont la `mtime` dépasse `SANEM_TMP_TTL_HOURS`, ainsi que son `.json` associé.
   Ce balayage couvre les cas que l'expiration tus ne voit pas (crash en cours d'écriture,
   sidecar corrompu, fichier écrit hors protocole).

Le balayage 3 s'exécute **au démarrage** puis toutes les heures. Sans passe au démarrage,
un crash laisse des orphelins de 1,5 Go indéfiniment.

Chaque suppression est journalisée (`nom, taille, âge`). Un upload interrompu mais
**encore dans sa fenêtre de TTL ne doit jamais être supprimé** : c'est exactement ce qui
permet la reprise.

### 7.2 `transcode/`

- Purge **LRU** dès que la taille totale dépasse `SANEM_TRANSCODE_CACHE_GB` : supprimer
  les segments les moins récemment lus jusqu'à repasser sous le seuil.
- Purge de l'intégralité des segments d'un média dont le fichier source a disparu de
  `uploads/`, ou dont la `mtime` a changé.
- Le balayage tourne au démarrage puis toutes les heures, dans le même `setInterval` que
  celui de `tmp/`.
- Ne jamais purger les segments d'un média en cours de lecture dans la minute écoulée.

### 7.3 `thumbs/`

- Une vignette est nommée par un hash du chemin relatif du média.
- Elle est invalidée et régénérée si la `mtime` du média source change.
- Elle est supprimée si le média source a disparu.

## 8. API backend

| Méthode | Route                  | Auth | Description                                                                                                |
| ------- | ---------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `GET`   | `/`                    | non  | Sert `public/index.html`. La page décide seule quoi afficher via `/api/session`.                           |
| `GET`   | `/api/session`         | non  | `{ authenticated: boolean }`. Permet à l'UI de choisir l'écran de connexion ou l'application.              |
| `POST`  | `/api/login`           | non  | Body `{ password }`. Si correct : pose le cookie de session, renvoie `204`. Sinon `401`. **Rate-limité.**  |
| `POST`  | `/api/logout`          | oui  | Détruit la session, renvoie `204`.                                                                         |
| `GET`   | `/api/files`           | oui  | Listing arborescent enrichi, voir ci-dessous.                                                              |
| `GET`   | `/api/media/*splat`    | oui  | Lecture directe du média, avec support de `Range` et réponse `206` (§10, voie 0).                          |
| `GET`   | `/api/hls/*splat`      | oui  | Playlist `.m3u8` et segments `.ts` produits à la demande (§10, voies 1 à 3).                               |
| `GET`   | `/api/thumbs/*splat`   | oui  | Vignette JPEG. `404` tant qu'elle n'a pas été produite, l'UI retombe alors sur son dégradé de secours.     |
| `GET`   | `/api/download/*splat` | oui  | Téléchargement du fichier d'origine, avec `Content-Disposition: attachment`. Support de `Range` également. |
| `ALL`   | `/files` et `/files/*` | oui  | Endpoint tus.                                                                                              |

Les quatre routes média sont montées **derrière le middleware de session** et **après** la
route tus, pour ne jamais interférer avec elle. Elles utilisent toutes le wildcard nommé
d'Express 5 (`*splat`) et **réappliquent l'assertion de confinement du §9** sur le chemin
demandé.

### Réponse de `GET /api/files`

```json
[
  {
    "path": "Anime - Frieren/S01E01.mkv",
    "dir": "Anime - Frieren",
    "name": "S01E01.mkv",
    "size": 1503238553,
    "uploadedAt": "2026-09-02T10:14:00.000Z",
    "kind": "video",
    "duration": 1448.2,
    "playback": "hls",
    "ready": true
  }
]
```

- Trié par `path`, ordre alphabétique **locale-aware et numérique** (`Intl.Collator` avec
  `numeric: true`). Cet ordre **est** l'ordre de lecture des épisodes (§10) : il ne doit
  plus être modifié sans en mesurer l'effet sur l'enchaînement.
- `dir` vaut `null` pour un fichier à la racine.
- `kind` : `"video"` ou `"other"`.
- `playback` : `"direct"` (voie 0), `"hls"` (voies 1 à 3) ou `"none"` (non lisible).
- `ready` : `false` tant que `ffprobe` n'a pas encore analysé le fichier. L'UI affiche
  alors « analyse en cours » et n'autorise pas la lecture.
- Les fichiers cachés (commençant par un point) et les répertoires `tmp/`, `thumbs/`,
  `transcode/` sont ignorés.

### Session

- Cookie signé via `cookie-parser`, flags **`HttpOnly`, `Secure`, `SameSite=Lax`**,
  expiration 30 jours.
- Comparaison du mot de passe en **temps constant** (`crypto.timingSafeEqual` sur des
  digests SHA-256, pour éviter la fuite de longueur).
- `express-rate-limit` sur `/api/login` : **10 tentatives par IP et par 15 minutes**,
  réponse `429` au-delà, **plus un plafond global de 50 tentatives échouées par heure
  toutes IP confondues** (le service n'a qu'un seul utilisateur légitime à la fois, donc
  ce plafond ne gêne jamais l'usage normal et neutralise le bruteforce distribué).
- Ce rate limiting est le **seul rempart réel** : le mot de passe peut descendre à 5
  caractères (§5, choix assumé pour le POC), sur un service exposé en public. Il ne doit
  jamais être désactivé, ni contourné en environnement de développement, ni assoupli sans
  validation explicite du propriétaire du projet.
- Les tentatives échouées sont journalisées (horodatage + IP) pour permettre de détecter
  un bruteforce en cours.
- Toutes les routes protégées, **`/files`, `/files/*` et les quatre routes média
  comprises**, sont couvertes par le même middleware de session. Un client sans cookie
  valide ne doit pouvoir ni initier un upload, ni poursuivre un upload, ni lire un média,
  ni télécharger.
- La balise `<video>` et `hls.js` émettent des requêtes **same-origin**, donc le cookie de
  session part automatiquement. **Aucun jeton d'accès ne doit apparaître dans une URL de
  média** : ni en paramètre de requête, ni dans le chemin.

### Modèle de menace v3 - risque assumé

En v2, Sanem ne faisait que recevoir : le pire cas, pour qui devinait le mot de passe,
était de déposer des fichiers indésirables.

**À partir de la v3, quiconque connaît le mot de passe partagé peut lire et télécharger la
totalité des fichiers déposés, y compris ceux déposés par d'autres.** Le mot de passe
n'est plus seulement une autorisation d'écriture : c'est la seule protection en lecture de
l'ensemble du contenu.

Ce risque est **connu et assumé** pour ce POC. Le minimum de 5 caractères du §5 est
maintenu et le mode Lukluk n'est pas restreint derrière une condition supplémentaire. En
conséquence :

- Le rate limiting ci-dessus reste l'unique rempart, et son assouplissement devient
  d'autant plus inacceptable.
- Le propriétaire du projet est responsable du choix d'un mot de passe à la hauteur de ce
  qu'il expose, et non du minimum technique autorisé par `src/config.js`.
- Cet avertissement doit être repris **mot pour mot dans `README.md` et en commentaire
  au-dessus de `SANEM_PASSWORD` dans `.env.example`** : c'est là qu'il sera lu au moment
  où il compte.

## 9. Sanitisation des chemins (sécurité)

Le nom **et le chemin relatif** proviennent des métadonnées tus, donc **du client, donc
non fiables**. C'est la brique la plus sensible du projet : elle a été réécrite en v3 pour
accepter un niveau de dossier, ce qui élargit la surface d'attaque.

`src/filename.js` expose une fonction qui reçoit `upload.metadata.filename` et
`upload.metadata.relativePath` (optionnel) et renvoie un couple `(dossier, nom)`.

### 9.1 Découpage

1. Prendre `relativePath` s'il est présent et non vide, sinon `filename`.
1. Découper sur `/` **et** `\` (un client Windows envoie des antislashs).
1. Écarter les segments vides, `"."` et `".."`.
1. Le **dernier** segment est le nom de fichier. L'**avant-dernier**, s'il existe, est le
   dossier de série. **Tous les autres segments sont ignorés** : c'est l'aplatissement à
   un niveau imposé par le §6. `a/b/c/d.mkv` devient donc `c/d.mkv`.

### 9.2 Normalisation, appliquée à chaque segment indépendamment

1. Normaliser en NFC.
1. Remplacer tout caractère hors `[lettres, chiffres, . _ - espace]` par `_`.
1. Réduire les espaces multiples et couper les espaces de début et de fin.
1. Tronquer à 200 caractères, **en préservant l'extension** pour le nom de fichier.
1. **Rejeter tout segment commençant par un point** (il créerait un fichier ou un dossier
   caché, que le listing ignore ensuite : le fichier serait écrit mais invisible).
1. Un nom de fichier vide après ces étapes devient `"sans-nom"`. Un dossier vide après ces
   étapes est **abandonné** : le fichier part à la racine de `uploads/`.

### 9.3 Déduplication

En cas de collision, insérer un suffixe `-2`, `-3`… **avant l'extension**. La collision
s'évalue **dans le dossier cible**, jamais à la racine : `Frieren/S01E01.mkv` et
`Vanuatu/S01E01.mkv` coexistent sans suffixe.

### 9.4 Assertion finale, imposée

Après construction du chemin candidat, et **avant toute écriture** :

1. Résoudre le chemin absolu du **répertoire parent** avec `fs.realpath` (le fichier
   n'existe pas encore, mais son dossier oui après création).
1. Vérifier que ce chemin réel **commence par le chemin réel de `uploads/` suivi du
   séparateur**.
1. Vérifier que la profondeur relative ne dépasse pas un niveau.
1. En cas d'échec, **rejeter l'upload et logger une alerte**. Ne jamais tenter de «
   corriger » le chemin à la volée.

> L'assertion porte sur le chemin **réel**, pas seulement normalisé. Une comparaison sur
> le chemin normalisé laisse passer un lien symbolique déjà présent dans `uploads/` : un
> dossier de série qui pointe ailleurs permettrait alors d'écrire hors du volume. Ce cas
> n'existait pas en v2, où `uploads/` était plat.

### 9.5 La lecture est une seconde surface d'attaque

`src/media.js`, `src/transcode.js` et `src/thumbs.js` reçoivent un chemin **fourni par le
client dans l'URL**. Chacun doit **réappliquer l'assertion 9.4** avant d'ouvrir quoi que
ce soit, et répondre `404` en cas d'échec (jamais `403`, qui confirmerait l'existence
d'une cible). Décoder l'URL avant l'assertion, pas après : `%2e%2e%2f` doit être vu comme
`../`.

## 10. Lecture vidéo et transcodage

### 10.1 Le problème

Un navigateur ne lit pas « une vidéo » : il lit un jeu restreint de conteneurs et de
codecs, essentiellement **MP4 / H.264 / AAC** et **WebM / VP9 ou AV1 / Opus**. Le cas
d'usage principal de Sanem, ce sont des animes en `.mkv`, souvent avec des pistes audio
AC-3 ou DTS, parfois en HEVC : précisément la famille qui ne passe pas nativement. Un
lecteur parfaitement codé donnerait un écran noir, ou une image sans son.

### 10.2 Matrice de compatibilité, imposée

Après finalisation d'un upload (§6), `ffprobe` lit le conteneur, le codec vidéo, le codec
audio, la durée et les pistes de sous-titres. Le résultat est mis en cache et détermine la
voie de lecture. **« Transcodage à la volée » ne signifie pas « ré-encoder
systématiquement »** : il faut toujours choisir la voie la moins coûteuse qui fonctionne.

| Voie  | Condition                         | Traitement                              | Coût CPU  | `playback` |
| ----- | --------------------------------- | --------------------------------------- | --------- | ---------- |
| **0** | MP4 + H.264 + AAC                 | Servir le fichier tel quel avec `Range` | nul       | `direct`   |
| **1** | Autre conteneur, mais H.264 + AAC | Remux `-c copy` vers HLS                | quasi nul | `hls`      |
| **2** | Vidéo H.264, audio AC-3/DTS/autre | `-c:v copy -c:a aac`                    | faible    | `hls`      |
| **3** | HEVC, AV1, VC-1, VP8, etc.        | Ré-encodage `libx264` + `aac`           | **élevé** | `hls`      |

Un fichier non vidéo, ou dont `ffprobe` échoue, reçoit `playback: "none"` : il reste listé
et téléchargeable, sans bouton de lecture.

### 10.3 Découpage HLS

Le découpage en segments est **imposé** pour les voies 1 à 3. Un flux `ffmpeg` unique est
explicitement rejeté : il ne sait pas se positionner, chaque déplacement dans la barre de
progression relance le processus depuis le début, et la durée annoncée au navigateur est
fausse.

- La **playlist** `.m3u8` est calculée d'avance, sans lancer d'encodage, à partir des
  informations de `ffprobe`.
- Chaque **segment** est produit à la demande lors de sa première requête, puis mis en
  cache dans `transcode/<hash>/`. Se positionner coûte donc **un segment**, pas le fichier
  entier. Une seconde lecture ou une reprise ne recalcule rien.
- **Voies 1 et 2 (vidéo copiée)** : les frontières de segment doivent tomber sur des
  images clés, sinon le flux copié est illisible. La playlist est donc construite à partir
  de la **liste réelle des images clés** lue par `ffprobe`, avec des `EXTINF` de durée
  variable. Ne pas supposer des segments de durée fixe sur ces voies.
- **Voie 3 (ré-encodage)** : l'intervalle d'images clés est forcé, ce qui permet des
  segments réguliers de **6 secondes**.
- La playlist est de type `VOD` et se termine par `#EXT-X-ENDLIST` : le lecteur connaît la
  durée totale dès la première requête, la barre de progression est donc juste avant même
  d'avoir produit un seul segment.

### 10.4 Invocation de ffmpeg

- **`execFile` avec un tableau d'arguments, jamais une chaîne passée au shell.** Le nom de
  fichier vient du client : une interpolation dans une commande shell serait une exécution
  de code à distance.
- Le chemin d'entrée est celui validé par l'assertion du §9.4, jamais celui reçu brut.
- **Au plus `SANEM_FFMPEG_CONCURRENCY` processus simultanés** (défaut : 1), gérés par une
  file d'attente interne. Les uploads restent la fonction principale du service : le
  transcodage ne doit jamais leur disputer la machine.
- Tout processus `ffmpeg` dont le client s'est déconnecté est tué. Un segment abandonné en
  cours d'écriture est écrit sous un nom temporaire puis renommé, pour qu'un segment
  partiel ne soit jamais servi depuis le cache.
- `stderr` de ffmpeg est journalisé en cas de code de sortie non nul, tronqué.

### 10.5 Encodage logiciel, conséquence assumée

L'encodage est en **`libx264` logiciel** (§2), avec `SANEM_X264_PRESET` à `veryfast` par
défaut. Aucune accélération matérielle n'est implémentée dans cette version.

Un CPU de bureau moderne tient le temps réel en 1080p sur la voie 3, **mais pas en 4K**.
Conséquence directe, à assumer dans l'UI plutôt qu'à masquer :

- Si `ffprobe` annonce une source en **voie 3 au-delà de 1080p**, le champ `playback`
  reste `"hls"` mais l'UI affiche un avertissement explicite avant de lancer la lecture :
  la lecture est possible mais lente, et le téléchargement sera plus confortable.
- Une mise en tampon avant démarrage et une attente lors d'un positionnement dans une zone
  non encore produite sont des comportements **attendus**, pas des bugs.

### 10.6 Vignettes

- Extraction après upload, de manière **asynchrone et non bloquante** : une image prise à
  environ 10 % de la durée, redimensionnée à 480 px de large, écrite en JPEG dans
  `thumbs/<hash>.jpg`.
- Même file d'attente et même limite de concurrence que le transcodage.
- Tant que la vignette n'existe pas, `GET /api/thumbs/*` répond `404` et l'UI affiche un
  dégradé déterministe dérivé du nom du fichier. **L'absence de vignette n'est jamais une
  erreur visible pour l'utilisateur.**

### 10.7 Enchaînement des épisodes

- **Repère d'épisode** : à l'ouverture d'un épisode, son numéro (« Épisode 18 », déduit du
  motif `…S04E18…` du nom de fichier) s'affiche en grand **en haut à droite de l'image**,
  dans la couleur et la graisse signature Sanem, **sans cartouche ni fond**. Il s'efface
  seul au bout de **5 s**. L'enchaînement automatique laisserait sinon le spectateur sans
  aucun repère sur l'épisode en cours.
- **Épisode précédent / suivant** : icônes skip-back / skip-forward appariées (famille
  §11.5), **sans libellé visible**. Tooltip « Épisode précédent » / « Épisode suivant » au
  survol. Le précédent n'est proposé que s'il existe un fichier précédent **dans le même
  dossier**, selon l'ordre de `GET /api/files` (§8) : alphabétique, locale-aware et
  numérique (`S01E09` avant `S01E10`). Un fichier à la racine de `uploads/` n'a ni
  précédent ni suivant. Le chip bas-droit des 2 dernières minutes reprend les mêmes
  icônes (précédent à gauche du suivant, masqué s'il n'y a pas de précédent).
- Arrivé au dernier fichier d'un dossier, la lecture **s'arrête** et l'UI propose de
  revenir à la série. Elle ne déborde jamais sur le dossier voisin.

### 10.8 Positions de reprise

Stockées en `localStorage`, côté client, sous la forme `chemin -> secondes`. Elles sont
donc **par navigateur** : reprendre une lecture sur un autre appareil n'est pas prévu, et
figure au hors-périmètre du §1. Un suivi côté serveur supposerait des comptes nominatifs,
que ce PRD exclut toujours.

Une position est effacée quand la lecture dépasse 95 % de la durée. Un marqueur
**`sanem-done:<chemin>`** est alors écrit à sa place, et il persiste : sans lui, un
épisode terminé serait indiscernable d'un épisode jamais lancé, les deux étant dépourvus
de position de reprise. L'UI en dérive trois états - *jamais vu*, *en cours*, *terminé* -
qui pilotent le verbe d'action (Lire / Reprendre / Revoir) et les marqueurs de vignette.

## 11. Frontend

Page unique, thème sombre néon par défaut, avec bascule clair/sombre persistée en
`localStorage`. Cinq écrans, un routeur interne sur `hashchange`, **aucune navigation
serveur** : `GET /` sert toujours la même page.

### 11.1 Écrans

1. **Connexion** - affiché si `/api/session` renvoie `authenticated: false`. Champ mot de
   passe plein écran, message d'erreur explicite en cas de `401`, message distinct en cas
   de `429`. Inchangé par rapport à la v2.
1. **Hub** (`#/`) - affiché **uniquement à la première connexion**, quand la clé
   `localStorage` `sanem-last-tab` est absente. Deux grandes tuiles côte à côte :
   **Putum** (icône 📤, accent `--accent` cyan, glose « Envoyer des fichiers ») et
   **Lukluk** (icône 🎬, accent `--accent-2` magenta, glose « Regarder les vidéos », avec
   le nombre de séries et de vidéos). Le terme vanuatais est affiché en grand, la glose
   française en dessous.
1. **Putum** (`#/putum`) - le dépôt. Sélecteur « Ranger dans » listant les séries
   existantes, plus « Nouvelle série » et « Aucune (racine) ». Grande zone de dépôt en
   pointillés acceptant le drag & drop de fichiers **et de dossiers**, et le clic ouvrant
   le sélecteur (avec `webkitdirectory` pour choisir un dossier). Une ligne par fichier en
   cours : chemin relatif en gris au-dessus du nom, barre de progression avec effet glow,
   pourcentage, vitesse et temps restant fournis par Uppy, erreurs et tentatives de
   reprise visibles. Un état intermédiaire **« analyse en cours »** apparaît entre la fin
   du transfert et `ready: true` (§8).
1. **Lukluk** (`#/lukluk`) - la vidéothèque. Une mise en avant de la dernière vidéo
   visionnée mais non terminée, sinon de la première vidéo lisible dans l'ordre
   alphabétique (§8), avec un bouton Lire dominant, puis des rangées horizontales
   défilantes : « Reprendre la lecture », « Séries », « Nouveautés », « Tout ». Les
   rangées « Séries », « Reprendre la lecture » et « Tout » suivent ce même ordre
   alphabétique locale-aware et numérique ; « Nouveautés » reste triée par date. Chaque
   vignette porte le nom, une métadonnée courte, et une barre de reprise magenta si une
   position est enregistrée. Les fichiers `playback: "none"` sont listés sans bouton Lire,
   avec Télécharger seul.
1. **Série** (`#/lukluk/serie/:dossier`) - les épisodes ordonnés d'un dossier, dans la
   même grammaire visuelle que Lukluk : un **épisode mis en avant** (grande affiche,
   métadonnées, action dominante) surmontant un **rail horizontal** d'une vignette par
   épisode. Cliquer une vignette recible la mise en avant sans quitter l'écran. Le rail
   s'ouvre sur l'épisode en cours, sinon sur le premier épisode non terminé, sinon sur le
   premier (§10.8). L'affiche mise en avant reprend les marqueurs de sa vignette : pastille
   verte si l'épisode est terminé, barre de reprise magenta s'il est en cours. Deux flèches
   de défilement apparaissent **au survol seulement** et avancent d'une page entière de
   vignettes ; elles disparaissent sur pointeur grossier, où le balayage et la demi-vignette
   coupée (§11.4) restent l'affordance.
1. **Lecteur** (`#/lukluk/play/:chemin`) - voir 11.3.

Une fois le premier choix fait, `sanem-last-tab` est écrit et le hub ne réapparaît plus :
les connexions suivantes ouvrent directement le dernier onglet visité. Un **menu overflow**
(icône hamburger, coin supérieur droit) remplace le dock : Putum, Lukluk, bascule
thème clair/obscur, déconnexion. Pas de barre d'onglets basse — l'IHM reste aussi
légère que possible, y compris en lecture.

### 11.2 Configuration Uppy imposée

```js
uppy.use(Uppy.Tus, {
  endpoint: '/files',
  chunkSize: 8 * 1024 * 1024,   // 8 Mo - IMPOSÉ, voir §13
  retryDelays: [0, 1000, 3000, 5000, 10000],
  withCredentials: true,         // le cookie de session doit accompagner les requêtes tus
});
```

Cette configuration ne change pas d'un caractère par rapport à la v2. Le chemin relatif
est transmis en **métadonnée tus supplémentaire** (`relativePath`), consommée par le §9.

Restriction de taille côté client alignée sur `SANEM_MAX_FILE_GB`, avec message clair
au-delà.

### 11.3 Lecteur vidéo

Balise `<video>` native, alimentée soit directement par `/api/media/*` (voie 0), soit par
`hls.js` pointant sur `/api/hls/*` (voies 1 à 3). Safari et iOS lisent le HLS nativement :
n'instancier `hls.js` que si `Hls.isSupported()` et que la lecture native du HLS n'est pas
déjà disponible.

**Barre de contrôle maison**, jamais les contrôles natifs :

| Contrôle             | Comportement                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lire / Pause         | Bouton principal, seul élément en blanc plein de la barre. Touche <kbd>Espace</kbd>.                                                                                                  |
| Recul / avance 10 s  | Pas de boutons dédiés dans la barre (redondants). `currentTime ± 10` via flèches gauche/droite et double-tap sur les tiers latéraux.                                                   |
| Barre de progression | Positionnement. Hauteur 6 px au repos, 10 px au survol, poignée de 16 px. Un liseré clair montre le tampon chargé.                                                                    |
| Volume               | `video.volume` + coupure du son, persisté en `localStorage`.                                                                                                                          |
| Vitesse              | Retiré de la barre : `playbackRate` n'est pas exposé (fonction non utilisée). À réintroduire uniquement sur demande.                                                                   |
| Sous-titres          | Si un `.srt` ou `.vtt` de même nom a été déposé dans le même dossier, ou si `ffprobe` a détecté une piste interne, extraite par ffmpeg.                                               |
| Épisode précédent / suivant | Icônes skip-back / skip-forward, sans texte visible. Tooltip « Épisode précédent » / « Épisode suivant ». Le précédent est masqué sur le premier épisode et hors série. Chip bas-droit en fin d'épisode : mêmes icônes, précédent à gauche du suivant. |
| Plein écran          | Fullscreen API **sur le conteneur**, jamais sur `<video>`, sinon la barre maison disparaît. Touches <kbd>F</kbd> et <kbd>Échap</kbd>. Icône d'entrée hors plein écran, icône de sortie (flèches rentrantes) une fois en plein écran **natif ou overlay**. Tooltips « Plein écran » / « Quitter le plein écran ». Sur téléphone : si l'API ou `orientation.lock` échoue, repli CSS qui étend la vidéo sur le grand côté (paysage). |

**Barre overlay : une seule ligne**, y compris sous 390 px. `flex-wrap: nowrap`. Les
boutons ±10 s n'y figurent pas. Un clic / tap sur la surface vidéo **masque** la barre ;
un second la **réaffiche**. Elle se masque aussi seule après 3 s d'inactivité en lecture.

**Dimensionnement imposé** : cibles de **46 px minimum** pour les icônes de la barre (44
px sous 640 px de large, pour tenir sur une ligne). Glyphe à 24 px (20 px sous 640 px).
Une barre à 16 px n'est pas acceptable. Les boutons « Épisode précédent » / « Épisode
suivant » restent labellisés (`aria-label` + tooltip CSS `.has-tip`, sans `title` natif) et sont **toujours** des icônes, y
compris hors 640 px, pour tenir sur une ligne.

**Zones tactiles**, dans l'esprit des lecteurs mobiles usuels :

- L'image est divisée en trois tiers verticaux.
- **Double-tap sur le tiers gauche ou droit** : recul ou avance de 10 s. Les taps
  consécutifs **s'accumulent** dans une fenêtre de 800 ms (-10, -20, -30…), l'indicateur
  affiche le cumul, et **un seul** `currentTime` est écrit à la fin de la salve.
- **Maintien** sur un tiers latéral : après 500 ms d'appui, défilement continu de 10 s
  toutes les 250 ms, accéléré à 30 s après 3 s d'appui. Le relâchement arrête
  immédiatement et reprend la lecture.
- **Tiers central** : simple tap pour afficher ou masquer la barre, double tap pour le
  plein écran. Lecture / pause : bouton et touche <kbd>Espace</kbd>.
- **Simple tap n'importe où sur la surface** : affiche ou masque la barre, qui se masque
  aussi seule après 3 s d'inactivité en lecture.
- Implémenté en `pointerdown` / `pointerup`, **pas** en `click`, pour capter le maintien
  et fonctionner à la souris comme au doigt. `touch-action: none` sur les zones, sinon le
  navigateur mobile interprète le maintien comme un défilement.

### 11.4 Responsive imposé

Trois points de rupture. Un seul fichier CSS, aucune duplication de balisage : la mise en
page utilise `clamp()` et `minmax()`, pas des largeurs fixes.

| Élément         | ≥ 1024 px                     | 640 - 1023 px          | < 640 px                                         |
| --------------- | ----------------------------- | ---------------------- | ------------------------------------------------ |
| Navigation      | Menu hamburger en haut à droite | Idem                   | Idem, pas de barre d'onglets basse               |
| Tuiles du hub   | 2 colonnes                    | 2 colonnes aplaties    | 1 colonne, empilées                              |
| Zone de dépôt   | Grande zone + liste latérale  | Zone pleine largeur    | Bouton natif d'abord, glisser-déposer en secours |
| Vignettes       | 168 px, 5 par rangée          | 150 px, 3,5 par rangée | 136 px, 2,2 par rangée                           |
| Lecteur         | 16:9 encadré, barre au survol | Pleine largeur         | Plein écran paysage (repli CSS si l'API échoue)  |
| Cibles tactiles | ≥ 32 px                       | ≥ 44 px                | ≥ 48 px, jamais deux actions à moins de 8 px     |
| Typographie     | 16 px de base                 | 16 px de base          | **16 px de base, jamais moins** (zoom auto iOS)  |

Les rangées de vignettes utilisent `scroll-snap-type: x mandatory`. La demi-vignette
coupée en bord d'écran est **volontaire** : elle signale qu'on peut faire défiler.

### 11.5 Marque et famille d'icônes

La marque **Sanem** est un signe unique qui raconte les deux parcours : une **flèche
montante** (Putum, le dépôt) posée sur un **triangle de lecture** (Lukluk, le
visionnage), inscrits dans un carré arrondi. La flèche prend `--accent-2` (magenta), le
triangle `--accent` (cyan) : aucune couleur nouvelle n'est introduite. Elle apparaît dans
l'en-tête, sur l'écran de connexion et comme favicon (`favicon.svg`, variante sans cadre,
lisible à 16 px).

Toutes les icônes de l'interface appartiennent à **une seule famille** : tracé sur une
grille **24 × 24**, `fill: none`, `stroke: currentColor`, épaisseur 2, extrémités et
jointures arrondies. Elles sont déclarées une fois en `<symbol id="i-*">` dans un sprite
SVG inerte de `index.html`, puis instanciées par `<use href="#i-*">`. **Aucun emoji,
aucune police d'icônes, aucun asset matriciel** : un emoji ne se recolore pas et son rendu
change d'un système à l'autre, ce qui interdit l'accord avec le thème néon et sa bascule
clair / obscur.

## 12. Tests

`npm test` (runner natif `node --test`) doit couvrir :

- **`test/filename.test.js`** - traversée de chemin (`../`, chemins absolus, séparateurs
  Windows), caractères unicode, noms vides, troncature avec extension préservée,
  déduplication sur collision. **Ajouts v3, obligatoires** :
  1. `relativePath = "../../.ssh/authorized_keys"` atterrit dans `uploads/` et nulle part
     ailleurs ;
  1. `relativePath = "a/b/c/d.mkv"` donne `c/d.mkv`, jamais une arborescence profonde ;
  1. un dossier de série qui est un **lien symbolique** vers l'extérieur de `uploads/` est
     rejeté par l'assertion 9.4 (le test crée le lien, tente l'écriture, et vérifie
     qu'aucun fichier n'apparaît hors du répertoire de test) ;
  1. la déduplication s'évalue par dossier : deux `S01E01.mkv` dans deux séries
     différentes coexistent sans suffixe.
- **`test/media.test.js`** - nouveau en v3 :
  1. une requête avec `Range: bytes=100-199` renvoie `206`, un `Content-Range` correct et
     **exactement les 100 octets attendus** ;
  1. un chemin contenant `../`, encodé ou non, renvoie `404` ;
  1. une requête sans cookie de session renvoie `401` sur les quatre routes média.
- **`test/resume.test.js`** - test d'intégration de la reprise, **sans intervention
  manuelle** :
  1. démarrer le serveur sur un port éphémère avec un `SANEM_DATA_DIR` temporaire ;
  1. uploader un fichier de test (~50 Mo suffisent) avec `tus-js-client` ;
  1. interrompre volontairement après ~2 chunks ;
  1. relancer l'upload avec la même URL tus ;
  1. asserter que l'offset repart de la position atteinte (**pas de 0**), que le fichier
     final est intact (comparaison de hash), et que **`tmp/` est vide**.
- **`test/player-ui.test.js`** - E2E Chromium (binaire système, pas de dépendance npm) :
  viewports téléphone portrait **et** paysage ; hamburger (Putum, Lukluk, thème,
  déconnexion) ; pas de boutons ±10 s ; tap surface masque/réaffiche l'overlay ; barre
  sur une seule ligne ; le plein écran couvre le grand côté du téléphone.

Ce dernier test est le garde-fou principal du projet : il valide la seule exigence
technique non négociable. **Il ne doit pas être affaibli, ralenti ni rendu instable par
l'ajout de l'analyse média** : c'est précisément pourquoi `ffprobe` et l'extraction de
vignette sont déclenchés de manière non bloquante (§6).

Aucun test ne doit dépendre de la présence de `ffmpeg` sur la machine de développement :
les chemins qui l'appellent sont testés à travers leur file d'attente, avec un binaire
absent traité comme une erreur normale (`playback: "none"`).

## 13. Pièges connus

À lire avant d'écrire la moindre ligne. Chacun produit du code qui semble correct mais
casse en conditions réelles.

- **Body parser et tus** - si `express.json()` ou tout autre body parser est monté
  globalement avant la route `/files`, il consomme le flux de la requête et **toutes les
  requêtes `PATCH` tus échouent**. Monter le routeur tus **avant** tout body parser, ou
  restreindre les parsers à `/api`.
- **Routes joker en Express 5** - `path-to-regexp` v8 n'accepte plus `'*'` seul. Utiliser
  `app.all('/files/*splat', …)` (ou un `app.use('/files', …)` en tenant compte du fait que
  le préfixe est retiré de `req.url`, alors que `@tus/server` doit connaître son chemin
  public complet). Les quatre routes média du §8 sont concernées au même titre.
- **Collision de préfixe de route** - ne jamais servir un média sous `/files/…`, ce
  préfixe appartient à tus. D'où `/api/media`, `/api/hls`, `/api/thumbs`, `/api/download`.
- **`chunkSize` par défaut** - `tus-js-client` envoie sinon **un seul `PATCH` de 1,5 Go**,
  ce qui annule la reprise sur coupure et passe très mal à travers Funnel. La valeur 8 Mo
  du §11 est impérative.
- **Cookie derrière Funnel** - Funnel termine le TLS et parle en HTTP au conteneur. Avec
  un cookie `Secure`, il faut `app.set('trust proxy', 1)` et vérifier que
  `X-Forwarded-Proto` est bien transmis, sinon la session ne s'établit pas et
  l'utilisateur boucle sur l'écran de connexion.
- **Ports Funnel** - Funnel n'écoute publiquement que sur **443, 8443 ou 10000**.
  `tailscale funnel 3900` est correct : il expose le port **local** 3900 sur le port
  **public** 443. Ne jamais tenter d'exposer 3900 publiquement.
- **Bande passante Funnel** - le streaming vidéo est un usage bien plus lourd qu'un upload
  et peut transiter par des relais DERP. Le confort de lecture n'est pas garanti par la
  qualité du lecteur : ne pas chercher à compenser côté code.
- **Propriété des fichiers** - `node:22-alpine` tourne en root : sans `user:` dans le
  compose, les fichiers arrivent dans `~/sanem-data` appartenant à root sur l'hôte.
  Vérifier que l'utilisateur `node` (uid/gid 1000) peut écrire dans `thumbs/` et
  `transcode/`, créés en v3.
- **Expansion de `~` dans compose** - peu fiable. Utiliser `${HOME}`.
- **Sidecars `.json`** - `@tus/file-store` écrit un fichier de métadonnées par upload. Les
  oublier pollue `tmp/` et fait apparaître des entrées parasites si le listing lit le
  mauvais répertoire.
- **ffmpeg et le shell** - `execFile` avec un tableau d'arguments, jamais `exec` ni une
  chaîne interpolée. Le nom de fichier vient du client (§10.4).
- **ffprobe bloquant** - lancer `ffprobe` ou l'extraction de vignette **avant** de
  répondre à tus rend `resume.test.js` lent et instable, et fait attendre l'utilisateur
  sans raison. Toujours après le `rename`, toujours détaché de la réponse (§6).
- **Segments HLS et images clés** - sur les voies 1 et 2, la vidéo est copiée : découper à
  intervalle fixe produit des segments illisibles. La playlist doit suivre les images clés
  réelles (§10.3).
- **Fullscreen sur `<video>`** - passer la balise elle-même en plein écran fait
  disparaître la barre de contrôle maison, remplacée par les contrôles natifs. Toujours le
  conteneur.
- **Concurrence ffmpeg** - au-delà de 1 processus, le transcodage entre en concurrence
  avec les uploads tus sur le même process Node et la même machine. Les uploads priment.

## 14. Docker et déploiement

### Dockerfile

Base `node:22-alpine`, **`apk add --no-cache ffmpeg`** (fournit également `ffprobe`),
`npm ci --omit=dev`, code copié, utilisateur non-root (`node`, uid/gid 1000),
`CMD ["node", "src/server.js"]`.

L'ajout de ffmpeg augmente l'image d'environ 80 Mo. C'est le coût assumé du §10.

### docker-compose.yml

```yaml
services:
  sanem:
    build: .
    container_name: sanem
    restart: unless-stopped
    user: "1000:1000"
    ports:
      - "${SANEM_PORT:-3900}:3900"
    environment:
      - SANEM_PORT=3900
      - SANEM_DATA_DIR=/data
      - SANEM_PASSWORD=${SANEM_PASSWORD}
      - SANEM_SESSION_SECRET=${SANEM_SESSION_SECRET}
    volumes:
      - ${HOME}/sanem-data:/data
```

Fournir un `.env.example` documenté ; `.env` doit figurer dans `.gitignore`.

### Exposition

Rien à coder. À documenter dans le `README.md` :

```sh
tailscale funnel 3900
```

Prérequis : Tailscale installé et authentifié sur le PC hôte, Funnel activé pour le
tailnet.

## 15. Documentation à livrer

Deux fichiers, deux publics distincts :

- **`AGENTS.md`** - contexte pour les agents de code, **rédigé en suivant strictement la
  skill `init-agent`** : sections *What this project does / Commands / Architecture / Code
  conventions / Tests / Known pitfalls / Configuration*, en **anglais**, sous 60 lignes si
  possible, pointeurs plutôt que copies, et **`CLAUDE.md` créé en symlink vers
  `AGENTS.md`** (jamais une copie). Les pièges du §13 y sont résumés en une ligne chacun,
  avec renvoi vers ce PRD pour le détail. **Il décrit encore l'architecture v2 : il doit
  être mis à jour dans le même lot que le code, sinon le prochain agent repart d'une carte
  périmée.**
- **`README.md`** - documentation humaine : prérequis, `docker compose up`, configuration
  `.env`, commande Tailscale Funnel, emplacement des fichiers reçus, dépannage courant, et
  **l'avertissement du §8 sur le modèle de menace v3, repris mot pour mot**.

## 16. Plan d'implémentation par étapes

La v2 est déjà livrée et fonctionnelle. Les étapes ci-dessous partent de cet état. Livrer
et faire valider dans cet ordre. Ne pas démarrer une étape avant que la précédente ne soit
fonctionnelle et que `npm test` passe.

1. **Documentation** - ce PRD v3, puis `AGENTS.md`, `README.md` et `.env.example` mis à
   niveau. Critère : la documentation décrit la cible, aucun code n'a encore bougé.
1. **Arborescence** - §9 réécrit dans `src/filename.js`, tests du §12 écrits **avant** le
   code, `src/tus.js` et `src/files.js` adaptés. Critère : les quatre tests d'arborescence
   passent, `resume.test.js` passe toujours, un dépôt de dossier arrive au bon endroit.
1. **Refonte de l'IHM** - hub, dock, écrans Putum et Lukluk, responsive du §11.4, sans
   lecture vidéo. Critère : parcours complet dans un navigateur réel, à 1440 px, 800 px et
   375 px de large.
1. **Lecture directe et téléchargement** - `src/media.js`, voie 0 uniquement,
   `test/media.test.js`. Critère : un MP4 H.264/AAC se lit et se positionne correctement,
   les trois tests média passent.
1. **Lecteur** - `public/player.js` : barre de contrôle, zones tactiles, plein écran,
   épisode suivant, positions de reprise. Critère : parcours complet au doigt sur un
   téléphone réel.
1. **Transcodage** - `src/transcode.js` et `src/thumbs.js`, ffmpeg dans le Dockerfile,
   voies 1 à 3, cache et purge du §7.2. Critère : un `.mkv` H.264/AAC se lit sans
   ré-encodage et se positionne ; un fichier HEVC se lit ; le cache se purge au seuil.
1. **Finalisation** - lint propre, `npm test` complet, relecture des interdits du §17.

## 17. Interdits

- Remplacer tus par un upload multipart, « chunké maison » ou tout autre mécanisme.
- Introduire un bundler, un framework front, un lecteur vidéo tiers, ou une dépendance npm
  hors du §4.
- Ajouter une variable d'environnement hors du §5.
- Implémenter une fonctionnalité listée hors périmètre au §1, en particulier une
  arborescence de plus d'un niveau.
- Laisser un secret en dur dans le code ou committer un `.env`.
- Écrire dans `uploads/`, ou y lire un chemin fourni par le client, sans passer par
  l'assertion du §9.4.
- Invoquer `ffmpeg` ou `ffprobe` à travers un shell, ou en interpolant un nom de fichier
  dans une chaîne de commande.
- Bloquer la réponse tus sur une analyse média.
- Servir un média sous le préfixe `/files`, ou faire transiter un jeton d'accès dans une
  URL de média.
- Désactiver ou assouplir le rate limiting du §8, y compris temporairement pour faciliter
  les tests : c'est la seule protection du mot de passe court, et le §8 explique pourquoi
  cela pèse plus lourd en v3 qu'en v2.
- Affaiblir, ralentir ou rendre conditionnel `test/resume.test.js`.
- Déclarer le projet terminé sans avoir testé un fichier réel d'au moins 500 Mo, ni la
  lecture d'un `.mkv` réel de bout en bout.

Toute question bloquante non tranchée par ce document doit être posée au propriétaire du
projet avant tout choix arbitraire affectant l'architecture.
