# Mongo Manager

[![CI](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mongo-manager/app?logo=npm)](https://www.npmjs.com/package/@mongo-manager/app) [![Licence : CC BY-NC-SA 4.0](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](README.md) · [Türkçe](README.tr.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português (Brasil)](README.pt.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · **Français** · [Русский](README.ru.md)

**Un gestionnaire MongoDB sécurisé qui s’exécute dans votre navigateur, sur un serveur que vous hébergez.** Utilisez-le seul ou en équipe, confiez le travail à un agent IA avec vos propres mots, et gardez tout entièrement hors ligne.

<p align="center">
  <img src="docs/media/demo.gif" alt="Mongo Manager en action : un filtre, une agrégation construite étape par étape, le schéma, un plan de requête, les performances en direct et le thème sombre" width="880">
</p>
<p align="center"><a href="docs/media/demo.mp4">Voir la démo en pleine qualité (MP4, 55 s)</a></p>

<p align="center">Réalisé par <b>Gokhan OZGEZER</b> · <a href="mailto:gokhanozgezer@gmail.com">gokhanozgezer@gmail.com</a> · <a href="https://github.com/gokhanozgezer">GitHub</a></p>

## Sommaire

- [Pourquoi Mongo Manager](#pourquoi-mongo-manager)
- [Démarrage rapide](#démarrage-rapide)
- [Points forts](#points-forts)
  - [Agent IA](#agent-ia)
  - [Jeux de réplicas](#jeux-de-réplicas)
  - [Clusters partitionnés](#clusters-partitionnés)
  - [Équipes, sécurité et audit](#équipes-sécurité-et-audit)
  - [Sauvegardes, copies et synchronisation en continu](#sauvegardes-copies-et-synchronisation-en-continu)
  - [Masquer les données personnelles](#masquer-les-données-personnelles)
- [Toutes les fonctionnalités](#toutes-les-fonctionnalités)
- [Une visite rapide](#une-visite-rapide)
- [Captures d’écran](#captures-décran)
- [Installation](#installation)
- [Utilisation](#utilisation)
- [Sécurité](#sécurité)
- [Développement](#développement)
- [Licence](#licence)
- [Auteur](#auteur)

## Pourquoi Mongo Manager

MongoDB Compass est une application de bureau pour une seule personne. Mongo Manager s’exécute une fois sur un serveur, toute l’équipe l’utilise depuis un navigateur, et il fait ce que Compass ne fait pas :

|                                   | Mongo Manager                                                                                  | MongoDB Compass                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Où il s’exécute                   | Dans le navigateur ; sur votre propre ordinateur ou votre propre serveur                       | Une application de bureau                                               |
| Équipes                           | Utilisateurs, rôles, accès par connexion, connexion à deux facteurs, journal d’audit           | Un seul utilisateur                                                     |
| IA                                | Votre propre fournisseur (Ollama compris) ; un agent qui ne change rien sans votre confirmation | Génération de requêtes par le service de MongoDB, avec une connexion Atlas |
| Sauvegardes                       | Planifiées et chiffrées ; vers S3, Google Drive, WebDAV ou un dossier du serveur               | Aucune                                                                  |
| Synchronisation en continu        | Copie une collection ou une base de données en continu, la vérifie, se termine par une bascule | Aucune                                                                  |
| Masquage des données personnelles | Par des règles ; sur chaque écran, dans les exports, les sauvegardes et l’IA                   | Aucun                                                                   |
| Alertes                           | Dans l’application, par e-mail et par webhook                                                  | Aucune                                                                  |
| SQL ↔ MongoDB                     | Importe les dumps mysqldump, pg_dump et sqlite3 ; exporte les collections en SQL               | Aucun                                                                   |
| Langues de l’interface            | 10 langues                                                                                     | Anglais                                                                 |

<sub>Compass tel que le décrit la documentation de MongoDB en octobre 2026.</sub>

## Démarrage rapide

Il ne lui faut que Node.js 24 ou une version ultérieure :

```sh
npx @mongo-manager/app
```

Votre navigateur s’ouvre tout seul (`http://127.0.0.1:4321`). Pour une équipe, lancez-le avec `--auth` ; le premier démarrage affiche un jeton de configuration à usage unique. Docker, le binaire autonome et le service système : voir [Installation](#installation).

## Points forts

### Agent IA

Dites ce que vous voulez avec vos mots ; l’agent travaille avec vos connexions par leur nom.

- **Des réponses tirées de vos données :** il écrit et exécute la requête ou le pipeline nécessaire, et montre chaque étape qu’il a suivie.
- **Rien ne change sans votre accord :** une collection, des documents, un index, une sauvegarde, une restauration, une planification, un utilisateur MongoDB ou l’arrêt d’une opération ; chaque modification attend votre confirmation sur une carte. Refusez, et rien n’est écrit.
- **Vous choisissez le fournisseur :** Anthropic, Google Gemini, tout serveur compatible OpenAI, ou Ollama sur votre propre réseau.
- **Vos règles :** les données personnelles lui restent masquées ; chaque connexion a sa propre politique d’IA et ses limites de débit ; chaque requête est conservée dans l’historique avec ses jetons et son coût.

<p align="center"><img src="docs/media/clips/ai.gif" alt="L’agent IA : une réponse tirée des données et un index en attente de confirmation" width="720"></p>

### Jeux de réplicas

- **Les membres en direct :** le nœud principal, les secondaires, les membres hors service et le retard de réplication, avec sept jours d’historique.
- **Des alertes sur le retard :** quand le retard de réplication dépasse un seuil, dans l’application, par e-mail ou par webhook.
- **Suivre les modifications en direct :** le flux de modifications d’une collection, d’une base de données ou d’une connexion entière, avec filtres, pause, et les valeurs précédant une modification lorsque le serveur les conserve.
- **Synchronisation en continu :** une copie continue d’un jeu de réplicas vers une autre connexion, vérifiée, qui se termine par une bascule.
- **Dans la vue d’ensemble :** l’état du jeu de réplicas dans un widget dédié.

### Clusters partitionnés

Connectez-vous à un mongos et gérez le partitionnement depuis l’application :

- **D’un coup d’œil :** les shards, l’état de l’équilibreur et la répartition des chunks de chaque collection entre les shards.
- **Partitionner une collection :** la clé de partition choisie est d’abord vérifiée, avec des suggestions. Le plug-in Shard Key Analyzer l’examine plus en détail.
- **Zones :** ajoutez des shards à des zones ou retirez-les, et définissez des plages de clés.
- **Équilibreur :** activez-le ou désactivez-le, et fixez ses heures de fonctionnement.
- **Le plan de requête** montre le plan de chaque shard ; les flux de modifications et la synchronisation en continu fonctionnent aussi sur les clusters partitionnés.

### Équipes, sécurité et audit

- **Mode équipe (`--auth`) :** rôles administrateur, éditeur et lecteur, et accès par connexion.
- **Connexion à deux facteurs :** applications d’authentification, clés d’accès et codes de récupération ; exigée d’une personne, des administrateurs ou de tout le monde.
- **Accès au panneau :** faites répondre le panneau à certaines adresses seulement, depuis l’application ; les adresses qui échouent sans cesse à se connecter sont bloquées.
- **Journal d’audit :** en ajout seul et chaîné par hachage ; exporté en CSV ou NDJSON.
- **Secrets chiffrés :** les mots de passe et les clés des connexions sont chiffrés sur le disque ; le shell s’exécute dans un processus isolé qui ne détient aucun identifiant.

### Sauvegardes, copies et synchronisation en continu

- **Sauvegardes :** archives mongodump ou fichiers `.mmbak` chiffrés (AES-256-GCM) ; planifiées, avec rétention, envoyées vers un dossier du serveur, un stockage compatible S3, Google Drive ou WebDAV.
- **Restaurations :** d’abord un plan et une simulation, puis votre confirmation.
- **Copier et comparer :** une collection, les résultats d’une requête ou une base de données, vers la même connexion ou une autre, puis comparés.
- **Synchronisation en continu :** copie les modifications en permanence, les vérifie et se termine par une bascule.

### Masquer les données personnelles

Des règles qui masquent les champs personnels aux personnes qui n’ont pas le droit de les voir : dans les documents, les requêtes, les agrégations, les exports, les copies, les sauvegardes, les flux de modifications, les synchronisations en continu et l’assistant IA. Les règles s’appliquent sur le serveur ; une telle personne n’accède jamais au shell.

## Toutes les fonctionnalités

Cliquez sur un titre pour en afficher le détail.

<details>
<summary><b>Parcourir et modifier</b></summary>

- Bases de données, collections et vues ; collections plafonnées, de séries chronologiques et en cluster (avec une collation par défaut et des préimages/postimages de flux de modifications).
- Documents en tableau, en cartes (avec une arborescence dépliable) ou en JSON ; insertion, clonage, modifications en place qui n’écrivent que ce qui a changé, et actions sur une sélection.
- Compartiments GridFS : liste, aperçu, envoi, téléchargement, métadonnées et suppression.

</details>

<details>
<summary><b>Requêtes, pipelines et shell</b></summary>

- Un filtre avec complétion des champs et un générateur visuel ; projection, tri, skip, limite, collation, hint et délai maximal.
- La mise à jour et la suppression en masse indiquent combien de documents correspondent et en montrent quelques-uns avant et après, sans rien écrire ; elles demandent le nom de la collection lorsque tous les documents seraient concernés.
- Un générateur d’agrégations : cartes d’étapes ou mode texte, aperçu en direct de chaque étape sur un échantillon, `$out`/`$merge` uniquement après confirmation.
- Export en code : Node.js, Python, Java, Go, C#, PHP, Ruby et Rust.
- La page Requêtes (Ctrl+Maj+L) : favoris, pipelines enregistrés, extraits de code du shell et historique ; partageables en mode équipe.
- Un shell avancé : mongosh pour chaque onglet, dans un processus isolé qui ne détient aucun identifiant ; les limites de lecture seule sont appliquées côté serveur, et chaque commande figure dans le journal d’audit.

</details>

<details>
<summary><b>Index, schéma et plans de requête</b></summary>

- Tous les types d’index (simple, composé, multiclé, texte, 2d, 2dsphere, haché, générique) et toutes les options (unique, sparse, partiel, TTL, collation, masqué), avec l’utilisation via `$indexStats`.
- Index Atlas Search et Vector Search (Atlas, ou MongoDB 8.0+ avec mongot).
- « Pourquoi est-ce lent ? » : le plan de requête sous forme d’arbre avec des avertissements, et l’index qui aiderait, prérempli.
- Analyse du schéma : types de champs, fréquence de chacun, histogrammes et valeurs les plus fréquentes ; un clic ajoute un filtre, et les lieux s’affichent sur une carte hors ligne.
- Le schéma exporté en Mongoose, JSON Schema, TypeScript, Pydantic, Go ou C# ; des règles de validation générées à partir d’un échantillon et testées sur les documents existants.

</details>

<details>
<summary><b>Performances, alertes et vue d’ensemble</b></summary>

- Graphiques en direct des opérations, des connexions, du réseau et de la mémoire par connexion, avec sept jours d’historique.
- Les opérations en cours les plus lentes (les administrateurs de connexion peuvent les interrompre), les collections les plus sollicitées, le profileur, les requêtes lentes et des conseils d’index.
- Alertes : seuils pour les connexions, les opérations, le retard de réplication, le cache WiredTiger, le disque et les opérations lentes ; événements pour les sauvegardes et les tâches en échec et pour les synchronisations en continu arrêtées. Report, acquittement et historique.
- La vue d’ensemble : un tableau de bord que chaque utilisateur organise à sa façon.

</details>

<details>
<summary><b>Import et export</b></summary>

- CSV, TSV, JSON, NDJSON (Extended JSON) et Excel (.xlsx), y compris compressés en gzip ; mappage des champs, types, insertion, upsert ou fusion, simulation et fichier des enregistrements refusés.
- SQL ↔ MongoDB : les dumps mysqldump, pg_dump et sqlite3 importés dans des collections ; les collections exportées vers PostgreSQL, MySQL ou SQLite.

</details>

<details>
<summary><b>Connexions et chiffrement</b></summary>

- TLS, tunnels SSH avec épinglage de la clé d’hôte, SCRAM, X.509, LDAP (PLAIN), AWS IAM, MONGODB-OIDC et Kerberos.
- Connexions en lecture seule, groupes et couleurs ; import et export protégés par un mot de passe.
- Chiffrement côté client : CSFLE et Queryable Encryption avec des clés locales, AWS, Azure, Google Cloud et KMIP (dans le paquet npm).

</details>

<details>
<summary><b>Plug-ins</b></summary>

- Onglets, actions sur les documents, rendus de cellules et pages isolés ; chacun s’active après une analyse de sécurité et l’approbation d’un administrateur.
- Fournis : une carte GeoJSON, des graphiques, un dictionnaire de données, un détecteur de doublons, les différences entre documents, la santé du schéma, SQL vers MongoDB, le Shard Key Analyzer et d’autres encore.
- Les autres s’installent depuis un fichier ou, sur un serveur qui l’autorise, depuis un dépôt GitHub.

</details>

<details>
<summary><b>Partout</b></summary>

- Dix langues : anglais, turc, chinois, japonais, espagnol, portugais, coréen, allemand, français et russe.
- Thèmes clair et sombre, couleurs d’accent, une palette de commandes (Ctrl+K), des raccourcis clavier (?) et la documentation intégrée à l’application.
- Tâches en arrière-plan avec progression en direct ; installable comme application (PWA) dans sa propre fenêtre.

</details>

## Une visite rapide

### Trouver et filtrer

Saisissez un filtre avec complétion des champs ou cliquez sur une valeur pour l’ajouter ; les résultats s’affichent page par page en tableau, en cartes ou en JSON.

<p align="center"><img src="docs/media/clips/query.gif" alt="Trouver et filtrer" width="720"></p>

### Construire un pipeline étape par étape

Chaque étape montre sa sortie sur un échantillon pendant la saisie ; exécutez-le, enregistrez-le ou exportez-le en code.

<p align="center"><img src="docs/media/clips/aggregation.gif" alt="Construire un pipeline étape par étape" width="720"></p>

### Connaître la forme de vos données

Une analyse par échantillon de chaque champ : ses types, sa fréquence et ses valeurs.

<p align="center"><img src="docs/media/clips/schema.gif" alt="Connaître la forme de vos données" width="720"></p>

### Voir pourquoi une requête est lente

Le plan de la requête sous forme d’arbre, avec l’étape qui a lu toute la collection et l’index qui aiderait.

<p align="center"><img src="docs/media/clips/explain.gif" alt="Voir pourquoi une requête est lente" width="720"></p>

### Tout à portée de clavier

La palette de commandes (Ctrl+K) trouve n’importe quelle commande, collection ou réglage.

<p align="center"><img src="docs/media/clips/palette.gif" alt="Tout à portée de clavier" width="720"></p>

### Suivre le serveur en direct

Opérations, connexions, réseau et mémoire, en direct et sur sept jours, avec des alertes.

<p align="center"><img src="docs/media/clips/performance.gif" alt="Suivre le serveur en direct" width="720"></p>

## Captures d’écran

Les images suivent votre thème GitHub : clair ou sombre.

<table>
  <tr>
    <td colspan="2"><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/ai-agent-dark.png"><img src="site/assets/screens/ai-agent-light.png" alt="L’agent IA : une réponse tirée des données et un index en attente de confirmation"></picture><br><sub>L’agent IA : une réponse tirée des données et un index en attente de confirmation</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/documents-dark.png"><img src="site/assets/screens/documents-light.png" alt="Les documents dans un tableau, avec un filtre et des suggestions en un clic"></picture><br><sub>Les documents dans un tableau, avec un filtre et des suggestions en un clic</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/aggregation-dark.png"><img src="site/assets/screens/aggregation-light.png" alt="Un pipeline d’agrégation, chaque étape prévisualisée"></picture><br><sub>Un pipeline d’agrégation, chaque étape prévisualisée</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/schema-dark.png"><img src="site/assets/screens/schema-light.png" alt="Le schéma d’une collection échantillonnée"></picture><br><sub>Le schéma d’une collection échantillonnée</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/explain-dark.png"><img src="site/assets/screens/explain-light.png" alt="Pourquoi est-ce lent ? Le plan de la requête"></picture><br><sub>Pourquoi est-ce lent ? Le plan de la requête</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/performance-dark.png"><img src="site/assets/screens/performance-light.png" alt="Les performances du serveur en direct"></picture><br><sub>Les performances du serveur en direct</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/palette-dark.png"><img src="site/assets/screens/palette-light.png" alt="La palette de commandes (Ctrl+K)"></picture><br><sub>La palette de commandes (Ctrl+K)</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/plugins-dark.png"><img src="site/assets/screens/plugins-light.png" alt="Des plug-ins, chacun approuvé par un administrateur"></picture><br><sub>Des plug-ins, chacun approuvé par un administrateur</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/security-dark.png"><img src="site/assets/screens/security-light.png" alt="Mode équipe : règles de double authentification, sessions, accès au panneau et blocages de connexion"></picture><br><sub>Mode équipe : règles de double authentification, sessions, accès au panneau et blocages de connexion</sub></td>
  </tr>
</table>

## Installation

Choisissez une méthode. Chaque version livre tous ses fichiers avec des sommes de contrôle SHA-256 (`SHA256SUMS`) ; toutes les méthodes fonctionnent aussi sur une machine sans accès à Internet.

| Méthode                 | Commande                                                                                              | Prérequis                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------- |
| npm                     | `npx @mongo-manager/app`, ou `npm install --global @mongo-manager/app`                                          | Node.js 24+                 |
| npm, hors ligne         | `npm install --global ./mongo-manager-<version>.tgz`                                                  | Node.js 24+                 |
| Binaire autonome        | téléchargez `mongo-manager-<version>-<os>-<arch>`, puis exécutez-le                                   | rien                        |
| Docker                  | `docker run -d -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/mongo-manager/mongo-manager:<version>` | Docker                      |
| Docker, hors ligne      | `docker load -i mongo-manager-<version>-<arch>.tar`, puis exécutez `mongo-manager:<version>`          | Docker                      |
| Docker, depuis un clone | `docker compose -f deploy/docker-compose.yml up -d` (construit l’image à partir des sources)          | Docker                      |
| Service système         | `sudo mongo-manager service install` (Windows : depuis une invite de commandes élevée)                | le paquet npm ou le binaire |

- **Les binaires autonomes** (Linux x64/arm64, Windows x64, macOS arm64) embarquent leur propre runtime et l’application web. Ils ne sont pas signés ; sous macOS, autorisez le binaire dans _Réglages Système → Confidentialité et sécurité_ ou exécutez `xattr -d com.apple.quarantine ./mongo-manager-*`.
- **Kerberos et le chiffrement côté client** ne fonctionnent qu’avec le paquet npm (installez `kerberos` et `mongodb-client-encryption` à côté).
- **MongoDB pris en charge :** 6.0 et versions ultérieures ; serveurs autonomes, jeux de réplicas, clusters partitionnés (via mongos) et Atlas. Le suivi des modifications et la synchronisation en continu nécessitent un jeu de réplicas ou un cluster partitionné. Les serveurs plus anciens sont refusés avec un message qui l’indique.
- **Tests :** les tests du serveur s’exécutent sur de vrais serveurs et jeux de réplicas 6.0, 7.0, 8.0 et 8.3. Les clusters partitionnés sont testés avec des réponses mongos enregistrées, et Atlas via ses chaînes de connexion ; aucun des deux sur un déploiement réel.
- Services, Docker, proxys inverses et sauvegardes : [deploy/README.md](deploy/README.md).

**Docker**

- L’image s’exécute en mode équipe et écoute sur toutes les adresses dans le conteneur. Ouvrez `http://127.0.0.1:4321` et saisissez le jeton de configuration à usage unique que donne `docker exec <name> cat /data/setup-token` ; terminez la configuration sans attendre.
- Derrière un proxy inverse avec un nom de domaine, réglez `MM_ALLOWED_HOSTS` sur ce nom (sans quoi il répond `403 Host not allowed`) et `MM_TRUSTED_PROXIES` sur la passerelle du réseau Docker, en général `172.17.0.1` : voir [deploy/README.md](deploy/README.md#docker).
- Dans le conteneur, `localhost` désigne le conteneur lui-même : pour joindre un MongoDB situé sur l’hôte ou dans un autre conteneur, voir [Joindre MongoDB depuis le conteneur](deploy/README.md#reaching-your-mongodb-from-the-container).

## Utilisation

```sh
mongo-manager                 # local mode on http://127.0.0.1:4321, opens your browser
mongo-manager open            # a new one-time link that opens a running local-mode Mongo Manager
mongo-manager --auth          # team mode; the first start prints a one-time setup token
mongo-manager --help          # every command and option
mongo-manager doctor          # check the installation and the data directory
```

Chaque option du serveur a aussi une variable d’environnement `MM_*`, par exemple `MM_WEB_PORT`, `MM_AUTH=1` ou `MM_DATA_DIR`. Les autres commandes gèrent les utilisateurs, les clés, les sauvegardes et le service système ; `mongo-manager --help` les liste toutes.

## Sécurité

<details>
<summary><b>Comment Mongo Manager se protège</b></summary>

- **Adresse d’écoute :** cet ordinateur seulement (boucle locale) par défaut. Mongo Manager refuse une adresse réseau, ou un proxy inverse placé devant, sans `--auth` (sauf s’il est lancé avec l’option dangereuse `--unsafe-no-auth`). Sans `--allowed-hosts`, une adresse réseau ne répond qu’aux adresses IP et à `localhost` (contre le DNS rebinding).
- **Mode local :** ne s’ouvre qu’à partir d’un lien à usage unique ; `mongo-manager open` en crée un nouveau. Chaque navigateur détient ensuite un cookie HttpOnly qui lui est propre et une clé de page ; `mongo-manager forget-browsers` les déconnecte tous.
- **Secrets enregistrés :** les mots de passe et les clés des connexions sont chiffrés avec `secret.key` (ou `MM_SECRET_KEY`). Sauvegardez la clé avec le répertoire de données, mais conservez les deux séparément ; `mongo-manager rotate-key` remplace la clé.
- **Protection web :** une Content-Security-Policy stricte, des jetons CSRF et des vérifications de l’origine, une connexion limitée en débit, des sessions qui se terminent après une période d’inactivité et au bout de 12 heures ; les modifications sensibles redemandent votre mot de passe ou votre second facteur.
- **Autorisations :** chaque contrôle de lecture seule et de rôle s’exécute sur le serveur, jamais uniquement dans le navigateur.

</details>

Si vous découvrez une vulnérabilité, n’ouvrez pas de ticket public ; signalez-la en privé : [SECURITY.md](SECURITY.md).

## Développement

```sh
pnpm install
pnpm dev:web                  # the web app with hot reload; /api goes to a server on port 4321
                              # (local mode: open its launch link with port 5173 in place of 4321)
pnpm lint && pnpm typecheck && pnpm test
pnpm build                    # web app, plugins and the bundled CLI in packages/cli
pnpm test:e2e                 # Playwright against the installed Chrome
pnpm --filter @mongo-manager/e2e e2e:rs  # after pnpm build: Watch and Live sync on the memory
                              # server's replica set, failing without one (as CI runs them);
                              # MM_E2E_PORT=45000 picks another port for the test server
pnpm --filter @mongo-manager/app test:sea   # build and run the standalone binary
node packages/server/scripts/capture-explain.mjs --version 7.0.43   # explain fixtures of a release;
                              # --sharded --bin <folder with mongod and mongos> for a sharded cluster
```

| Paquet             | Rôle                                                           |
| ------------------ | -------------------------------------------------------------- |
| `packages/shared`  | Types, schémas, l’analyseur de requêtes sûr, EJSON             |
| `packages/server`  | API Fastify, authentification, magasin SQLite, accès à MongoDB |
| `packages/web`     | Application web Vue 3                                          |
| `packages/cli`     | La commande `mongo-manager`, installateur du service           |
| `packages/plugins` | Plug-ins fournis et kit de plug-ins                            |
| `packages/e2e`     | Tests de bout en bout                                          |

### Forks : activer les mises à jour

Les installations ne se mettent à jour que vers des versions signées avec la clé du code (`RELEASE_PUBLIC_KEYS` dans `packages/shared/src/updates/source.ts`). Un fork qui n’y change rien suit les versions officielles. Pour publier des mises à jour de votre propre fork :

1. Créez votre propre paire de clés : `node scripts/release-key.mjs ~/mm-release-signing.key`. Elle écrit la clé privée dans ce fichier (lisible par vous seul) et affiche la clé publique. Gardez le fichier hors du dépôt.
2. Dans `packages/shared/src/updates/source.ts`, donnez à `RELEASE_REPO`, `RELEASE_IMAGE` et `RELEASE_NPM_PACKAGE` votre dépôt, votre image et votre paquet, et remplacez `RELEASE_PUBLIC_KEYS` par votre clé publique.
3. Dans votre dépôt GitHub, créez l’environnement `signing` (avec vous comme relecteur obligatoire, et ses déploiements limités aux étiquettes correspondant à `v*`) et ajoutez le contenu du fichier de la clé privée comme son secret `MM_RELEASE_SIGNING_KEY`. Gardez ensuite le fichier hors ligne ou supprimez-le ; ne le committez jamais.
4. Chaque version signe son `SHA256SUMS` dès que vous approuvez la tâche `signing`. Une clé qui ne correspond pas à `RELEASE_PUBLIC_KEYS` arrête la version avant que quoi que ce soit ne soit publié.

Pour laisser les mises à jour hors de votre fork, videz `RELEASE_PUBLIC_KEYS` (l’application les masque alors, comme avec `MM_UPDATES=off`) et retirez la tâche `signing` et son nom des `needs` de `ghcr` et `npm` dans `.github/workflows/release.yml`.

## Licence

Mongo Manager est distribué sous la [licence Creative Commons Attribution - Pas d’Utilisation Commerciale - Partage dans les Mêmes Conditions 4.0 International (CC BY-NC-SA 4.0)](LICENSE) :

- **Attribution :** créditez Gokhan OZGEZER lorsque vous l’utilisez ou le partagez.
- **Pas d’Utilisation Commerciale :** ne l’utilisez pas à des fins commerciales.
- **Partage dans les Mêmes Conditions :** partagez ce que vous modifiez ou construisez à partir de lui sous la même licence.

Les composants tiers intégrés conservent leurs propres licences ; chaque version les liste dans `THIRD-PARTY-NOTICES.txt`. Questions sur un usage commercial : [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com).

## Auteur

**Gokhan OZGEZER**

- E-mail : [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com)
- GitHub : [@gokhanozgezer](https://github.com/gokhanozgezer)
- Projet : [github.com/mongo-manager/mongo-manager](https://github.com/mongo-manager/mongo-manager)
- Bogues et idées : [Issues](https://github.com/mongo-manager/mongo-manager/issues)
