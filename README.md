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

docker compose up --build -d
```

Le service écoute en local sur le port `3900` (configurable via `SANEM_PORT`).

## Configuration (`.env`)

| Variable               | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `SANEM_PASSWORD`       | Mot de passe partagé (≥ 5 caractères), obligatoire.             |
| `SANEM_SESSION_SECRET` | Secret de signature des cookies (≥ 32 caractères), obligatoire. |
| `SANEM_PORT`           | Port local d'écoute. Défaut : `3900`.                           |
| `SANEM_TMP_TTL_HOURS`  | Délai avant qu'un upload inachevé soit nettoyé. Défaut : `48`.  |
| `SANEM_MAX_FILE_GB`    | Taille maximale par fichier. Défaut : `20`.                     |

## Exposition sur internet (Tailscale Funnel)

```bash
tailscale funnel 3900
```

Ceci expose le port local `3900` sur le port public **443** de l'URL Funnel de la machine
(`https://<machine>.<tailnet>.ts.net`). Funnel n'écoute publiquement que sur les ports
443, 8443 ou 10000 : ne jamais tenter d'exposer directement le port 3900.

Pour lancer en arrière-plan et vérifier l'état :

```bash
tailscale funnel --bg 3900
tailscale funnel status
```

> Si le port public 443 est déjà utilisé par un autre service Funnel sur cette machine,
> utiliser un autre port public autorisé, par exemple :
> `tailscale funnel --bg --https=10000 3900`.

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
npm test    # tests unitaires + test d'intégration de reprise
npm run lint
```

Voir `AGENTS.md` pour le contexte destiné aux agents de code, et `PRD.md` pour la
spécification complète.
