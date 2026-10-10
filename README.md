# Stock Fleurs

Suivi de stock de fleurs coupées (en tiges), avec sorties dans l'ordre d'arrivée (FIFO).
Saisie pensée pour le téléphone, consultation sur ordinateur.

## Utiliser sur votre ordinateur

Prérequis : Node.js 22.13 ou plus récent. Aucune dépendance à installer.

```
npm start
```

Le terminal affiche `http://localhost:3000` (ordinateur) et une adresse en `192.168.x.x` (téléphone sur le même Wi-Fi).
Sans variable `ACCESS_PASSWORD`, l'accès est libre : à réserver à un réseau de confiance.

Les données sont dans `data/stock.db`. Le bouton « Télécharger une sauvegarde » (Réglages) en donne une copie.

## Mettre en ligne (Fly.io)

Une fois en ligne, l'application est joignable de partout, avec HTTPS et un mot de passe. La base reste sur un
volume persistant. Fly.io est payant (de l'ordre de quelques euros par mois pour cette taille d'application) ;
consultez leur grille de prix avant de commencer.

1. Créez un compte sur https://fly.io et installez l'outil `flyctl` (https://fly.io/docs/flyctl/install/).
2. Dans ce dossier :

   ```
   fly auth login
   fly launch --no-deploy --copy-config --name <un-nom-unique>
   fly volumes create stock_data --region cdg --size 1
   fly secrets set ACCESS_PASSWORD="<un mot de passe long>"
   fly deploy
   ```

   `fly launch` reprend `fly.toml` ; le nom de l'application doit être unique chez Fly.
3. Ouvrez `https://<un-nom-unique>.fly.dev` sur le téléphone, connectez-vous, puis « Ajouter à l'écran d'accueil ».

Points à connaître :
- Gardez **une seule machine** : la base SQLite vit sur un seul volume (`fly scale count 1`).
- La machine s'endort sans visite et se réveille en quelques secondes à l'ouverture suivante (`auto_stop_machines`).
  Pour qu'elle reste toujours active, mettez `min_machines_running = 1` dans `fly.toml`.
- Fly prend un instantané quotidien du volume (`fly volumes snapshots list`). Téléchargez en plus une sauvegarde
  de temps en temps depuis les Réglages.
- Changer le mot de passe : `fly secrets set ACCESS_PASSWORD="…"`. Tous les appareils sont alors déconnectés.
- En ligne (`NODE_ENV=production`), le serveur refuse de démarrer sans `ACCESS_PASSWORD`.
- Après 5 mots de passe faux, l'adresse IP est bloquée 15 minutes.
- Autre hébergeur : le `Dockerfile` convient à tout service qui accepte un conteneur et offre un disque persistant
  monté sur `/data` (Railway, Render avec disque, un petit serveur VPS…).

Récupérer la base de Fly sur votre ordinateur : bouton de sauvegarde dans les Réglages, puis copier le fichier
dans `data/stock.db` (serveur arrêté).

## Version de démonstration (GitHub Pages)

`npm run build:demo` génère le dossier `docs/` : la même application, mais sans serveur ni mot de passe.
Les données restent dans le navigateur de chaque visiteur (`localStorage`) et ne sont envoyées nulle part.
Le faux serveur est dans `demo/api-local.js` ; ses tests le comparent au vrai serveur.
Après chaque modification de l'application, relancez `npm run build:demo` avant de publier.

Publication : sur GitHub, Settings > Pages > Source « Deploy from a branch », branche `main`, dossier `/docs`.

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `ACCESS_PASSWORD` | Mot de passe d'accès (obligatoire en production) | aucun |
| `PORT` | Port d'écoute | 3000 |
| `DB_PATH` | Chemin de la base SQLite | `data/stock.db` |
| `TRUST_PROXY` | `1` derrière un proxy HTTPS (Fly) : cookie sécurisé et vraie IP du client | désactivé |
| `NODE_ENV` | `production` impose le mot de passe | — |

## Commandes

- `npm test` : tests du FIFO, des annulations, des réglages et de l'authentification.
- `npm run demo` : crée `data/demo.db` avec des données d'exemple, à lancer avec
  `$env:DB_PATH="data/demo.db"; npm start` (PowerShell).

## Réglages dans l'application

Page « Réglages » : seuils de fraîcheur par défaut, nom et seuils propres à chaque variété, archivage
(possible quand le stock est à zéro), suppression (seulement si la variété n'a jamais servi), sauvegarde, déconnexion.
Les motifs de sortie se modifient dans `REASONS` (`public/app.js` et `store.js`).
