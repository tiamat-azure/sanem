# PRD - Sanem (v2)

Service web auto-hébergé permettant à des amis distants d'envoyer de gros fichiers
(animes, ~1,5 Go en moyenne) par drag & drop dans le navigateur, vers le PC de l'hôte,
exposé publiquement via Tailscale Funnel.

Nom : « Sanem » (vanuatais : *envoyer, faire parvenir*).

**Ce document est une spécification d'implémentation contraignante.** Il est écrit pour
être exécuté par un agent IA de développement sans connaissance préalable du projet. Les
choix techniques y sont **verrouillés** : là où le document dit « imposé », il n'y a pas
d'alternative acceptable. Toute déviation doit être validée par le propriétaire du projet
avant d'être codée.

## 1. Objectif produit

Un ami distant (aucune compétence technique, Tailscale non installé chez lui) ouvre une
URL publique, saisit un mot de passe partagé, dépose des fichiers dans une zone centrale,
et voit leur progression jusqu'à la fin du transfert. L'upload **reprend automatiquement
après une coupure réseau**, sans repartir de zéro. L'hôte récupère les fichiers dans
`~/sanem-data/uploads/`.

### Hors périmètre v1 (ne pas implémenter)

Téléchargement des fichiers depuis l'UI, prévisualisation vidéo, suppression par les amis,
dossiers/arborescence, liens de partage par fichier, notifications, comptes nominatifs,
quota disque, politique de rétention des fichiers **finalisés**.

> Le nettoyage de `tmp/` (§7) n'est **pas** une politique de rétention : c'est de
> l'hygiène de stockage, et il est **obligatoire**.

## 2. Décisions verrouillées

| Sujet              | Décision imposée                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Runtime            | Node.js 22 LTS (`node:22-alpine`). `@tus/server` exige `node >= 20.19`.                                          |
| Framework HTTP     | **Express 5**. Pas de Fastify.                                                                                   |
| Serveur d'upload   | **`@tus/server` + `@tus/file-store`**, in-process. Pas de binaire `tusd` séparé.                                 |
| Protocole d'upload | **tus** (resumable). Interdiction absolue de le remplacer par du multipart maison.                               |
| Route tus          | **`/files`**. Pas `/uploads`.                                                                                    |
| Frontend           | **Uppy v5** via bundle CDN, chargé par `<script>`. Pas de bundler, pas de React/Vue/Svelte.                      |
| UI upload          | **`@uppy/dashboard`** (inclus dans le bundle), thème sombre.                                                     |
| Style visuel       | **Néon** (fond sombre, accents vifs, glow sur les barres de progression). L'alternative « zen » est **rejetée**. |
| Authentification   | Mot de passe unique partagé + cookie de session signé. Pas de comptes.                                           |
| Exposition         | **Tailscale Funnel**. Pas de Caddy/Nginx.                                                                        |
| Stockage           | `~/sanem-data/` sur l'hôte, monté en volume Docker.                                                              |
| Conteneurisation   | Docker + `docker compose`. Obligatoire.                                                                          |
| Port local         | **3900** par défaut (hors plage 8080-8090 déjà occupée), configurable.                                           |
| Langue             | UI en français. Code, commentaires et `AGENTS.md` en anglais.                                                    |

## 3. Arborescence imposée

L'agent doit produire exactement cette structure. Ni plus (pas de fichiers « bonus »), ni
moins.

```
sanem/
├── AGENTS.md                 # contexte agent (voir §13)
├── CLAUDE.md                 # symlink -> AGENTS.md
├── README.md                 # doc humaine (voir §13)
├── PRD.md                    # ce document
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
│   ├── files.js              # GET /api/files, formatage des métadonnées
│   ├── filename.js           # sanitisation + déduplication des noms de fichiers
│   └── cleanup.js            # nettoyage de tmp/ (§7)
├── public/
│   ├── index.html            # page unique
│   ├── app.js                # init Uppy + logique UI
│   └── style.css             # thème néon
└── test/
    ├── filename.test.js      # tests unitaires de sanitisation (§11)
    └── resume.test.js        # test d'intégration reprise sur coupure (§11)
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
    "test": "node --test test/",
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
    "eslint": "9.40.0",
    "tus-js-client": "4.3.1"
  }
}
```

