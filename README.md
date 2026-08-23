# Sanem

Envoie de gros fichiers (vidéos, animes, ~1,5 Go et plus) à distance, par simple
glisser-déposer dans un navigateur, avec reprise automatique après une coupure réseau.
Auto-hébergé, exposé sur internet via Tailscale Funnel.

## Prérequis

- Docker + `docker compose`.
- [Tailscale](https://tailscale.com/) installé et authentifié sur la machine hôte, avec
  Funnel activé pour le tailnet.

## Démarrage

```bash
cp .env.example .env
# éditer .env : définir SANEM_PASSWORD et SANEM_SESSION_SECRET
#   openssl rand -base64 48   # pour générer SANEM_SESSION_SECRET

make start   # équivaut à : docker compose up -d --build
```

Le service écoute en local sur le port `3900` (configurable via `SANEM_PORT`).

## Commandes (`Makefile`)

Un `Makefile` regroupe les opérations courantes ; `make help` liste toutes les cibles.

| Commande             | Effet                                                               |
| -------------------- | ------------------------------------------------------------------- |
| `make start`         | Construit et démarre le conteneur (`docker compose up -d --build`). |
| `make stop`          | Arrête et supprime le conteneur (`docker compose down`).            |
| `make restart`       | Enchaîne `stop` puis `start`.                                       |
| `make status`        | Affiche l'état du conteneur (`docker compose ps`).                  |
| `make logs`          | Suit les logs en continu (`docker compose logs -f sanem`).          |
| `make build`         | Construit l'image sans démarrer le conteneur.                       |
| `make test`          | Lance la suite de tests (`npm test`).                               |
| `make lint`          | Lance eslint (`npm run lint`).                                      |
| `make funnel-start`  | Expose le service sur internet via Tailscale Funnel.                |
| `make funnel-stop`   | Coupe l'exposition Funnel.                                          |
| `make funnel-status` | Affiche l'état de la configuration Funnel/Serve.                    |

## Configuration (`.env`)

| Variable               | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `SANEM_PASSWORD`       | Mot de passe partagé (≥ 5 caractères), obligatoire.             |
| `SANEM_SESSION_SECRET` | Secret de signature des cookies (≥ 32 caractères), obligatoire. |
| `SANEM_PORT`           | Port local d'écoute. Défaut : `3900`.                           |
| `SANEM_TMP_TTL_HOURS`  | Délai avant qu'un upload inachevé soit nettoyé. Défaut : `48`.  |
| `SANEM_MAX_FILE_GB`    | Taille maximale par fichier. Défaut : `20`.                     |

`docker-compose.yml` accepte aussi `SANEM_DATA_DIR_HOST` (variable de déploiement, hors
application) pour forcer le chemin hôte du volume de stockage si la résolution de
`${HOME}` est peu fiable (par exemple avec un Docker installé en snap, qui redirige
certains montages sous `$HOME` vers son propre bac à sable).

## Exposition sur internet (Tailscale Funnel)

```bash
make funnel-start   # équivaut à : tailscale funnel --bg --https=443 3900
make funnel-status  # tailscale funnel status
make funnel-stop    # tailscale funnel --https=443 off
```

Ceci expose le port local `3900` sur un port public autorisé de l'URL Funnel de la machine
(`https://<machine>.<tailnet>.ts.net:<port>`). Funnel n'écoute publiquement que sur les
ports **443, 8443 ou 10000** : ne jamais tenter d'exposer directement le port 3900. Le
port par défaut du `Makefile` est `443` (port HTTPS standard, franchit les
firewalls/proxys restrictifs qui bloquent les ports non standards) ; adapter
`--https=<port>` dans le `Makefile` si besoin.

### Désactiver temporairement l'exposition ou la connectivité Tailscale

- Couper uniquement le Funnel (le service reste joignable en local et sur le tailnet) :
  `make funnel-stop`.
- Déconnecter complètement la machine du tailnet, temporairement (reconnexion instantanée
  avec `sudo tailscale up`) : `sudo tailscale down`. Le Funnel devient alors inaccessible
  tant que la machine est déconnectée, et devra être relancé (`make funnel-start`) après
  reconnexion.

## Fichiers reçus

Les fichiers finalisés arrivent dans `~/sanem-data/uploads/` sur la machine hôte. Le
dossier `~/sanem-data/tmp/` contient les uploads en cours (protocole tus) ; il doit rester
vide en dehors des transferts actifs.

## Dépannage

- **La page boucle sur l'écran de connexion derrière Funnel** : vérifier que le conteneur
  tourne bien et que `docker compose logs sanem` ne montre pas d'erreur de configuration.
- **Upload qui ne reprend pas après coupure** : vérifier que le navigateur utilisé est
  identique (l'URL d'upload tus est stockée côté client) et que l'upload n'a pas dépassé
  `SANEM_TMP_TTL_HOURS`.
- **Fichiers appartenant à `root` dans `~/sanem-data`** : ne jamais lancer le conteneur
  sans l'option `user: "1000:1000"` du `docker-compose.yml`.
- **`docker compose up` échoue au démarrage** : `SANEM_PASSWORD` ou `SANEM_SESSION_SECRET`
  absent ou trop court — voir le message d'erreur explicite dans les logs.

## Développement

```bash
npm install
make test    # ou : npm test — tests unitaires + test d'intégration de reprise
make lint    # ou : npm run lint
```

Voir `AGENTS.md` pour le contexte destiné aux agents de code, et `PRD.md` pour la
spécification complète.