Frontend, épinglé dans `public/index.html` (Uppy s'expose sur `window.Uppy`) :

```html
<link rel="stylesheet" href="https://releases.transloadit.com/uppy/v5.2.4/uppy.min.css">
<script src="https://releases.transloadit.com/uppy/v5.2.4/uppy.min.js"></script>
```

> Avant de coder, l'agent doit vérifier les signatures d'API réelles des versions
> installées (notamment `onUploadFinish` de `@tus/server`, dont la signature a changé
> entre les majeures). Les extraits de ce PRD sont indicatifs sur la forme, contraignants
> sur l'intention.

## 5. Variables d'environnement

| Variable               | Obligatoire | Défaut  | Description                                                                                                                                                      |
| ---------------------- | ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANEM_PASSWORD`       | oui         | aucun   | Mot de passe partagé. **Crash au démarrage si absent ou < 5 caractères.** Seuil bas assumé pour le POC ; compensé par le rate limiting du §8.                    |
| `SANEM_SESSION_SECRET` | oui         | aucun   | Secret de signature des cookies. **Crash au démarrage si absent ou < 32 caractères.** Jamais généré à la volée (invaliderait les sessions à chaque redémarrage). |
| `SANEM_PORT`           | non         | `3900`  | Port d'écoute local.                                                                                                                                             |
| `SANEM_DATA_DIR`       | non         | `/data` | Racine de stockage dans le conteneur.                                                                                                                            |
| `SANEM_TMP_TTL_HOURS`  | non         | `48`    | Âge au-delà duquel un upload inachevé est considéré orphelin (§7).                                                                                               |
| `SANEM_MAX_FILE_GB`    | non         | `20`    | Refus au-delà, côté client et serveur.                                                                                                                           |

`src/config.js` valide tout au démarrage et **termine le process avec un message
explicite** si une contrainte est violée. Aucune variable hors de ce tableau ne doit être
introduite.

## 6. Stockage

```
$SANEM_DATA_DIR/
├── uploads/    # fichiers finalisés, seuls fichiers listés par GET /api/files
└── tmp/        # uploads en cours (géré par @tus/file-store) - doit rester propre
```

Les deux répertoires sont créés au démarrage s'ils n'existent pas. `tmp/` et `uploads/`
sont sur le même système de fichiers, ce qui rend la finalisation atomique par
`fs.rename()` (prévoir un repli copie + suppression en cas d'`EXDEV`).

### Finalisation d'un upload

Dans le hook `onUploadFinish` :

1. Calculer le nom final via `src/filename.js` (§9).
1. `fs.rename(tmp/<id>, uploads/<nom-final>)`.
1. **Supprimer le sidecar de métadonnées** `tmp/<id>.json` créé par `@tus/file-store`.
1. Vérifier qu'aucun résidu portant `<id>` ne subsiste dans `tmp/`, et logger l'opération.

**Invariant vérifiable** : après un upload réussi, `tmp/` ne contient aucune trace de cet
upload.

## 7. Nettoyage de `tmp/` (obligatoire)

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

## 8. API backend

| Méthode | Route                  | Auth | Description                                                                                               |
| ------- | ---------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `GET`   | `/`                    | non  | Sert `public/index.html`. La page décide seule quoi afficher via `/api/session`.                          |
| `GET`   | `/api/session`         | non  | `{ authenticated: boolean }`. Permet à l'UI de choisir écran de login ou page d'upload.                   |
| `POST`  | `/api/login`           | non  | Body `{ password }`. Si correct : pose le cookie de session, renvoie `204`. Sinon `401`. **Rate-limité.** |
| `POST`  | `/api/logout`          | oui  | Détruit la session, renvoie `204`.                                                                        |
| `GET`   | `/api/files`           | oui  | `[{ name, size, uploadedAt }]` trié par date décroissante. Ignore les fichiers cachés.                    |
| `ALL`   | `/files` et `/files/*` | oui  | Endpoint tus.                                                                                             |

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
- `/files` et `/files/*` sont protégés par **le même middleware de session**. Un client
  sans cookie valide ne doit pas pouvoir initier ni poursuivre un upload.

## 9. Sanitisation des noms de fichiers (sécurité)

Le nom provient des métadonnées tus, donc **du client, donc non fiable**.
`src/filename.js` applique dans l'ordre :

1. Prendre `upload.metadata.filename`, ou `"sans-nom"` s'il est absent ou vide.
1. `path.basename()` pour éliminer tout composant de chemin.
1. Normaliser en NFC, remplacer tout caractère hors `[lettres, chiffres, . _ - espace]`
   par `_`.
1. Tronquer à 200 caractères en préservant l'extension.
1. Rejeter `""`, `"."`, `".."` vers `"sans-nom"`.
1. En cas de collision dans `uploads/`, insérer un suffixe `-2`, `-3`… **avant**
   l'extension.
1. **Assertion finale** : le chemin absolu résolu doit commencer par le chemin absolu de
   `uploads/` + séparateur. Sinon, rejeter l'upload et logger une alerte.

Sans les étapes 2 et 7, un nom comme `../../.ssh/authorized_keys` permet une écriture
arbitraire sur la machine hôte.

## 10. Frontend

Page unique, thème sombre néon par défaut, avec bascule clair/sombre persistée en
`localStorage`.

1. **Écran de connexion** - affiché si `/api/session` renvoie `authenticated: false`.
   Champ mot de passe plein écran, message d'erreur explicite en cas de `401`, message
   distinct en cas de `429`.
1. **En-tête** - « 📦 Sanem », bascule de thème, bouton de déconnexion.
1. **Zone de dépôt** - grande zone centrale en pointillés, drag & drop natif **et** clic
   ouvrant le sélecteur. Multi-fichiers.
1. **Uploads en cours** - une ligne par fichier : nom, barre de progression avec effet
   glow, pourcentage, vitesse et temps restant fournis par Uppy. Erreurs et tentatives de
   reprise visibles.
1. **Fichiers disponibles** - nom, taille lisible (Ko/Mo/Go), date. Rafraîchi au
   chargement et après chaque upload terminé.
1. **Responsive** - utilisable dès 375 px de large.

### Configuration Uppy imposée

```js
uppy.use(Uppy.Tus, {
  endpoint: '/files',
  chunkSize: 8 * 1024 * 1024,   // 8 Mo - IMPOSÉ, voir §12
  retryDelays: [0, 1000, 3000, 5000, 10000],
  withCredentials: true,         // le cookie de session doit accompagner les requêtes tus
});
```

Restriction de taille côté client alignée sur `SANEM_MAX_FILE_GB`, avec message clair
au-delà.

## 11. Tests

`npm test` (runner natif `node --test`) doit couvrir :

- **`test/filename.test.js`** - traversée de chemin (`../`, chemins absolus, séparateurs
  Windows), caractères unicode, noms vides, troncature avec extension préservée,
  déduplication sur collision.
- **`test/resume.test.js`** - test d'intégration de la reprise, **sans intervention
  manuelle** :
  1. démarrer le serveur sur un port éphémère avec un `SANEM_DATA_DIR` temporaire ;
  1. uploader un fichier de test (~50 Mo suffisent) avec `tus-js-client` ;
  1. interrompre volontairement après ~2 chunks ;
  1. relancer l'upload avec la même URL tus ;
  1. asserter que l'offset repart de la position atteinte (**pas de 0**), que le fichier
     final est intact (comparaison de hash), et que **`tmp/` est vide**.

Ce test est le garde-fou principal du projet : il valide la seule exigence technique non
négociable.

## 12. Pièges connus

À lire avant d'écrire la moindre ligne. Chacun produit du code qui semble correct mais
casse en conditions réelles.

- **Body parser et tus** - si `express.json()` ou tout autre body parser est monté
  globalement avant la route `/files`, il consomme le flux de la requête et **toutes les
  requêtes `PATCH` tus échouent**. Monter le routeur tus **avant** tout body parser, ou
  restreindre les parsers à `/api`.
- **Routes joker en Express 5** - `path-to-regexp` v8 n'accepte plus `'*'` seul. Utiliser
  `app.all('/files/*splat', …)` (ou un `app.use('/files', …)` en tenant compte du fait que
  le préfixe est retiré de `req.url`, alors que `@tus/server` doit connaître son chemin
  public complet).
- **`chunkSize` par défaut** - `tus-js-client` envoie sinon **un seul `PATCH` de 1,5 Go**,
  ce qui annule la reprise sur coupure et passe très mal à travers Funnel. La valeur 8 Mo
  du §10 est impérative.
- **Cookie derrière Funnel** - Funnel termine le TLS et parle en HTTP au conteneur. Avec
  un cookie `Secure`, il faut `app.set('trust proxy', 1)` et vérifier que
  `X-Forwarded-Proto` est bien transmis, sinon la session ne s'établit pas et
  l'utilisateur boucle sur l'écran de connexion.
- **Ports Funnel** - Funnel n'écoute publiquement que sur **443, 8443 ou 10000**.
  `tailscale funnel 3900` est correct : il expose le port **local** 3900 sur le port
  **public** 443. Ne jamais tenter d'exposer 3900 publiquement.
- **Propriété des fichiers** - `node:22-alpine` tourne en root : sans `user:` dans le
  compose, les fichiers arrivent dans `~/sanem-data` appartenant à root sur l'hôte.
- **Expansion de `~` dans compose** - peu fiable. Utiliser `${HOME}`.
- **Sidecars `.json`** - `@tus/file-store` écrit un fichier de métadonnées par upload. Les
  oublier pollue `tmp/` et fait apparaître des entrées parasites si le listing lit le
  mauvais répertoire.

## 13. Docker et déploiement

### Dockerfile

Base `node:22-alpine`, `npm ci --omit=dev`, code copié, utilisateur non-root,
`CMD ["node", "src/server.js"]`.

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

## 14. Documentation à livrer

Deux fichiers, deux publics distincts :

- **`AGENTS.md`** - contexte pour les agents de code, **rédigé en suivant strictement la
  skill `init-agent`** : sections *What this project does / Commands / Architecture / Code
  conventions / Tests / Known pitfalls / Configuration*, en **anglais**, sous 60 lignes si
  possible, pointeurs plutôt que copies, et **`CLAUDE.md` créé en symlink vers
  `AGENTS.md`** (jamais une copie). Les pièges du §12 y sont résumés en une ligne chacun,
  avec renvoi vers ce PRD pour le détail.
- **`README.md`** - documentation humaine : prérequis, `docker compose up`, configuration
  `.env`, commande Tailscale Funnel, emplacement des fichiers reçus, dépannage courant.

## 15. Plan d'implémentation par étapes

Livrer et faire valider dans cet ordre. Ne pas démarrer une étape avant que la précédente
ne soit fonctionnelle.

1. **Socle** - `package.json`, `src/config.js` avec validation stricte, `src/server.js`
   minimal, Dockerfile, compose, `.env.example`. Critère : `docker compose up` démarre et
   répond sur `/api/session`.
1. **Authentification** - login, logout, session, rate limiting, écran de connexion.
   Critère : aucune route protégée n'est accessible sans cookie valide.
1. **Upload tus** - `src/tus.js`, `src/filename.js`, finalisation et nettoyage immédiat.
   Critère : un fichier de 500 Mo arrive intact dans `uploads/` et `tmp/` est vide.
1. **Nettoyage et listing** - `src/cleanup.js`, `GET /api/files`. Critère : un upload
   abandonné disparaît après expiration ; un upload récent interrompu survit.
1. **Interface** - Uppy, thème néon, responsive, rafraîchissement de la liste. Critère :
   parcours complet dans un navigateur réel.
1. **Finalisation** - tests du §11, lint propre, `AGENTS.md` + symlink `CLAUDE.md` +
   `README.md`.

## 16. Interdits

- Remplacer tus par un upload multipart, « chunké maison » ou tout autre mécanisme.
- Introduire un bundler, un framework front, ou une dépendance hors du §4.
- Ajouter une variable d'environnement hors du §5.
- Implémenter une fonctionnalité listée hors périmètre au §1.
- Laisser un secret en dur dans le code ou committer un `.env`.
- Écrire dans `uploads/` sans passer par la sanitisation du §9.
- Désactiver ou assouplir le rate limiting du §8, y compris temporairement pour faciliter
  les tests : c'est la seule protection du mot de passe court.
- Déclarer le projet terminé sans avoir testé un fichier réel d'au moins 500 Mo.

Toute question bloquante non tranchée par ce document doit être posée au propriétaire du
projet avant tout choix arbitraire affectant l'architecture.
